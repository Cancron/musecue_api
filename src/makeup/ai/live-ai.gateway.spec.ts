import { mock } from 'jest-mock-extended';
import type { StructuredAiProvider } from './providers/structured-ai.provider';
import { LiveAiGateway } from './live-ai.gateway';
import { GUIDE_TASK } from './ai.prompts';

describe('LiveAiGateway', () => {
  const provider = mock<StructuredAiProvider>();
  const gateway = new LiveAiGateway(provider);
  const input = {
    image: {
      bytes: Buffer.from('photo'),
      mimeType: 'image/jpeg' as const,
    },
    preferences: {
      vibe: 'natural',
      skillLevel: 'beginner',
      occasion: 'work',
      desiredEffect: 'lifted eyes',
      timeMinutes: 10,
      notes: null,
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    provider.name = 'openrouter';
    provider.validateConfiguration.mockReturnValue();
    provider.modelFor.mockReturnValue('openrouter/free');
  });

  it('validates, ranks, and normalizes live personalization output', async () => {
    provider.generateStructured.mockResolvedValue({
      responseId: 'response-id',
      model: 'vision-model',
      usage: { totalTokens: 120 },
      value: {
        analysis: {
          faceShape: 'oval',
          skinTone: 'medium',
          undertone: 'neutral',
          notableFeatures: ['defined eyes'],
          confidence: 0.88,
        },
        recommendations: [
          {
            name: 'Second Look',
            tagline: 'Soft definition',
            matchScore: 82,
            palette: ['rose', 'brown'],
            rationale: 'Fits the available time.',
          },
          {
            name: 'Best Look',
            tagline: 'Lifted and natural',
            matchScore: 94,
            palette: ['taupe', 'champagne'],
            rationale: 'Matches the desired effect.',
          },
        ],
      },
    });

    const result = await gateway.personalize(input);

    expect(
      result.data.recommendations.map(({ rank, name }) => ({ rank, name })),
    ).toEqual([
      { rank: 1, name: 'Best Look' },
      { rank: 2, name: 'Second Look' },
    ]);
    expect(result.data.recommendations[0].imageUrl).toContain('pexels.com');
    expect(result.metadata).toEqual({
      responseId: 'response-id',
      model: 'vision-model',
      usage: { totalTokens: 120 },
    });
    expect(provider.generateStructured.mock.calls[0]?.[0]).toMatchObject({
      operation: 'PERSONALIZATION',
      schemaName: 'musecue_personalization',
      image: input.image,
    });
  });

  it('rejects provider output that violates the application schema', async () => {
    provider.generateStructured.mockResolvedValue({
      model: 'vision-model',
      value: {
        analysis: {
          faceShape: 'oval',
          skinTone: 'medium',
          undertone: 'neutral',
          notableFeatures: ['defined eyes'],
          confidence: 2,
        },
        recommendations: [],
      },
    });

    await expect(gateway.personalize(input)).rejects.toMatchObject({
      code: 'AI_SCHEMA_VALIDATION_FAILED',
      retryable: true,
    });
  });

  const guideStep = {
    title: 'Prepare the skin',
    instruction: 'Apply moisturizer, then a thin layer of primer.',
    substeps: [
      'Press moisturizer gently into clean skin.',
      'Smooth a thin layer of primer over the center of your face.',
    ],
    area: 'complexion',
    technique: 'press and smooth',
    estimatedSeconds: 120,
    personalizedTip: 'Keep coverage light.',
    commonMistake: 'Applying too much.',
    successCriteria: 'Skin looks evenly prepared.',
  };
  const guideInput = {
    recommendation: {
      rank: 1,
      name: 'Natural',
      tagline: 'Soft',
      matchScore: 90,
      imageUrl: '',
      palette: ['rose', 'beige'],
      rationale: 'Everyday look',
    },
    preferences: input.preferences,
    analysis: null,
  };

  it('requests the shared substep prompt and preserves validated action order', async () => {
    provider.generateStructured.mockResolvedValue({
      model: 'text-model',
      value: { steps: [guideStep, guideStep, guideStep] },
    });
    const response = await gateway.generateGuide(guideInput);
    expect(response.data.steps[0].substeps).toEqual(guideStep.substeps);
    expect(response.data.steps.map((step) => step.position)).toEqual([0, 1, 2]);
    expect(provider.generateStructured.mock.calls[0]?.[0]).toMatchObject({
      operation: 'GUIDE_GENERATION',
      taskInstruction: GUIDE_TASK,
    });
    expect(gateway.describe('GUIDE_GENERATION').promptVersion).toBe(
      'GUIDE_V2_SUBSTEPS',
    );
  });

  it.each(
    [
      undefined,
      [],
      ['Only one'],
      ['', 'Apply gently.'],
      ['x'.repeat(181), 'Apply gently.'],
      Array.from({ length: 7 }, () => 'Apply gently.'),
    ].map((substeps) => ({ substeps })),
  )(
    'rejects missing, empty, or oversized substeps (%j)',
    async ({ substeps }) => {
      provider.generateStructured.mockResolvedValue({
        model: 'text-model',
        value: {
          steps: [{ ...guideStep, substeps }, guideStep, guideStep],
        },
      });
      await expect(gateway.generateGuide(guideInput)).rejects.toMatchObject({
        code: 'AI_SCHEMA_VALIDATION_FAILED',
        retryable: true,
      });
    },
  );
});
