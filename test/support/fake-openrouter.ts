import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** How the fake answers one request (default: a valid answer). */
export interface ScriptedAnswer {
  /** usage.cost in US dollars (omitted: no cost reported). */
  cost?: number;
  /** Return malformed structured output (still billed). */
  invalidJson?: boolean;
  /** Answer with this HTTP status and no usage (not billed). */
  httpStatus?: number;
}

export interface ReceivedRequest {
  schemaName: string;
  model: unknown;
  usage: unknown;
  generationId?: string;
}

/** Valid structured output for each MuseCue schema. */
const ANSWERS: Record<string, unknown> = {
  musecue_personalization: {
    analysis: {
      faceShape: 'oval',
      skinTone: 'medium',
      undertone: 'warm',
      notableFeatures: ['high cheekbones'],
      confidence: 0.9,
    },
    recommendations: [
      {
        name: 'Soft Glow',
        tagline: 'Dewy and fresh',
        matchScore: 92,
        palette: ['#f1c27d', '#e0ac69'],
        rationale: 'Warm tones suit the undertone.',
      },
      {
        name: 'Evening Bronze',
        tagline: 'Warm and defined',
        matchScore: 85,
        palette: ['#c68642', '#8d5524'],
        rationale: 'Bronze deepens the warm undertone.',
      },
    ],
  },
  musecue_guide: {
    steps: ['Prep', 'Base', 'Cheeks'].map((title) => ({
      title,
      instruction: `${title} instruction`,
      substeps: [`${title} one`, `${title} two`],
      spokenIntro: `Let's do ${title}`,
      spokenSubsteps: [`${title} first`, `${title} second`],
      area: 'face',
      technique: 'blend',
      estimatedSeconds: 60,
      personalizedTip: 'Go light.',
      commonMistake: 'Too much product.',
      successCriteria: 'Even finish.',
    })),
  },
  musecue_makeup_check: {
    result: 'PASS',
    feedback: 'Looks even.',
    spokenFeedback: 'Looks great.',
    confidence: 0.9,
  },
  musecue_guide_question: { answer: 'Use a light hand.' },
};

/**
 * A local stand-in for the OpenRouter chat completions API: answers
 * structured-output requests for the MuseCue schemas with OpenRouter's
 * response envelope and usage accounting (token counts, `usage.cost` in USD,
 * a unique generation ID). Costs and failures can be scripted per request;
 * every request is recorded.
 */
export class FakeOpenRouter {
  readonly received: ReceivedRequest[] = [];
  /** Default cost of a request without a scripted answer. */
  defaultCost = 0.025;
  private readonly scripted: ScriptedAnswer[] = [];
  private server?: Server;
  private generation = 0;

  /** Answers for the next requests, in order. */
  script(...answers: ScriptedAnswer[]): void {
    this.scripted.push(...answers);
  }

  reset(): void {
    this.scripted.length = 0;
    this.received.length = 0;
    this.defaultCost = 0.025;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(({ status, body }) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) =>
      this.server?.listen(0, '127.0.0.1', resolve),
    );
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/api/v1`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private async handle(
    req: IncomingMessage,
  ): Promise<{ status: number; body: unknown }> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      model?: unknown;
      usage?: unknown;
      response_format?: { json_schema?: { name?: string } };
    };
    const schemaName = request.response_format?.json_schema?.name ?? '';
    const answer = this.scripted.shift() ?? { cost: this.defaultCost };
    const received: ReceivedRequest = {
      schemaName,
      model: request.model,
      usage: request.usage,
    };
    this.received.push(received);
    if (answer.httpStatus) {
      return {
        status: answer.httpStatus,
        body: { error: { code: answer.httpStatus } },
      };
    }

    this.generation += 1;
    received.generationId = `gen-${this.generation}`;
    const content = answer.invalidJson
      ? 'not json'
      : JSON.stringify(ANSWERS[schemaName] ?? {});
    return {
      status: 200,
      body: {
        id: received.generationId,
        model: 'openai/gpt-4.1-mini',
        choices: [{ finish_reason: 'stop', message: { content } }],
        usage: {
          prompt_tokens: 1000 + this.generation,
          completion_tokens: 200,
          total_tokens: 1200 + this.generation,
          ...(answer.cost !== undefined ? { cost: answer.cost } : {}),
        },
      },
    };
  }
}
