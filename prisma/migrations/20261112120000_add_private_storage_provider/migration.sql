-- Record which private object storage backend holds each stored image so
-- reads and deletes are routed to the backend that actually owns the object.

-- Existing image assets were written by the private filesystem adapter.
-- The temporary default backfills them; it is then dropped so every new row
-- must name its provider explicitly.
ALTER TABLE "ImageAsset" ADD COLUMN "storageProvider" VARCHAR(32) NOT NULL DEFAULT 'local';
ALTER TABLE "ImageAsset" ALTER COLUMN "storageProvider" DROP DEFAULT;

-- Avatars: a storage key (no scheme) was written by the filesystem adapter;
-- values containing "://" are external URLs (e.g. Google) and have no provider.
ALTER TABLE "userProfile" ADD COLUMN "avatarStorageProvider" VARCHAR(32);

UPDATE "userProfile"
SET "avatarStorageProvider" = 'local'
WHERE "avatarUrl" IS NOT NULL
  AND "avatarUrl" NOT LIKE '%://%';

-- A provider is only meaningful alongside the storage key it owns.
ALTER TABLE "userProfile" ADD CONSTRAINT "userProfile_avatar_storage_provider_check"
  CHECK ("avatarStorageProvider" IS NULL OR "avatarUrl" IS NOT NULL);
