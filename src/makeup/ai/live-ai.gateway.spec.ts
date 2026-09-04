import { mock } from 'jest-mock-extended';
import type { StructuredAiProvider } from './providers/structured-ai.provider';
import { LiveAiGateway } from './live-ai.gateway';

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
});
