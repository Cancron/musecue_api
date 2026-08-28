import { MockAiGateway } from './mock-ai.gateway';

describe('MockAiGateway', () => {
  const gateway = new MockAiGateway();

  it('returns normalized personalization data', () => {
    const result = gateway.personalize('natural');

    expect(result.analysis.confidence).toBeGreaterThan(0);
    expect(result.recommendations).toHaveLength(3);
    expect(result.recommendations.map((item) => item.rank)).toEqual([1, 2, 3]);
    expect(result.recommendations.every((item) => item.matchScore <= 100)).toBe(
      true,
    );
  });

  it('returns an ordered five-step guide', () => {
    const result = gateway.generateGuide('Soft Natural', 20);

    expect(result.steps).toHaveLength(5);
    expect(result.steps.map((step) => step.position)).toEqual([0, 1, 2, 3, 4]);
    expect(result.steps.every((step) => step.estimatedSeconds > 0)).toBe(true);
  });

  it('returns only supported evaluation states', () => {
    expect(gateway.evaluateStep(0).result).toBe('PASS');
    expect(gateway.evaluateStep(1).result).toBe('NEEDS_ADJUSTMENT');
  });
});
