import { MockAiGateway } from './mock-ai.gateway';
import { guideModelSchema, evaluationModelSchema } from './ai.schemas';

describe('MockAiGateway', () => {
  const gateway = new MockAiGateway();
  const preferences = {
    vibe: 'natural',
    skillLevel: 'beginner',
    occasion: 'everyday',
    desiredEffect: 'soft definition',
    timeMinutes: 20,
    notes: null,
  };
  const image = {
    bytes: Buffer.from('image'),
    mimeType: 'image/jpeg' as const,
  };

  it('returns normalized personalization data', async () => {
    const result = await gateway.personalize({ preferences, image });

    expect(result.data.analysis.confidence).toBeGreaterThan(0);
    expect(result.data.recommendations).toHaveLength(3);
    expect(result.data.recommendations.map((item) => item.rank)).toEqual([
      1, 2, 3,
    ]);
    expect(
      result.data.recommendations.every((item) => item.matchScore <= 100),
    ).toBe(true);
  });

  it('returns an ordered five-step guide', async () => {
    const personalization = await gateway.personalize({ preferences, image });
    const result = await gateway.generateGuide({
      recommendation: personalization.data.recommendations[0],
      preferences,
      analysis: personalization.data.analysis,
    });

    expect(result.data.steps).toHaveLength(5);
    expect(guideModelSchema.safeParse(result.data).success).toBe(true);
    expect(
      result.data.steps.every(
        (step) =>
          step.spokenIntro &&
          step.spokenSubsteps?.length === step.substeps.length,
      ),
    ).toBe(true);
    expect(result.data.steps.every((step) => step.substeps.length >= 2)).toBe(
      true,
    );
    expect(result.data.steps.map((step) => step.position)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(result.data.steps.every((step) => step.estimatedSeconds > 0)).toBe(
      true,
    );
  });

  it('returns only supported evaluation states', async () => {
    const personalization = await gateway.personalize({ preferences, image });
    const guide = await gateway.generateGuide({
      recommendation: personalization.data.recommendations[0],
      preferences,
      analysis: personalization.data.analysis,
    });
    const evaluation = await gateway.evaluateStep({
      image,
      step: guide.data.steps[0],
      recommendation: personalization.data.recommendations[0],
      preferences,
      previousEvaluation: null,
    });
    expect(evaluationModelSchema.safeParse(evaluation.data).success).toBe(true);
    await expect(
      gateway.evaluateStep({
        image,
        step: guide.data.steps[0],
        recommendation: personalization.data.recommendations[0],
        preferences,
        previousEvaluation: null,
      }),
    ).resolves.toMatchObject({ data: { result: 'PASS' } });
    await expect(
      gateway.evaluateStep({
        image,
        step: guide.data.steps[1],
        recommendation: personalization.data.recommendations[0],
        preferences,
        previousEvaluation: null,
      }),
    ).resolves.toMatchObject({ data: { result: 'NEEDS_ADJUSTMENT' } });
  });
});
