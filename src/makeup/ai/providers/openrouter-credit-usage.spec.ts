import { ConfigService } from '@nestjs/config';
import { AiProviderError } from '../ai-provider.error';
import { OpenRouterProvider } from './openrouter.provider';
import type { StructuredGenerationRequest } from './structured-ai.provider';

const request: StructuredGenerationRequest = {
  operation: 'GUIDE_QUESTION',
  schemaName: 'musecue_guide_question',
  schema: { type: 'object' },
  systemInstruction: 'system',
  taskInstruction: 'task',
  userContext: { question: 'private question' },
};

const provider = () =>
  new OpenRouterProvider(
    new ConfigService({ OPENROUTER_API_KEY: 'sk-or-v1-test-key' }),
  );

const respond = (body: unknown) =>
  jest.spyOn(global, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

/**
 * OpenRouter usage accounting: the cost (usage.cost, in US dollars) and
 * token counts of every answered request, for credit charging.
 */
describe('OpenRouterProvider usage for credits', () => {
  afterEach(() => jest.restoreAllMocks());

  it('asks OpenRouter for usage accounting and returns the cost and tokens', async () => {
    const fetchSpy = respond({
      id: 'gen-123',
      model: 'openai/gpt-4.1-mini',
      choices: [{ message: { content: '{"answer":"Blend upwards."}' } }],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 300,
        total_tokens: 1500,
        cost: 0.0123456789,
      },
    });

    await expect(provider().generateStructured(request)).resolves.toEqual({
      value: { answer: 'Blend upwards.' },
      responseId: 'gen-123',
      model: 'openai/gpt-4.1-mini',
      usage: {
        promptTokens: 1200,
        completionTokens: 300,
        totalTokens: 1500,
        costUsd: 0.0123456789,
      },
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as {
      usage: unknown;
    };
    expect(body.usage).toEqual({ include: true });
  });

  it('reports no cost when OpenRouter returns none or an invalid one', async () => {
    respond({
      id: 'gen-124',
      choices: [{ message: { content: '{"answer":"ok"}' } }],
      usage: { total_tokens: 10, cost: -1 },
    });

    const result = await provider().generateStructured(request);

    expect(result.usage).toEqual({
      promptTokens: undefined,
      completionTokens: undefined,
      totalTokens: 10,
      costUsd: undefined,
    });
  });

  it.each([
    [
      'truncated output',
      { finish_reason: 'length', message: { content: '{"ans' } },
      'AI_OUTPUT_TRUNCATED',
    ],
    [
      'invalid JSON',
      { finish_reason: 'stop', message: { content: 'not json' } },
      'AI_INVALID_JSON',
    ],
    [
      'an empty answer',
      { finish_reason: 'stop', message: { content: '' } },
      'AI_EMPTY_RESPONSE',
    ],
  ])(
    'keeps the usage of a billed request rejected for %s, without exposing it when serialized',
    async (_case, choice, code) => {
      respond({
        id: 'gen-125',
        model: 'openai/gpt-4.1-mini',
        choices: [choice],
        usage: { total_tokens: 900, cost: 0.004 },
      });

      const failure = await provider()
        .generateStructured(request)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AiProviderError);
      const error = failure as AiProviderError;
      expect(error.code).toBe(code);
      expect(error.billedResponse).toEqual({
        responseId: 'gen-125',
        model: 'openai/gpt-4.1-mini',
        usage: {
          promptTokens: undefined,
          completionTokens: undefined,
          totalTokens: 900,
          costUsd: 0.004,
        },
      });
      expect(JSON.stringify(error)).not.toContain('gen-125');
    },
  );

  it('has no billed usage when the request never got an answer', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('busy', { status: 503 }));

    const failure = (await provider()
      .generateStructured(request)
      .catch((error: unknown) => error)) as AiProviderError;

    expect(failure.code).toBe('AI_HTTP_503');
    expect(failure.billedResponse).toBeUndefined();
  });
});
