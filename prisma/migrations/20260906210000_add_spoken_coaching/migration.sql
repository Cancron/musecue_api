ALTER TABLE "GuideStep"
  ADD COLUMN "spokenIntro" TEXT,
  ADD COLUMN "spokenSubsteps" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "StepAttempt" ADD COLUMN "spokenFeedback" TEXT;
