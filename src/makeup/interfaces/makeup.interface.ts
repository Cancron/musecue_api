export interface AuthenticatedUser {
  userId: string;
  role: string;
  tokenVersion: number;
}

export interface MockRecommendation {
  rank: number;
  name: string;
  tagline: string;
  matchScore: number;
  imageUrl: string;
  palette: string[];
  rationale: string;
}

export interface MockPersonalizationResult {
  analysis: {
    faceShape: string;
    skinTone: string;
    undertone: string;
    notableFeatures: string[];
    confidence: number;
  };
  recommendations: MockRecommendation[];
}

export interface MockGuideStep {
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

export interface MockGuideResult {
  steps: MockGuideStep[];
}

export interface MockEvaluationResult {
  result: 'PASS' | 'NEEDS_ADJUSTMENT' | 'UNCERTAIN' | 'CANNOT_EVALUATE';
  feedback: string;
  confidence: number;
}

export interface MockQuestionResult {
  answer: string;
}
