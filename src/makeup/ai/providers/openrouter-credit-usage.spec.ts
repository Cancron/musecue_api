import { ConfigService } from '@nestjs/config';
import { mock } from 'jest-mock-extended';
import { AiProviderError } from '../ai-provider.error';
import { LiveAiGateway } from '../live-ai.gateway';
import { OpenRouterProvider } from './openrouter.provider';
import type {
  StructuredAiProvider,
  StructuredGenerationRequest,
} from './structured-ai.provider';

const request: StructuredGenerationRequest = {
  operation: 'GUIDE_QUESTION',
  schemaName: 'test_schema',
  schema: { type: 'object' },
  systemInstruction: 'system',
  taskInstruction: 'task',
  userContext: { step: 1 },
};

const provider = () =>
  new OpenRouterProvider(
    new ConfigService({ OPENROUTER_API_KEY: 'sk-or-v1-test-key' }),
  );

const respond = (body: unknown, status = 200) =>
  jest.spyOn(global, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

const completion = (
  usage: Record<string, unknown> | undefined,
  content = '{"answer":"Blend upward."}',
  extra: Record<string, unknown> = {},
) => ({
  id: 'gen-123',
  model: 'openai/gpt-4.1-mini',
  choices: [{ finish_reason: 'stop', message: { content } }],
  ...(usage ? { usage } : {}),
  ...extra,
});

describe('OpenRouter usage tracking', () => {
  afterEach(() => jest.restoreAllMocks());

  it('asks OpenRouter for usage accounting and returns tokens, cost in USD and the generation', async () => {
    const fetchSpy = respond(
      completion({
        prompt_tokens: 1200,
        completion_tokens: 340,
        total_tokens: 1540,
        cost: 0.023,
      }),
    );

    await expect(provider().generateStructured(request)).resolves.toMatchObject(
      {
        value: { answer: 'Blend upward.' },
        responseId: 'gen-123',
        model: 'openai/gpt-4.1-mini',
        usage: {
          promptTokens: 1200,
          completionTokens: 340,
          totalTokens: 1540,
          costUsd: '0.023',
        },
      },
    );
    const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string) as {
      usage: unknown;
    };
    expect(body.usage).toEqual({ include: true });
  });

  it.each([
    [1.2e-7, '0.00000012'],
    [0.0000123456789, '0.0000123456789'],
    [0, '0'],
    [12.5, '12.5'],
  ])(
    'keeps cost %p exact as %s (never via float arithmetic)',
    async (cost, text) => {
      respond(completion({ total_tokens: 1, cost }));
      const result = await provider().generateStructured(request);
      expect(result.usage?.costUsd).toBe(text);
    },
  );

  it('reports no cost when OpenRouter reports none', async () => {
    respond(
      completion({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }),
    );
    const result = await provider().generateStructured(request);
    expect(result.usage).toEqual({
      promptTokens: 5,
      completionTokens: 2,
      totalTokens: 7,
      costUsd: undefined,
    });
  });

  it.each([
    [
      'malformed structured output',
      completion({ total_tokens: 90, cost: 0.0041 }, '{not json'),
    ],
    [
      'an output-token cutoff',
      {
        ...completion({ total_tokens: 90, cost: 0.0041 }),
        choices: [{ finish_reason: 'length', message: { content: '{"a' } }],
      },
    ],
    ['empty output', completion({ total_tokens: 90, cost: 0.0041 }, '  ')],
  ])(
    'attaches the billed usage to a failure after OpenRouter produced a response (%s)',
    async (_case, body) => {
      respond(body);
      const error = await provider()
        .generateStructured(request)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AiProviderError);
      expect((error as AiProviderError).billedResponse).toEqual({
        responseId: 'gen-123',
        model: 'openai/gpt-4.1-mini',
        usage: {
          promptTokens: undefined,
          completionTokens: undefined,
          totalTokens: 90,
          costUsd: '0.0041',
        },
      });
    },
  );

  it('has no billed usage for a request OpenRouter rejected (no generation)', async () => {
    respond({ error: { message: 'rate limited' } }, 429);
    const error = await provider()
      .generateStructured(request)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'AI_HTTP_429' });
    expect((error as AiProviderError).billedResponse).toBeUndefined();
  });

  describe('LiveAiGateway', () => {
    const structured = mock<StructuredAiProvider>({ name: 'openrouter' });
    const gateway = new LiveAiGateway(structured);
    const input = {
      question: 'How much blush?',
      step: {
        position: 0,
        title: 'Blush',
        instruction: 'Apply blush.',
        substeps: ['Smile.', 'Tap.'],
        area: 'cheeks',
        technique: 'tap',
        estimatedSeconds: 60,
        personalizedTip: 'Light.',
        commonMistake: 'Too much.',
        successCriteria: 'Soft flush.',
      },
      recommendation: { name: 'Natural', tagline: 'Soft' },
      preferences: { vibe: 'natural', desiredEffect: null },
    };
    const usage = { totalTokens: 40, costUsd: '0.0007' };

    it('passes the usage and cost of a valid response on', async () => {
      structured.generateStructured.mockResolvedValue({
        value: { answer: 'A little.' },
        responseId: 'gen-9',
        model: 'm',
        usage,
      });
      await expect(gateway.answerQuestion(input)).resolves.toEqual({
        data: { answer: 'A little.' },
        metadata: { responseId: 'gen-9', model: 'm', usage },
      });
    });

    it('attaches the usage when the billed response fails application validation', async () => {
      structured.generateStructured.mockResolvedValue({
        value: { answer: '' },
        responseId: 'gen-10',
        model: 'm',
        usage,
      });
      const error = await gateway
        .answerQuestion(input)
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'AI_SCHEMA_VALIDATION_FAILED' });
      expect((error as AiProviderError).billedResponse).toEqual({
        responseId: 'gen-10',
        model: 'm',
        usage,
      });
    });
  });
});
