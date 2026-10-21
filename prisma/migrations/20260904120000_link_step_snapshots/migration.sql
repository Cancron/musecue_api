-- AlterTable
ALTER TABLE "ImageAsset" ADD COLUMN "guideStepId" TEXT;

-- CreateIndex
CREATE INDEX "ImageAsset_guideStepId_createdAt_idx" ON "ImageAsset"("guideStepId", "createdAt");

-- AddForeignKey
ALTER TABLE "ImageAsset" ADD CONSTRAINT "ImageAsset_guideStepId_fkey" FOREIGN KEY ("guideStepId") REFERENCES "GuideStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;
