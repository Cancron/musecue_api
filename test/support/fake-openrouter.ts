import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local stand-in for OpenRouter's chat completions endpoint, for tests of
 * the live AI gateway without network access. It answers the application's
 * structured-output requests with schema-valid content for each operation
 * (selected by the request's `response_format.json_schema.name`) and with
 * the usage OpenRouter reports: tokens and `cost` in USD, plus a unique
 * generation ID. Responses can be planned to fail like OpenRouter does.
 */

export type FakeOutcome =
  /** A valid structured response (billed). */
  | 'ok'
  /** 200 with unparsable structured output (billed, then rejected). */
  | 'invalid-json'
  /** 200 cut off at the token limit (billed, then rejected). */
  | 'truncated'
  /** 502 without a generation (not billed; retried). */
  | 'http-502'
  /** 400 without a generation (not billed; the run fails at once). */
  | 'http-400';

export interface FakePlan {
  outcome?: FakeOutcome;
  cost?: number | null;
  promptTokens?: number;
  completionTokens?: number;
  delayMs?: number;
}

export interface FakeRequest {
  schemaName: string;
  model: string;
  usage: unknown;
  authorization: string | undefined;
}

const guideStep = (n: number) => ({
  spokenIntro: `Step ${n}.`,
  spokenSubsteps: ['Press gently.', 'Blend outward.'],
  title: `Step ${n}`,
  instruction: 'Apply a thin layer and blend.',
  substeps: ['Press gently.', 'Blend outward.'],
  area: 'complexion',
  technique: 'press and blend',
  estimatedSeconds: 90,
  personalizedTip: 'Keep it light.',
  commonMistake: 'Using too much.',
  successCriteria: 'Even and soft.',
});

/** Schema-valid structured output for each operation. */
const CONTENT: Record<string, unknown> = {
  musecue_personalization: {
    analysis: {
      faceShape: 'oval',
      skinTone: 'medium',
      undertone: 'neutral',
      notableFeatures: ['defined brows'],
      confidence: 0.9,
    },
    recommendations: [
      {
        name: 'Soft Glow',
        tagline: 'Fresh and natural',
        matchScore: 93,
        palette: ['peach', 'champagne'],
        rationale: 'Matches the natural vibe.',
      },
      {
        name: 'Polished Day',
        tagline: 'Defined but soft',
        matchScore: 85,
        palette: ['taupe', 'rose'],
        rationale: 'Fits the available time.',
      },
    ],
  },
  musecue_guide: { steps: [guideStep(1), guideStep(2), guideStep(3)] },
  musecue_makeup_check: {
    result: 'PASS',
    feedback: 'Nicely blended.',
    spokenFeedback: 'That looks nicely blended.',
    confidence: 0.8,
  },
  musecue_guide_question: { answer: 'Use one light tap of blush.' },
};

export const DEFAULT_COSTS: Record<string, number> = {
  musecue_personalization: 0.025,
  musecue_guide: 0.0117,
  musecue_makeup_check: 0.000123,
  musecue_guide_question: 0.0045,
};

export const MODEL = 'openai/gpt-4.1-mini';

export class FakeOpenRouter {
  readonly requests: FakeRequest[] = [];
  /** Unexpected handler errors, without request content or credentials. */
  readonly handlerErrors: string[] = [];
  /** Planned responses, per schema name, used in order. */
  private readonly plans = new Map<string, FakePlan[]>();
  /** Cost of unplanned responses, per schema name. */
  readonly costs: Record<string, number> = { ...DEFAULT_COSTS };
  private server?: Server;
  private generation = 0;

  /** The base URL to configure as OPENROUTER_BASE_URL. */
  url = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req)
        .then(({ status, body }) => {
          if (res.destroyed) return;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        })
        .catch((error: unknown) => {
          const name = error instanceof Error ? error.name : typeof error;
          const code =
            typeof error === 'object' && error !== null && 'code' in error
              ? String(error.code)
              : 'unknown';
          this.handlerErrors.push(`${name}:${code}`);
          if (res.destroyed) return;
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
          }
          res.end(
            JSON.stringify({ error: { message: 'Fake provider failed' } }),
          );
        });
    });
    await new Promise<void>((resolve) =>
      this.server?.listen(0, '127.0.0.1', resolve),
    );
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}/api/v1`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** Plans the next responses for an operation's schema. */
  plan(schemaName: string, ...plans: FakePlan[]): void {
    this.plans.set(schemaName, [
      ...(this.plans.get(schemaName) ?? []),
      ...plans,
    ]);
  }

  /** Drops planned responses that were not used. */
  clearPlans(): void {
    this.plans.clear();
  }

  count(schemaName?: string): number {
    return schemaName
      ? this.requests.filter((r) => r.schemaName === schemaName).length
      : this.requests.length;
  }

  private async handle(
    req: IncomingMessage,
  ): Promise<{ status: number; body: unknown }> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      model?: string;
      models?: string[];
      usage?: unknown;
      response_format?: { json_schema?: { name?: string } };
    };
    const schemaName = body.response_format?.json_schema?.name ?? 'unknown';
    this.requests.push({
      schemaName,
      model: body.model ?? body.models?.[0] ?? 'unknown',
      usage: body.usage,
      authorization: req.headers.authorization,
    });
    const plan = this.plans.get(schemaName)?.shift() ?? {};
    if (plan.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, plan.delayMs));
    }
    const outcome = plan.outcome ?? 'ok';
    if (outcome === 'http-502') {
      return { status: 502, body: { error: { message: 'Bad gateway' } } };
    }
    if (outcome === 'http-400') {
      return { status: 400, body: { error: { message: 'Bad request' } } };
    }
    this.generation += 1;
    const promptTokens = plan.promptTokens ?? 1000;
    const completionTokens = plan.completionTokens ?? 250;
    const cost = plan.cost === undefined ? this.costs[schemaName] : plan.cost;
    const content =
      outcome === 'invalid-json'
        ? '{"not valid json'
        : outcome === 'truncated'
          ? '{"steps": ['
          : JSON.stringify(CONTENT[schemaName]);
    return {
      status: 200,
      body: {
        id: `gen-${Date.now()}-${this.generation}`,
        model: MODEL,
        choices: [
          {
            finish_reason: outcome === 'truncated' ? 'length' : 'stop',
            message: { content },
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
          ...(cost === null || cost === undefined ? {} : { cost }),
        },
      },
    };
  }
}
