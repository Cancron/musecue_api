import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type {
  MockEvaluationResult,
  MockGuideResult,
  MockPersonalizationResult,
  MockQuestionResult,
} from '../interfaces/makeup.interface';

const LOOK_IMAGES = [
  'https://images.pexels.com/photos/33334711/pexels-photo-33334711.jpeg?auto=compress&cs=tinysrgb&h=900&w=1200',
  'https://images.pexels.com/photos/6756279/pexels-photo-6756279.jpeg?auto=compress&cs=tinysrgb&h=900&w=1200',
  'https://images.pexels.com/photos/17200372/pexels-photo-17200372.jpeg?auto=compress&cs=tinysrgb&h=900&w=1200',
];

@Injectable()
export class MockAiGateway {
  personalize(vibe: string): MockPersonalizationResult {
    const result: MockPersonalizationResult = {
      analysis: {
        faceShape: 'oval',
        skinTone: 'medium',
        undertone: 'warm-neutral',
        notableFeatures: [
          'balanced proportions',
          'defined eyes',
          'soft cheek line',
        ],
        confidence: 0.91,
      },
      recommendations: [
        {
          rank: 1,
          name: vibe === 'glam' ? 'Polished Rose Glam' : 'Soft Natural',
          tagline: 'Fresh skin, softly defined eyes, effortless balance.',
          matchScore: 94,
          imageUrl: LOOK_IMAGES[0],
          palette: ['rose beige', 'soft brown', 'champagne'],
          rationale:
            'Balances the detected features while keeping the finish wearable and luminous.',
        },
        {
          rank: 2,
          name: 'Golden Hour',
          tagline: 'Warm radiance with softly sculpted definition.',
          matchScore: 88,
          imageUrl: LOOK_IMAGES[1],
          palette: ['warm gold', 'peach', 'caramel'],
          rationale:
            'Warm tones complement the mock undertone analysis and gently lift the cheek area.',
        },
        {
          rank: 3,
          name: 'Evening Sophisticate',
          tagline: 'A refined eye and muted statement lip.',
          matchScore: 85,
          imageUrl: LOOK_IMAGES[2],
          palette: ['mauve', 'espresso', 'soft berry'],
          rationale:
            'Adds evening definition without overpowering the user’s natural proportions.',
        },
      ],
    };
    this.assertPersonalization(result);
    return result;
  }

  generateGuide(lookName: string, timeMinutes: number): MockGuideResult {
    const perStep = Math.max(60, Math.floor((timeMinutes * 60) / 5));
    const result: MockGuideResult = {
      steps: [
        [
          'Prep your canvas',
          'Press moisturizer into clean skin, then smooth primer through the center of your face.',
          'complexion',
          'press and smooth',
        ],
        [
          'Even the complexion',
          'Blend a thin layer of base from the center outward, keeping the edges sheer.',
          'complexion',
          'thin-layer blending',
        ],
        [
          'Shape and lift',
          'Sweep blush slightly upward from the apples toward the temples.',
          'cheeks',
          'upward diffusing',
        ],
        [
          'Define the eyes',
          'Build soft brown shadow close to the lash line and diffuse the outer corner.',
          'eyes',
          'controlled blending',
        ],
        [
          'Balance the lips',
          'Tap lip color into the center, then soften it toward the lip line.',
          'lips',
          'finger diffusion',
        ],
      ].map(([title, instruction, area, technique], index) => ({
        position: index,
        title: String(title),
        instruction: String(instruction),
        area: String(area),
        technique: String(technique),
        estimatedSeconds: perStep,
        personalizedTip: `For ${lookName}, keep pressure light and build slowly; your balanced features need less correction than coverage.`,
        commonMistake:
          'Applying the full amount at once instead of building thin layers.',
        successCriteria:
          'Edges look diffused in natural light and the finish remains skin-like.',
      })),
    };
    if (
      result.steps.length < 3 ||
      result.steps.some((step) => !step.title || step.estimatedSeconds < 1)
    ) {
      throw new InternalServerErrorException(
        'Mock guide output failed validation',
      );
    }
    return result;
  }

  evaluateStep(position: number): MockEvaluationResult {
    const needsAdjustment = position % 3 === 1;
    const result: MockEvaluationResult = needsAdjustment
      ? {
          result: 'NEEDS_ADJUSTMENT',
          feedback:
            'Soften the outer edge with a clean brush using small circular motions, then check again.',
          confidence: 0.86,
        }
      : {
          result: 'PASS',
          feedback:
            'The placement and blend look balanced. You are ready for the next step.',
          confidence: 0.93,
        };
    return result;
  }

  answerQuestion(question: string, stepTitle: string): MockQuestionResult {
    return {
      answer: `For “${stepTitle}”, use a small amount first and build gradually. For your question—“${question}”—keep the pressure light and blend the edge before adding more product.`,
    };
  }

  private assertPersonalization(result: MockPersonalizationResult): void {
    const valid =
      result.analysis.confidence >= 0 &&
      result.analysis.confidence <= 1 &&
      result.recommendations.length >= 2 &&
      result.recommendations.length <= 3 &&
      result.recommendations.every(
        (item) =>
          item.rank > 0 &&
          item.name.length > 0 &&
          item.matchScore >= 0 &&
          item.matchScore <= 100,
      );
    if (!valid)
      throw new InternalServerErrorException(
        'Mock personalization output failed validation',
      );
  }
}
