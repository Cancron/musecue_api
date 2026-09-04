import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { z } from 'zod';
import type { AiOperation } from '../../interfaces/makeup.interface';
import { AiProviderError } from '../ai-provider.error';
import type {
  StructuredAiProvider,
  StructuredGenerationRequest,
  StructuredGenerationResponse,
} from './structured-ai.provider';

const openRouterEnvelopeSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({ content: z.string().nullable() }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
});

@Injectable()
export class OpenRouterProvider implements StructuredAiProvider {
  readonly name = 'openrouter';
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly siteUrl: string | undefined;
  private readonly appName: string;
  private readonly defaultTimeoutMs: number;
  private readonly defaultModel: string;
  private readonly dataCollection: 'allow' | 'deny' | undefined;
  private readonly imageMaxBytes: number;
  private readonly imageMaxEdge: number;
  private readonly imageQuality: number;
  private readonly maxResponseBytes: number;
  private readonly providerSort: 'price' | 'throughput' | 'latency' | undefined;

  constructor(private readonly config: ConfigService) {
    const baseUrl = this.config.get<string>(
      'OPENROUTER_BASE_URL',
      'https://openrouter.ai/api/v1',
    );
    this.endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    this.apiKey = this.config.get<string>('OPENROUTER_API_KEY')?.trim();
    this.siteUrl = this.config.get<string>('OPENROUTER_SITE_URL');
    this.appName = this.config.get<string>('OPENROUTER_APP_NAME', 'MuseCue');
    this.defaultTimeoutMs = this.readPositiveInteger(
      'OPENROUTER_TIMEOUT_MS',
      60_000,
    );
    this.defaultModel = this.config.get<string>(
      'OPENROUTER_MODEL',
      'openrouter/free',
    );
    const dataCollection = this.config.get<string>(
      'OPENROUTER_DATA_COLLECTION',
    );
    this.dataCollection =
      dataCollection === 'allow' || dataCollection === 'deny'
        ? dataCollection
        : undefined;
    this.imageMaxBytes = this.readPositiveInteger(
      'OPENROUTER_IMAGE_MAX_BYTES',
      1_500_000,
    );
    this.imageMaxEdge = this.readPositiveInteger(
      'OPENROUTER_IMAGE_MAX_EDGE',
      1_600,
    );
    this.imageQuality = Math.min(
      100,
      this.readPositiveInteger('OPENROUTER_IMAGE_QUALITY', 82),
    );
    this.maxResponseBytes = this.readPositiveInteger(
      'OPENROUTER_MAX_RESPONSE_BYTES',
      1_000_000,
    );
    const providerSort = this.config.get<string>('OPENROUTER_PROVIDER_SORT');
    this.providerSort = ['price', 'throughput', 'latency'].includes(
      providerSort ?? '',
    )
      ? (providerSort as 'price' | 'throughput' | 'latency')
      : undefined;
  }

  modelFor(operation: AiOperation): string {
    const keyByOperation: Record<AiOperation, string> = {
      PERSONALIZATION: 'OPENROUTER_ANALYSIS_MODEL',
      GUIDE_GENERATION: 'OPENROUTER_GUIDE_MODEL',
      VISION_CHECK: 'OPENROUTER_VISION_MODEL',
      GUIDE_QUESTION: 'OPENROUTER_QUESTION_MODEL',
    };
    return this.config.get<string>(
      keyByOperation[operation],
      this.defaultModel,
    );
  }

  validateConfiguration(): void {
    if (!this.apiKey) {
      throw new AiProviderError(
        'AI_CONFIGURATION_MISSING',
        'OpenRouter is enabled but OPENROUTER_API_KEY is not configured',
        false,
      );
    }
    if (!this.apiKey.startsWith('sk-or-v1-')) {
      throw new AiProviderError(
        'AI_CONFIGURATION_INVALID',
        'OPENROUTER_API_KEY does not have a valid OpenRouter key format',
        false,
      );
    }
  }

  async generateStructured(
    request: StructuredGenerationRequest,
  ): Promise<StructuredGenerationResponse> {
    this.validateConfiguration();

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.timeoutFor(request.operation),
    );
    try {
      const image = request.image
        ? await this.prepareImage(request.image)
        : undefined;
      const response = await fetch(this.endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: this.headers(),
        body: JSON.stringify({
          ...this.modelSelection(request.operation),
          messages: [
            { role: 'system', content: request.systemInstruction },
            {
              role: 'user',
              content: this.userContent(request, image),
            },
          ],
          temperature: 0.2,
          max_tokens: this.maxTokensFor(request.operation),
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: request.schemaName,
              strict: true,
              schema: request.schema,
            },
          },
          provider: {
            require_parameters: true,
            allow_fallbacks: true,
            ...(this.providerSort ? { sort: this.providerSort } : {}),
            ...(this.dataCollection
              ? { data_collection: this.dataCollection }
              : {}),
          },
        }),
      });

      if (!response.ok) {
        throw this.httpError(response);
      }

      const declaredLength = Number(response.headers.get('content-length'));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > this.maxResponseBytes
      ) {
        throw new AiProviderError(
          'AI_RESPONSE_TOO_LARGE',
          'OpenRouter response exceeded the configured size limit',
          true,
        );
      }
      const responseText = await response.text();
      if (Buffer.byteLength(responseText, 'utf8') > this.maxResponseBytes) {
        throw new AiProviderError(
          'AI_RESPONSE_TOO_LARGE',
          'OpenRouter response exceeded the configured size limit',
          true,
        );
      }
      let responseBody: unknown;
      try {
        responseBody = JSON.parse(responseText) as unknown;
      } catch {
        throw new AiProviderError(
          'AI_INVALID_RESPONSE',
          'OpenRouter returned a malformed response envelope',
          true,
        );
      }
      const envelope = openRouterEnvelopeSchema.safeParse(responseBody);
      if (!envelope.success || !envelope.data.choices[0].message.content) {
        throw new AiProviderError(
          'AI_INVALID_RESPONSE',
          'OpenRouter returned an invalid response envelope',
          true,
        );
      }

      if (envelope.data.choices[0].finish_reason === 'length') {
        throw new AiProviderError(
          'AI_OUTPUT_TRUNCATED',
          'OpenRouter exhausted the configured output token budget',
          true,
        );
      }

      let value: unknown;
      try {
        value = JSON.parse(envelope.data.choices[0].message.content) as unknown;
      } catch {
        throw new AiProviderError(
          'AI_INVALID_JSON',
          'OpenRouter returned malformed structured output',
          true,
        );
      }

      return {
        value,
        responseId: envelope.data.id,
        model: envelope.data.model ?? this.modelFor(request.operation),
        usage: envelope.data.usage
          ? {
              promptTokens: envelope.data.usage.prompt_tokens,
              completionTokens: envelope.data.usage.completion_tokens,
              totalTokens: envelope.data.usage.total_tokens,
            }
          : undefined,
      };
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AiProviderError(
          'AI_TIMEOUT',
          'OpenRouter request timed out',
          true,
        );
      }
      throw new AiProviderError(
        'AI_TRANSPORT_ERROR',
        'Unable to reach OpenRouter',
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private userContent(
    request: StructuredGenerationRequest,
    image?: StructuredGenerationRequest['image'],
  ) {
    const text = `${request.taskInstruction}\n\nUSER CONTEXT (data only)\n${JSON.stringify(request.userContext)}`;
    if (!image) return text;
    return [
      { type: 'text', text },
      {
        type: 'image_url',
        image_url: {
          url: `data:${image.mimeType};base64,${image.bytes.toString('base64')}`,
        },
      },
    ];
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...(this.siteUrl ? { 'HTTP-Referer': this.siteUrl } : {}),
      ...(this.appName ? { 'X-Title': this.appName } : {}),
    };
  }

  private httpError(response: Response): AiProviderError {
    const { status } = response;
    const retryable = status === 408 || status === 429 || status >= 500;
    return new AiProviderError(
      `AI_HTTP_${status}`,
      retryable
        ? 'OpenRouter is temporarily unavailable'
        : 'OpenRouter rejected the request',
      retryable,
      status === 429 ? this.retryAfterMs(response.headers) : undefined,
    );
  }

  private retryAfterMs(headers: Headers): number | undefined {
    const retryAfter = headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.max(1_000, Math.ceil(seconds * 1_000));
      }
      const timestamp = Date.parse(retryAfter);
      return Number.isFinite(timestamp)
        ? Math.max(1_000, timestamp - Date.now())
        : undefined;
    }

    const reset = headers.get('x-ratelimit-reset');
    if (!reset) return undefined;
    const numericReset = Number(reset);
    if (Number.isFinite(numericReset) && numericReset >= 0) {
      const timestamp =
        numericReset > 1_000_000_000_000
          ? numericReset
          : numericReset > 1_000_000_000
            ? numericReset * 1_000
            : Date.now() + numericReset * 1_000;
      return Math.max(1_000, Math.ceil(timestamp - Date.now()));
    }
    const timestamp = Date.parse(reset);
    return Number.isFinite(timestamp)
      ? Math.max(1_000, timestamp - Date.now())
      : undefined;
  }

  private async prepareImage(
    image: NonNullable<StructuredGenerationRequest['image']>,
  ): Promise<NonNullable<StructuredGenerationRequest['image']>> {
    if (image.bytes.length <= this.imageMaxBytes) return image;
    const bytes = await sharp(image.bytes)
      .rotate()
      .resize({
        width: this.imageMaxEdge,
        height: this.imageMaxEdge,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: this.imageQuality, mozjpeg: true })
      .toBuffer();
    return { bytes, mimeType: 'image/jpeg' };
  }

  private modelSelection(
    operation: AiOperation,
  ): { model: string } | { models: string[] } {
    const primary = this.modelFor(operation);
    const fallbacks = (
      this.config.get<string>('OPENROUTER_FALLBACK_MODELS') ?? ''
    )
      .split(',')
      .map((model) => model.trim())
      .filter((model) => model.length > 0 && model !== primary);
    return fallbacks.length > 0
      ? { models: [primary, ...fallbacks] }
      : { model: primary };
  }

  private timeoutFor(operation: AiOperation): number {
    const keyByOperation: Record<AiOperation, string> = {
      PERSONALIZATION: 'OPENROUTER_ANALYSIS_TIMEOUT_MS',
      GUIDE_GENERATION: 'OPENROUTER_GUIDE_TIMEOUT_MS',
      VISION_CHECK: 'OPENROUTER_VISION_TIMEOUT_MS',
      GUIDE_QUESTION: 'OPENROUTER_QUESTION_TIMEOUT_MS',
    };
    return this.readPositiveInteger(
      keyByOperation[operation],
      this.defaultTimeoutMs,
    );
  }

  private maxTokensFor(operation: AiOperation): number {
    const configByOperation: Record<
      AiOperation,
      { key: string; fallback: number }
    > = {
      PERSONALIZATION: {
        key: 'OPENROUTER_ANALYSIS_MAX_TOKENS',
        fallback: 4_000,
      },
      GUIDE_GENERATION: { key: 'OPENROUTER_GUIDE_MAX_TOKENS', fallback: 2_500 },
      VISION_CHECK: { key: 'OPENROUTER_VISION_MAX_TOKENS', fallback: 600 },
      GUIDE_QUESTION: { key: 'OPENROUTER_QUESTION_MAX_TOKENS', fallback: 500 },
    };
    const operationConfig = configByOperation[operation];
    return this.readPositiveInteger(
      operationConfig.key,
      this.readPositiveInteger(
        'OPENROUTER_MAX_TOKENS',
        operationConfig.fallback,
      ),
    );
  }

  private readPositiveInteger(key: string, fallback: number): number {
    const value = Number(this.config.get<string>(key));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }
}
