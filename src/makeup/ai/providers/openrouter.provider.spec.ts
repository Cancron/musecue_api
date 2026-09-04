import { ConfigService } from '@nestjs/config';
import { OpenRouterProvider } from './openrouter.provider';

describe('OpenRouterProvider', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends private image bytes as a structured multimodal request', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'generation-id',
          model: 'free-vision-model',
          choices: [{ message: { content: '{"answer":"Use less."}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const provider = new OpenRouterProvider(
      new ConfigService({
        OPENROUTER_API_KEY: 'sk-or-v1-test-key',
        OPENROUTER_MODEL: 'openrouter/free',
        OPENROUTER_SITE_URL: 'https://musecue.example',
      }),
    );

    await expect(
      provider.generateStructured({
        operation: 'VISION_CHECK',
        schemaName: 'test_schema',
        schema: { type: 'object' },
        systemInstruction: 'system',
        taskInstruction: 'task',
        userContext: { step: 1 },
        image: { bytes: Buffer.from('photo'), mimeType: 'image/jpeg' },
      }),
    ).resolves.toMatchObject({
      value: { answer: 'Use less.' },
      responseId: 'generation-id',
      model: 'free-vision-model',
      usage: { totalTokens: 14 },
    });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer sk-or-v1-test-key',
      'HTTP-Referer': 'https://musecue.example',
      'X-Title': 'MuseCue',
    });
    expect(typeof init?.body).toBe('string');
    const body = JSON.parse(init?.body as string) as {
      model: string;
      messages: Array<{ content: unknown }>;
      response_format: { json_schema: { strict: boolean } };
      provider: { require_parameters: boolean };
    };
    expect(body.model).toBe('openrouter/free');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.provider.require_parameters).toBe(true);
    expect(JSON.stringify(body.messages[1].content)).toContain(
      'data:image/jpeg;base64,cGhvdG8=',
    );
  });

  it('fails without making a request when its secret is missing', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const provider = new OpenRouterProvider(new ConfigService({}));

    await expect(
      provider.generateStructured({
        operation: 'GUIDE_QUESTION',
        schemaName: 'test_schema',
        schema: { type: 'object' },
        systemInstruction: 'system',
        taskInstruction: 'task',
        userContext: {},
      }),
    ).rejects.toMatchObject({
      code: 'AI_CONFIGURATION_MISSING',
      retryable: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('classifies rate limiting as retryable without storing response bodies', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"error":{"message":"provider detail"}}', {
        status: 429,
        headers: { 'Retry-After': '2' },
      }),
    );
    const provider = new OpenRouterProvider(
      new ConfigService({ OPENROUTER_API_KEY: 'sk-or-v1-test-key' }),
    );

    await expect(
      provider.generateStructured({
        operation: 'GUIDE_QUESTION',
        schemaName: 'test_schema',
        schema: { type: 'object' },
        systemInstruction: 'system',
        taskInstruction: 'task',
        userContext: {},
      }),
    ).rejects.toMatchObject({
      code: 'AI_HTTP_429',
      retryable: true,
      retryAfterMs: 2_000,
    });
  });

  it('classifies an output-token cutoff as a retryable truncation', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'length',
              message: { content: '{"answer":"unfinished' },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const provider = new OpenRouterProvider(
      new ConfigService({ OPENROUTER_API_KEY: 'sk-or-v1-test-key' }),
    );

    await expect(
      provider.generateStructured({
        operation: 'GUIDE_QUESTION',
        schemaName: 'test_schema',
        schema: { type: 'object' },
        systemInstruction: 'system',
        taskInstruction: 'task',
        userContext: {},
      }),
    ).rejects.toMatchObject({
      code: 'AI_OUTPUT_TRUNCATED',
      retryable: true,
    });
  });

  it('supports model fallbacks and smaller operation-specific token budgets', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'fallback/model',
          choices: [{ message: { content: '{"answer":"Done"}' } }],
        }),
        { status: 200 },
      ),
    );
    const provider = new OpenRouterProvider(
      new ConfigService({
        OPENROUTER_API_KEY: 'sk-or-v1-test-key',
        OPENROUTER_MODEL: 'primary/model',
        OPENROUTER_FALLBACK_MODELS: 'fallback/model, second/model',
        OPENROUTER_QUESTION_MAX_TOKENS: '240',
        OPENROUTER_PROVIDER_SORT: 'throughput',
      }),
    );

    await provider.generateStructured({
      operation: 'GUIDE_QUESTION',
      schemaName: 'test_schema',
      schema: { type: 'object' },
      systemInstruction: 'system',
      taskInstruction: 'task',
      userContext: {},
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string) as {
      models: string[];
      max_tokens: number;
      provider: { sort: string };
    };
    expect(body.models).toEqual([
      'primary/model',
      'fallback/model',
      'second/model',
    ]);
    expect(body.max_tokens).toBe(240);
    expect(body.provider.sort).toBe('throughput');
  });
});
