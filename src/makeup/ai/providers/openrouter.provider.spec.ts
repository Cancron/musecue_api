import { ConfigService } from '@nestjs/config';
import { OpenRouterProvider } from './openrouter.provider';
import type { StructuredGenerationRequest } from './structured-ai.provider';

const guideRequest: StructuredGenerationRequest = {
  operation: 'GUIDE_GENERATION',
  schemaName: 'test_schema',
  schema: { type: 'object' },
  systemInstruction: 'private system instruction',
  taskInstruction: 'private task',
  userContext: { notes: 'private notes' },
};

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

  it('terminates output-token cutoffs without wasting identical retries', async () => {
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
      retryable: false,
    });
  });

  it.each([null, '', undefined])(
    'detects reasoning-only truncation with content %s',
    async (content) => {
      jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'length',
                message: { content, reasoning: 'private reasoning' },
              },
            ],
            usage: {
              completion_tokens: 8000,
              completion_tokens_details: { reasoning_tokens: 8000 },
            },
          }),
        ),
      );
      const provider = new OpenRouterProvider(
        new ConfigService({ OPENROUTER_API_KEY: 'sk-or-v1-test-key' }),
      );
      await expect(
        provider.generateStructured(guideRequest),
      ).rejects.toMatchObject({
        code: 'AI_OUTPUT_TRUNCATED',
        retryable: false,
        diagnostics: {
          httpStatus: 200,
          finishReason: 'length',
          completionTokens: 8000,
          reasoningTokens: 8000,
          contentCharacters: 0,
          maxTokens: 8000,
        },
      });
    },
  );

  it.each([
    [
      { error: { code: 429, message: 'private provider text' } },
      'AI_HTTP_429',
      true,
    ],
    [
      { error: { code: 400, message: 'private provider text' } },
      'AI_HTTP_400',
      false,
    ],
    [
      { error: { code: 502, message: 'private provider text' } },
      'AI_HTTP_502',
      true,
    ],
    [
      { error: { message: 'private provider text' } },
      'AI_PROVIDER_ERROR',
      true,
    ],
    [
      {
        choices: [
          {
            finish_reason: 'error',
            error: { code: 503 },
            message: { content: '{}' },
          },
        ],
      },
      'AI_HTTP_503',
      true,
    ],
    [{ choices: [{ finish_reason: 'error' }] }, 'AI_PROVIDER_ERROR', true],
    [
      { choices: [{ finish_reason: 'content_filter' }] },
      'AI_CONTENT_FILTERED',
      false,
    ],
    [{ choices: [{ finish_reason: 'length' }] }, 'AI_OUTPUT_TRUNCATED', false],
    [
      { choices: [{ finish_reason: 'stop', message: { content: '   ' } }] },
      'AI_EMPTY_RESPONSE',
      true,
    ],
    [{ choices: [] }, 'AI_INVALID_RESPONSE', true],
  ])('classifies HTTP 200 envelope %j', async (body, code, retryable) => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify(body), { headers: { 'retry-after': '2' } }),
      );
    const provider = new OpenRouterProvider(
      new ConfigService({ OPENROUTER_API_KEY: 'sk-or-v1-test-key' }),
    );
    await expect(
      provider.generateStructured(guideRequest),
    ).rejects.toMatchObject({
      code,
      retryable,
      ...(code === 'AI_HTTP_429' ? { retryAfterMs: 2000 } : {}),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('retains only allowlisted failure metadata', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'private-id',
          model: 'private-model',
          error: {
            code: 502,
            message: 'private notes and credentials',
            metadata: { raw: 'private' },
          },
          choices: [
            {
              finish_reason: 'private reason',
              message: { content: 'private', reasoning: 'private' },
            },
          ],
        }),
      ),
    );
    const provider = new OpenRouterProvider(
      new ConfigService({ OPENROUTER_API_KEY: 'sk-or-v1-test-key' }),
    );
    const failure: unknown = await provider
      .generateStructured(guideRequest)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      diagnostics: {
        providerErrorCode: 502,
        finishReason: 'other',
        contentCharacters: 7,
      },
    });
    expect(JSON.stringify(failure)).not.toContain('private');
    expect(JSON.stringify(failure)).not.toContain('sk-or');
  });

  it('does not let malformed usage metadata hide a token cutoff', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'length', message: null }],
          usage: {
            completion_tokens: null,
            completion_tokens_details: { reasoning_tokens: 'invalid' },
          },
        }),
      ),
    );
    const provider = new OpenRouterProvider(
      new ConfigService({ OPENROUTER_API_KEY: 'sk-or-v1-test-key' }),
    );
    await expect(
      provider.generateStructured(guideRequest),
    ).rejects.toMatchObject({
      code: 'AI_OUTPUT_TRUNCATED',
      retryable: false,
      diagnostics: { finishReason: 'length' },
    });
  });

  it.each([
    [{}, 8000, undefined],
    [{ OPENROUTER_MAX_TOKENS: '3500' }, 3500, undefined],
    [
      {
        OPENROUTER_MAX_TOKENS: '3500',
        OPENROUTER_GUIDE_MAX_TOKENS: '9000',
        OPENROUTER_GUIDE_REASONING_EFFORT: 'low',
      },
      9000,
      { effort: 'low', exclude: true },
    ],
  ])(
    'preserves budget precedence and opt-in reasoning: %j',
    async (config, maxTokens, reasoning) => {
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockImplementation(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({ choices: [{ message: { content: '{}' } }] }),
            ),
          ),
        );
      const provider = new OpenRouterProvider(
        new ConfigService({
          OPENROUTER_API_KEY: 'sk-or-v1-test-key',
          ...config,
        }),
      );
      await provider.generateStructured(guideRequest);
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as {
        max_tokens: number;
        reasoning?: unknown;
      };
      expect(body.max_tokens).toBe(maxTokens);
      expect(body.reasoning).toEqual(reasoning);
      await provider.generateStructured({
        ...guideRequest,
        operation: 'VISION_CHECK',
      });
      expect(
        JSON.parse(fetchSpy.mock.calls[1][1]?.body as string),
      ).not.toHaveProperty('reasoning');
    },
  );

  it('rejects invalid reasoning configuration without sending a request', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const provider = new OpenRouterProvider(
      new ConfigService({
        OPENROUTER_API_KEY: 'sk-or-v1-test-key',
        OPENROUTER_GUIDE_REASONING_EFFORT: 'invalid',
      }),
    );
    await expect(
      provider.generateStructured(guideRequest),
    ).rejects.toMatchObject({
      code: 'AI_CONFIGURATION_INVALID',
      retryable: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
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
