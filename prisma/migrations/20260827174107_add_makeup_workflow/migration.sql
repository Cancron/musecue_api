/*
  Warnings:

  - You are about to drop the `Invoice` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Job` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `JobDocument` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `JobFollowUp` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `JobNote` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `JobReminder` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `JobTimelineEvent` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Payment` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Subscription` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `SubscriptionPlan` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "MakeupSessionStatus" AS ENUM ('CREATED', 'IMAGE_UPLOADED', 'ANALYZING', 'RECOMMENDATIONS_READY', 'METHOD_SELECTED', 'GUIDE_GENERATING', 'GUIDE_READY', 'IN_PROGRESS', 'COMPLETED', 'ANALYSIS_FAILED', 'GUIDE_FAILED');

-- CreateEnum
CREATE TYPE "ImagePurpose" AS ENUM ('INITIAL_ANALYSIS', 'STEP_CHECK', 'COMPLETION');

-- CreateEnum
CREATE TYPE "ImageSource" AS ENUM ('MOCK_CAPTURE', 'PRIVATE_UPLOAD');

-- CreateEnum
CREATE TYPE "AiOperation" AS ENUM ('PERSONALIZATION', 'IMAGE_GENERATION', 'GUIDE_GENERATION', 'VISION_CHECK', 'GUIDE_QUESTION');

-- CreateEnum
CREATE TYPE "AiRunStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "GuideStatus" AS ENUM ('GENERATING', 'READY', 'IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "GuideStepStatus" AS ENUM ('LOCKED', 'CURRENT', 'COMPLETED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "EvaluationResult" AS ENUM ('PASS', 'NEEDS_ADJUSTMENT', 'UNCERTAIN', 'CANNOT_EVALUATE');

-- DropForeignKey
ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_subscriptionId_fkey";

-- DropForeignKey
ALTER TABLE "Job" DROP CONSTRAINT "Job_authId_fkey";

-- DropForeignKey
ALTER TABLE "JobDocument" DROP CONSTRAINT "JobDocument_jobId_fkey";

-- DropForeignKey
ALTER TABLE "JobFollowUp" DROP CONSTRAINT "JobFollowUp_jobId_fkey";

-- DropForeignKey
ALTER TABLE "JobNote" DROP CONSTRAINT "JobNote_jobId_fkey";

-- DropForeignKey
ALTER TABLE "JobReminder" DROP CONSTRAINT "JobReminder_jobId_fkey";

-- DropForeignKey
ALTER TABLE "JobTimelineEvent" DROP CONSTRAINT "JobTimelineEvent_jobId_fkey";

-- DropForeignKey
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_subscriptionId_fkey";

-- DropForeignKey
ALTER TABLE "Subscription" DROP CONSTRAINT "Subscription_authId_fkey";

-- DropForeignKey
ALTER TABLE "Subscription" DROP CONSTRAINT "Subscription_planId_fkey";

-- DropTable
DROP TABLE "Invoice";

-- DropTable
DROP TABLE "Job";

-- DropTable
DROP TABLE "JobDocument";

-- DropTable
DROP TABLE "JobFollowUp";

-- DropTable
DROP TABLE "JobNote";

-- DropTable
DROP TABLE "JobReminder";

-- DropTable
DROP TABLE "JobTimelineEvent";

-- DropTable
DROP TABLE "Payment";

-- DropTable
DROP TABLE "Subscription";

-- DropTable
DROP TABLE "SubscriptionPlan";

-- DropEnum
DROP TYPE "AppliedVia";

-- DropEnum
DROP TYPE "FollowUpStatus";

-- DropEnum
DROP TYPE "FollowUpType";

-- DropEnum
DROP TYPE "InterviewType";

-- DropEnum
DROP TYPE "JobDocumentType";

-- DropEnum
DROP TYPE "JobLocationType";

-- DropEnum
DROP TYPE "JobPriority";

-- DropEnum
DROP TYPE "JobReminderType";

-- DropEnum
DROP TYPE "JobSourceType";

-- DropEnum
DROP TYPE "JobStatus";

-- DropEnum
DROP TYPE "JobTimelineEventType";

-- DropEnum
DROP TYPE "ReminderStatus";

-- DropEnum
DROP TYPE "ResponseStatus";

-- DropEnum
DROP TYPE "billingInterval";

-- DropEnum
DROP TYPE "invoiceStatus";

-- DropEnum
DROP TYPE "paymentStatus";

-- DropEnum
DROP TYPE "subscriptionStatus";

-- CreateTable
CREATE TABLE "MakeupSession" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "status" "MakeupSessionStatus" NOT NULL DEFAULT 'CREATED',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MakeupSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImageAsset" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "purpose" "ImagePurpose" NOT NULL,
    "source" "ImageSource" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImageAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MakeupPreferences" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "vibe" TEXT NOT NULL,
    "skillLevel" TEXT,
    "occasion" TEXT,
    "desiredEffect" TEXT,
    "timeMinutes" INTEGER NOT NULL,
    "notes" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MakeupPreferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FaceAnalysis" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "faceShape" TEXT NOT NULL,
    "skinTone" TEXT NOT NULL,
    "undertone" TEXT NOT NULL,
    "notableFeatures" TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FaceAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recommendation" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "tagline" TEXT NOT NULL,
    "matchScore" INTEGER NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "palette" JSONB NOT NULL,
    "rationale" TEXT NOT NULL,
    "selectedAt" TIMESTAMP(3),
    "savedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Guide" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "recommendationId" TEXT NOT NULL,
    "status" "GuideStatus" NOT NULL DEFAULT 'GENERATING',
    "currentStepIndex" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Guide_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuideStep" (
    "id" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "GuideStepStatus" NOT NULL DEFAULT 'LOCKED',
    "title" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "technique" TEXT NOT NULL,
    "estimatedSeconds" INTEGER NOT NULL,
    "personalizedTip" TEXT NOT NULL,
    "commonMistake" TEXT NOT NULL,
    "successCriteria" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuideStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StepAttempt" (
    "id" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "imageId" TEXT,
    "result" "EvaluationResult" NOT NULL,
    "feedback" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StepAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "question" VARCHAR(500) NOT NULL,
    "answer" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiRun" (
    "id" TEXT NOT NULL,
    "authId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "stepId" TEXT,
    "operation" "AiOperation" NOT NULL,
    "status" "AiRunStatus" NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "model" TEXT NOT NULL DEFAULT 'musecue-deterministic-v1',
    "promptVersion" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "latencyMs" INTEGER,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MakeupSession_authId_createdAt_idx" ON "MakeupSession"("authId", "createdAt");

-- CreateIndex
CREATE INDEX "MakeupSession_authId_status_idx" ON "MakeupSession"("authId", "status");

-- CreateIndex
CREATE INDEX "ImageAsset_sessionId_purpose_createdAt_idx" ON "ImageAsset"("sessionId", "purpose", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MakeupPreferences_sessionId_key" ON "MakeupPreferences"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "FaceAnalysis_sessionId_key" ON "FaceAnalysis"("sessionId");

-- CreateIndex
CREATE INDEX "Recommendation_sessionId_idx" ON "Recommendation"("sessionId");

-- CreateIndex
CREATE INDEX "Recommendation_savedAt_idx" ON "Recommendation"("savedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Recommendation_sessionId_rank_key" ON "Recommendation"("sessionId", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "Guide_sessionId_key" ON "Guide"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Guide_recommendationId_key" ON "Guide"("recommendationId");

-- CreateIndex
CREATE INDEX "GuideStep_guideId_status_idx" ON "GuideStep"("guideId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GuideStep_guideId_position_key" ON "GuideStep"("guideId", "position");

-- CreateIndex
CREATE INDEX "StepAttempt_stepId_createdAt_idx" ON "StepAttempt"("stepId", "createdAt");

-- CreateIndex
CREATE INDEX "Question_stepId_createdAt_idx" ON "Question"("stepId", "createdAt");

-- CreateIndex
CREATE INDEX "AiRun_sessionId_operation_createdAt_idx" ON "AiRun"("sessionId", "operation", "createdAt");

-- CreateIndex
CREATE INDEX "AiRun_authId_status_idx" ON "AiRun"("authId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AiRun_authId_idempotencyKey_key" ON "AiRun"("authId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "MakeupSession" ADD CONSTRAINT "MakeupSession_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageAsset" ADD CONSTRAINT "ImageAsset_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "MakeupSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MakeupPreferences" ADD CONSTRAINT "MakeupPreferences_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "MakeupSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FaceAnalysis" ADD CONSTRAINT "FaceAnalysis_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "MakeupSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "MakeupSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guide" ADD CONSTRAINT "Guide_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "MakeupSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guide" ADD CONSTRAINT "Guide_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuideStep" ADD CONSTRAINT "GuideStep_guideId_fkey" FOREIGN KEY ("guideId") REFERENCES "Guide"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepAttempt" ADD CONSTRAINT "StepAttempt_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "GuideStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StepAttempt" ADD CONSTRAINT "StepAttempt_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "ImageAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "GuideStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_authId_fkey" FOREIGN KEY ("authId") REFERENCES "authUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "MakeupSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "GuideStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;
