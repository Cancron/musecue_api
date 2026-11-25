import type {
  AiOperation,
  EvaluationAiInput,
  EvaluationResult,
  GuideAiInput,
  GuideResult,
  PersonalizationAiInput,
  PersonalizationResult,
  QuestionAiInput,
  QuestionResult,
} from '../interfaces/makeup.interface';

export const AI_GATEWAY = Symbol('AI_GATEWAY');

export interface AiRunDescriptor {
  provider: string;
  model: string;
  promptVersion: string;
  /**
   * Whether the provider bills requests: its usage is recorded and charged
   * in credits (false for the deterministic mock gateway).
   */
  billable: boolean;
}

/** Usage reported by the provider for one request. */
export interface AiUsageReport {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** The provider's cost in US dollars (OpenRouter `usage.cost`). */
  costUsd?: number;
}

export interface AiCallMetadata {
  /** The provider's request ID (OpenRouter generation ID). */
  responseId?: string;
  model?: string;
  usage?: AiUsageReport;
}

export interface AiGatewayResponse<T> {
  data: T;
  metadata?: AiCallMetadata;
}

export interface AiGateway {
  describe(operation: AiOperation): AiRunDescriptor;
  personalize(
    input: PersonalizationAiInput,
  ): Promise<AiGatewayResponse<PersonalizationResult>>;
  generateGuide(input: GuideAiInput): Promise<AiGatewayResponse<GuideResult>>;
  evaluateStep(
    input: EvaluationAiInput,
  ): Promise<AiGatewayResponse<EvaluationResult>>;
  answerQuestion(
    input: QuestionAiInput,
  ): Promise<AiGatewayResponse<QuestionResult>>;
}
