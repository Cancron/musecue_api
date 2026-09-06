import { Inject, Injectable } from '@nestjs/common';
import { z, type ZodType } from 'zod';
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
import type {
  AiGateway,
  AiGatewayResponse,
  AiRunDescriptor,
} from './ai.gateway';
import { AiProviderError } from './ai-provider.error';
import {
  evaluationModelSchema,
  guideModelSchema,
  personalizationModelSchema,
  questionModelSchema,
} from './ai.schemas';
import {
  MAKEUP_AI_SYSTEM_INSTRUCTION,
  GUIDE_TASK,
  PERSONALIZATION_TASK,
  PROMPT_VERSIONS,
} from './ai.prompts';
import {
  STRUCTURED_AI_PROVIDER,
  type StructuredAiProvider,
} from './providers/structured-ai.provider';

const PREVIEW_IMAGES = [
  'https://images.pexels.com/photos/33334711/pexels-photo-33334711.jpeg?auto=compress&cs=tinysrgb&h=900&w=1200',
  'https://images.pexels.com/photos/6756279/pexels-photo-6756279.jpeg?auto=compress&cs=tinysrgb&h=900&w=1200',
  'https://images.pexels.com/photos/17200372/pexels-photo-17200372.jpeg?auto=compress&cs=tinysrgb&h=900&w=1200',
];

@Injectable()
export class LiveAiGateway implements AiGateway {
  constructor(
    @Inject(STRUCTURED_AI_PROVIDER)
    private readonly provider: StructuredAiProvider,
  ) {}

  validateConfiguration(): void {
    this.provider.validateConfiguration();
  }

  describe(operation: AiOperation): AiRunDescriptor {
    return {
      provider: this.provider.name,
      model: this.provider.modelFor(operation),
      promptVersion: PROMPT_VERSIONS[operation],
    };
  }

  async personalize(
    input: PersonalizationAiInput,
  ): Promise<AiGatewayResponse<PersonalizationResult>> {
    const response = await this.generate(
      'PERSONALIZATION',
      'musecue_personalization',
      personalizationModelSchema,
      PERSONALIZATION_TASK,
      input.preferences,
      input.image,
    );
    const names = new Set(
      response.data.recommendations.map((item) => item.name),
    );
    if (names.size !== response.data.recommendations.length) {
      throw new AiProviderError(
        'AI_DUPLICATE_RECOMMENDATIONS',
        'AI returned duplicate recommendations',
        true,
      );
    }
    const recommendations = [...response.data.recommendations]
      .sort((left, right) => right.matchScore - left.matchScore)
      .map((item, index) => ({
        ...item,
        rank: index + 1,
        imageUrl: PREVIEW_IMAGES[index],
      }));
    return {
      data: { analysis: response.data.analysis, recommendations },
      metadata: response.metadata,
    };
  }

  async generateGuide(
    input: GuideAiInput,
  ): Promise<AiGatewayResponse<GuideResult>> {
    const response = await this.generate(
      'GUIDE_GENERATION',
      'musecue_guide',
      guideModelSchema,
      GUIDE_TASK,
      input,
    );
    return {
      data: {
        steps: response.data.steps.map((step, position) => ({
          ...step,
          position,
        })),
      },
      metadata: response.metadata,
    };
  }

  evaluateStep(
    input: EvaluationAiInput,
  ): Promise<AiGatewayResponse<EvaluationResult>> {
    return this.generate(
      'VISION_CHECK',
      'musecue_makeup_check',
      evaluationModelSchema,
      `Evaluate only progress for the supplied current guide step. Do not restart facial analysis or change the selected makeup method.
Compare visible makeup with this step's success criteria. Use PASS, NEEDS_ADJUSTMENT, UNCERTAIN, or CANNOT_EVALUATE.
If adjustment is needed, identify only the most important issue and give one short actionable correction. If visibility is insufficient, do not guess.`,
      {
        step: input.step,
        recommendation: input.recommendation,
        preferences: input.preferences,
        previousEvaluation: input.previousEvaluation,
      },
      input.image,
    );
  }

  answerQuestion(
    input: QuestionAiInput,
  ): Promise<AiGatewayResponse<QuestionResult>> {
    return this.generate(
      'GUIDE_QUESTION',
      'musecue_guide_question',
      questionModelSchema,
      `Answer the user's question in the context of the selected method and current guide step. Do not change the selected method.
When an image is supplied, use it only to answer the current question. Give a short, supportive, actionable answer focused on what to do next.`,
      {
        question: input.question,
        step: input.step,
        recommendation: input.recommendation,
        preferences: input.preferences,
      },
      input.image,
    );
  }

  private async generate<T>(
    operation: AiOperation,
    schemaName: string,
    schema: ZodType<T>,
    taskInstruction: string,
    userContext: unknown,
    image?: PersonalizationAiInput['image'],
  ): Promise<AiGatewayResponse<T>> {
    const response = await this.provider.generateStructured({
      operation,
      schemaName,
      schema: z.toJSONSchema(schema),
      systemInstruction: MAKEUP_AI_SYSTEM_INSTRUCTION,
      taskInstruction,
      userContext,
      image,
    });
    const parsed = schema.safeParse(response.value);
    if (!parsed.success) {
      throw new AiProviderError(
        'AI_SCHEMA_VALIDATION_FAILED',
        'AI output failed application validation',
        true,
      );
    }
    return {
      data: parsed.data,
      metadata: {
        responseId: response.responseId,
        model: response.model,
        usage: response.usage,
      },
    };
  }
}
