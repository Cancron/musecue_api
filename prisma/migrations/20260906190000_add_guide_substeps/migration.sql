-- Existing guides retain their instructions; the mobile app supports an empty list.
ALTER TABLE "GuideStep" ADD COLUMN "substeps" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
