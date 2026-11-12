-- An avatar is either a private storage key together with the provider that
-- holds it, or an external URL (e.g. a Google profile photo) without one.
-- This replaces the weaker check from 20261112120000_add_private_storage_provider,
-- so code never has to guess a provider (such as the local filesystem).
-- Existing rows already satisfy it: that migration backfilled every stored key.
ALTER TABLE "userProfile" DROP CONSTRAINT "userProfile_avatar_storage_provider_check";

ALTER TABLE "userProfile" ADD CONSTRAINT "userProfile_avatar_storage_provider_check"
  CHECK (("avatarStorageProvider" IS NOT NULL) = ("avatarUrl" IS NOT NULL AND "avatarUrl" NOT LIKE '%://%'));
