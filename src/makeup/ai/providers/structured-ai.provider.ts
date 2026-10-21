import type {
  AiImageInput,
  AiOperation,
} from '../../interfaces/makeup.interface';

export const STRUCTURED_AI_PROVIDER = Symbol('STRUCTURED_AI_PROVIDER');

export interface StructuredGenerationRequest {
  operation: AiOperation;
  schemaName: string;
  schema: unknown;
  systemInstruction: string;
  taskInstruction: string;
  userContext: unknown;
  image?: AiImageInput;
}

export interface StructuredGenerationResponse {
  value: unknown;
  responseId?: string;
  model: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface StructuredAiProvider {
  readonly name: string;
  validateConfiguration(): void;
  modelFor(operation: AiOperation): string;
  generateStructured(
    request: StructuredGenerationRequest,
  ): Promise<StructuredGenerationResponse>;
}
