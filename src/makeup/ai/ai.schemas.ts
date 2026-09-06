import { z } from 'zod';

const trimmedText = z.string().trim().min(1);

export const personalizationModelSchema = z.object({
  analysis: z.object({
    faceShape: trimmedText,
    skinTone: trimmedText,
    undertone: trimmedText,
    notableFeatures: z.array(trimmedText).min(1).max(6),
    confidence: z.number().min(0).max(1),
  }),
  recommendations: z
    .array(
      z.object({
        name: trimmedText,
        tagline: trimmedText,
        matchScore: z.number().int().min(0).max(100),
        palette: z.array(trimmedText).min(2).max(6),
        rationale: trimmedText,
      }),
    )
    .min(2)
    .max(3),
});

export const guideModelSchema = z.object({
  steps: z
    .array(
      z.object({
        title: trimmedText,
        instruction: trimmedText,
        substeps: z.array(trimmedText.max(180)).min(2).max(6),
        spokenIntro: trimmedText.max(140),
        spokenSubsteps: z.array(trimmedText.max(220)).min(2).max(6),
        area: trimmedText,
        technique: trimmedText,
        estimatedSeconds: z.number().int().min(30).max(1800),
        personalizedTip: trimmedText,
        commonMistake: trimmedText,
        successCriteria: trimmedText,
      }),
    )
    .min(3)
    .max(8),
});

export const evaluationModelSchema = z.object({
  result: z.enum(['PASS', 'NEEDS_ADJUSTMENT', 'UNCERTAIN', 'CANNOT_EVALUATE']),
  feedback: trimmedText,
  spokenFeedback: trimmedText.max(400),
  confidence: z.number().min(0).max(1),
});

export const questionModelSchema = z.object({
  answer: trimmedText,
});
