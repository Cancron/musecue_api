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
}

export interface AiCallMetadata {
  responseId?: string;
  model?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
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
