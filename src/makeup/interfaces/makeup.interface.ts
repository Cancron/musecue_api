export interface AuthenticatedUser {
  userId: string;
  role: string;
  tokenVersion: number;
}

export type AiOperation =
  | 'PERSONALIZATION'
  | 'GUIDE_GENERATION'
  | 'VISION_CHECK'
  | 'GUIDE_QUESTION';

export interface AiImageInput {
  bytes: Buffer;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
}

export interface RecommendationResult {
  rank: number;
  name: string;
  tagline: string;
  matchScore: number;
  imageUrl: string;
  palette: string[];
  rationale: string;
}

export interface PersonalizationResult {
  analysis: {
    faceShape: string;
    skinTone: string;
    undertone: string;
    notableFeatures: string[];
    confidence: number;
  };
  recommendations: RecommendationResult[];
}

export interface GuideStepResult {
  position: number;
  title: string;
  instruction: string;
  area: string;
  technique: string;
  estimatedSeconds: number;
  personalizedTip: string;
  commonMistake: string;
  successCriteria: string;
}

export interface GuideResult {
  steps: GuideStepResult[];
}

export interface EvaluationResult {
  result: 'PASS' | 'NEEDS_ADJUSTMENT' | 'UNCERTAIN' | 'CANNOT_EVALUATE';
  feedback: string;
  confidence: number;
}

export interface QuestionResult {
  answer: string;
}

export interface PersonalizationAiInput {
  image: AiImageInput;
  preferences: {
    vibe: string;
    skillLevel: string | null;
    occasion: string | null;
    desiredEffect: string | null;
    timeMinutes: number;
    notes: string | null;
  };
}

export interface GuideAiInput {
  recommendation: RecommendationResult;
  preferences: PersonalizationAiInput['preferences'];
  analysis: PersonalizationResult['analysis'] | null;
}

export interface EvaluationAiInput {
  image: AiImageInput;
  step: GuideStepResult;
  recommendation: Pick<RecommendationResult, 'name' | 'tagline'>;
  preferences: Pick<
    PersonalizationAiInput['preferences'],
    'vibe' | 'desiredEffect'
  >;
  previousEvaluation: EvaluationResult | null;
}

export interface QuestionAiInput {
  question: string;
  step: GuideStepResult;
  recommendation: Pick<RecommendationResult, 'name' | 'tagline'>;
  preferences: Pick<
    PersonalizationAiInput['preferences'],
    'vibe' | 'desiredEffect'
  >;
  image?: AiImageInput;
}
