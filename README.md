# MuseCue API

**AI makeup guidance, made for your face.**

The MuseCue API is the NestJS authority for authentication, authorization, workflow state, persistence, and AI orchestration. Supabase Auth and Database are not used; Supabase Storage serves only as the server-side private image store. AI providers may interpret or generate data, but only NestJS validates results and advances application state.

The companion mobile application and detailed product specifications live in `../face_makeup_app`.

## Implemented

- PostgreSQL/Prisma local accounts, SMTP verification through BullMQ, login auditing, account lockout, and Google OAuth foundations
- short-lived JWT access tokens and rotating, revocable Redis-backed refresh tokens
- owner-scoped makeup sessions and the documented workflow state machine
- validated multipart image upload, private object storage (a private Supabase Storage bucket by default, behind a provider interface), image metadata, structured preferences, face analysis, ranked recommendations, saved looks, and selection
- generated guides, authoritative step progression, retained visual attempts, contextual questions, completion history, profile statistics, and optional private profile avatars
- BullMQ jobs for personalization, guide generation, visual checks, and guide questions
- `AiRun` audit records containing operation, provider, model, prompt version, latency, progress, result/error, and status
- a provider-neutral AI gateway with OpenRouter live mode, multimodal private-image input, strict structured output, runtime validation, bounded retries, and deterministic mock mode
- a single Pro subscription plan: admin-configured monthly/yearly pricing and free trial, one-time trial activation, date-based Pro access through `ProAccessGuard`, and payment/lifecycle records protected by database rules (see "Subscriptions" under API); checkout, webhooks and billing endpoints are not implemented yet

Migration `20260827174107_add_makeup_workflow` adds the makeup aggregate and removes the dormant job-tracker and subscription starter domains.

Intentionally deferred:

- signed URLs for avatars and for images still on the local filesystem (they keep using the authenticated content routes)
- copying images stored on the filesystem before the Supabase migration into the bucket (they remain readable through the `local` provider while its directory is present)
- additional S3-compatible storage providers (the provider interface is in place; see "Private image storage")
- generated preview images (recommendation reasoning is live, while the existing curated preview-image contract remains in place)
- production retention/deletion automation and AI cost accounting

## Requirements and setup

- Node.js 22+
- PostgreSQL 17
- Redis 7+
- working SMTP credentials

```bash
copy .env.example .env
docker compose up -d postgres_db redis-stack
npm install
npx prisma migrate deploy
npm run start:dev
```

The API defaults to `http://localhost:5000`; development Swagger is at `http://localhost:5000/docs`.

Important environment variables are documented in `.env.example`. Never commit the real `.env` or log SMTP credentials, tokens, image contents, or future signed URLs.

### Private image storage

Face photos, step snapshots, and profile avatars are written to a **private** Supabase Storage bucket by default. The API validates the image and checks ownership first, then uploads the bytes with a server-side secret key. It records the object key and the provider that holds it (`ImageAsset.storageKey` + `storageProvider`, `userProfile.avatarUrl` + `avatarStorageProvider`). Clients never receive the credentials. Images are served through the authenticated content routes, or through a 60-second signed URL (see "Signed image URLs").

1. In the Supabase dashboard, create a bucket (for example `musecue-private-images`) with **Public bucket switched off**. We recommend a 10 MB file size limit and allowed MIME types `image/jpeg, image/png, image/webp`. No RLS policies are needed: only the server's secret key accesses the bucket.
2. Set the server-side variables (see `.env.example`):

   ```dotenv
   PRIVATE_STORAGE_PROVIDER=supabase
   SUPABASE_URL=https://your-project-ref.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your-secret-or-service-role-key
   SUPABASE_STORAGE_BUCKET=musecue-private-images
   # SUPABASE_STORAGE_TIMEOUT_MS=15000
   ```

3. Run `npx prisma migrate deploy` (migrations `20261112120000_add_private_storage_provider`, `20261112130000_add_private_storage_cleanup` and `20261112140000_enforce_avatar_storage_provider`) and restart the API and workers.

For Docker deployments, `docker-compose.prod.yaml` passes these variables into the container at runtime. Compose reads them from the deploy host's environment or from the `.env` file next to the compose files on the server. `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_STORAGE_BUCKET` are required; if one is missing, `docker-compose` stops before starting anything. `.dockerignore` excludes `.env` and `.env.*` (except `.env.example`), so secrets never enter the build context or image layers.

Startup fails when the active provider is misconfigured: a missing variable, a non-https URL (http is accepted only for a local Supabase stack on loopback), or a publishable/anon key. Errors name the variable, never its value. Before uploading, the API checks that the bucket exists and is private. It re-checks every 5 minutes and refuses uploads to a public bucket. Never expose `SUPABASE_*` values to the mobile app or through an `EXPO_PUBLIC_`-style variable.

Every workflow reads, signs and deletes an image through the provider and key recorded on its row; nothing derives a filesystem path. This covers face photos, step snapshots and checks, avatar uploads, replacements and removals, session deletion, and the AI worker. New uploads always go to the active provider (Supabase). The local filesystem provider stays registered only so images stored before the migration (marked `local`) can still be read and deleted. It is **read-only** unless `PRIVATE_STORAGE_PROVIDER=local`, so no new image can land on the filesystem. Keep `PRIVATE_UPLOAD_DIR` (default `.data/private-images`, ignored by Git and never served statically) available until those old files are copied to the bucket or expire. `PRIVATE_STORAGE_PROVIDER=local` writes new uploads to that directory for offline development. Test runs (`NODE_ENV=test`) use `local` unless configured otherwise.

Avatars are either a private upload (`avatarUrl` holds the storage key and `avatarStorageProvider` holds its provider) or an external URL such as a Google profile photo (`avatarStorageProvider` is `NULL`). A database CHECK constraint enforces this, so a provider is never guessed. External avatar URLs are returned unchanged by `GET /v1/profile`, are never sent to storage, and are never deleted. Avatar uploads, replacements and removals lock the profile row. A first upload creates the row before locking it, so parallel uploads always leave exactly one stored avatar.

Storage failures never expose provider details to clients:

| Situation                                             | Upload / image read response                             | Worker (analysis, visual check)         |
| ----------------------------------------------------- | -------------------------------------------------------- | --------------------------------------- |
| Object missing                                        | read: `404` (`Image content is unavailable`)             | run fails immediately with a clear message |
| Network error, timeout, rate limit, provider `5xx`     | `503` `Image storage is temporarily unavailable. Please try again.` | retried within the job's retry budget   |
| Misconfiguration, public/missing bucket, rejected key | `500` `Image storage is unavailable`                     | run fails                               |

Logs include the provider, operation, error code, and HTTP status, never URLs, credentials, or image bytes.

#### Failed uploads, replacements, and deletions

The `PrivateStorageCleanup` table records every object that is, or may become, unreferenced. It is written so that no case depends on a log line:

| Case | What is recorded, and when | Outcome |
| ---- | -------------------------- | ------- |
| Upload | An `UPLOAD_PENDING` reservation, **before** any bytes are written. If it cannot be saved, nothing is uploaded (`503`). | The transaction that stores the image reference removes the reservation. |
| Upload rejected by the provider (4xx, access denied) | Nothing was stored. | The reservation is removed. |
| Upload timeout, network error or provider `5xx` | The bytes may have been stored, or may still land after the client gave up. | The reservation becomes `UPLOAD_ABANDONED` and is deleted after a 10-minute settle period, so a late write cannot outlive the deletion. |
| Database write fails after the upload | The rollback keeps the reservation. | It becomes `UPLOAD_ABANDONED` and is deleted. If the database itself is down, the cleaner deletes it once the 1-hour reservation expires. |
| Process crash between upload and commit | The reservation stays. | After 1 hour the cleaner marks it abandoned and deletes it. A late commit is then refused with `409`. |
| Replaced image or avatar, deleted session or avatar, discarded check image | A row (`IMAGE_REPLACED`, `AVATAR_REPLACED`, `SESSION_DELETED`, `AVATAR_REMOVED`, `IMAGE_DISCARDED`) in the **same transaction** that removes the reference. | Deleted right after the commit, then by the cleaner. |

A row is removed only after the provider confirms the deletion. A failed deletion is never treated as done. Supabase's bulk remove answers `200` with an empty list both for an already-missing object and for a delete that was silently not applied (for example, missing permissions). The API therefore counts a removal as done only if the key is listed as removed, or a follow-up lookup confirms the object is gone; otherwise it records `DELETE_NOT_APPLIED` and retries. The row stays `PENDING` with `attempts`, `lastErrorCode`, `lastAttemptAt` and `nextAttemptAt`, and is retried with exponential backoff (30 s doubling, capped at 6 h). After 14 attempts, or immediately for an invalid key, it becomes `FAILED`: it stays in the table for manual recovery, the cleaner no longer retries it, and an error is logged (`Private image deletion failed permanently; manual recovery required`). The user's request still succeeds: the database change is committed and the object deletion is pending.

A background cleaner runs every minute on each API/worker instance (not when `NODE_ENV=test`). Instances claim rows atomically, so each deletion is attempted by one instance at a time, and a database error on one row does not stop the rest of the batch. Only full, validated object keys (`<user>/<scope>/<uuid>.<ext>`) are ever sent to the provider for deletion. A folder-like or empty key is refused before any request and marked `FAILED` (`INVALID_STORAGE_KEY`), so no row can remove other images by prefix. Before deleting, the cleaner checks that no `ImageAsset` or avatar still references the key; if one does, it keeps the object and drops the row.

To inspect or recover:

```sql
SELECT id, provider, "storageKey", reason, status, attempts, "lastErrorCode", "nextAttemptAt"
FROM "PrivateStorageCleanup" ORDER BY "createdAt";

-- After fixing the cause (credentials, bucket, provider outage), requeue failed rows:
UPDATE "PrivateStorageCleanup"
SET status = 'PENDING', attempts = 0, "nextAttemptAt" = now()
WHERE status = 'FAILED';
```

#### Signed image URLs

`GET /v1/images/:imageId/signed-url` (bearer token) returns a direct download URL for an image the caller owns:

```json
{ "url": "https://<project>.supabase.co/storage/v1/object/sign/<bucket>/<key>?token=...", "expiresAt": "2026-11-12T12:01:00.000Z", "expiresInSeconds": 60 }
```

- The URL is generated from the provider and key stored on the image and is valid for 60 seconds. Each call issues a new URL, so clients request another one when it expires. URLs are never stored or logged, and the response is sent with `Cache-Control: private, no-store`.
- The URL contains only an object-scoped token signed by Supabase, never the server key. It reveals the Supabase host, the bucket name and the object key (which contains the user's own id and session id).
- `expiresAt` is the expiry reported by the storage provider (for Supabase, the signed token's `exp`), never the API's request time + 60 s. `expiresInSeconds` is the provider's issued lifetime (`exp − iat`), so `expiresAt = issuedAt + expiresInSeconds` always holds. Both come from the provider's clock: a slow signing call or a clock difference between the API and the provider is reflected exactly. Clients that don't trust their own clock should count down `expiresInSeconds` from when they received the response.
- The maximum lifetime is strictly 60 seconds. The API asks for 60 s, and both the facade and the provider refuse longer requests. It accepts a provider response only if it is a signed URL for exactly that bucket and key, and its token is a JWT whose signed lifetime (`exp − iat`) is at most the requested 60 s. There is no clock-skew allowance. Tokens without readable `iat`/`exp` claims are rejected rather than trusted. Because the lifetime comes from the issuer's own claims, this does not depend on the API and Supabase clocks agreeing.
- Responses: `401` without a valid token. `404` `Image not found` for a missing image *or another user's image* (they are indistinguishable). `404` `Image content is unavailable` for a missing object or a non-uploaded image. `409` for images still on the local filesystem (use `/content`). `503` or `500` for storage failures, as in the table above.
- `GET /v1/images/:imageId/content` is unchanged.
- Clients download directly from the Supabase host, so the mobile app must be allowed to reach it.

`GET /v1/profile/avatar/signed-url` (bearer token) returns the same `{ url, expiresAt, expiresInSeconds: 60 }` for the caller's **own** uploaded avatar:

- It goes through the same code path as makeup images (`issueSignedImageUrl`), so the safeguards are identical: the provider and key stored on the profile, the strict 60-second limit checked against the provider's token, nothing stored or logged, `Cache-Control: private, no-store`, and the same safe error mapping.
- The user comes only from the access token; there is no route or query parameter to select another user. A stored avatar key must also be inside the caller's `<userId>/profile/` folder. Otherwise the API answers `404` and contacts no storage provider, so even a corrupted profile row cannot expose another user's file. The same check now protects `GET /v1/profile/avatar/content`.
- Responses: `401` without a valid token. `404` `Avatar image is unavailable` when there is no avatar or its object is missing. `409` for external avatars, and for avatars still on the local filesystem (use `/v1/profile/avatar/content`). `503` or `500` for storage failures.
- External avatars (for example a Google profile photo) are never signed or replaced. `GET /v1/profile` keeps returning their URL unchanged, and this endpoint answers `409` `This avatar is an external image and has no signed URL. Use avatarUrl from the profile instead.`
- Changing or removing an avatar never leaves the profile pointing at a missing file. The new file is confirmed in the same transaction that updates the profile, the old file is only recorded for deletion in that transaction, and the old file is deleted only after the commit. Signed URLs issued for an old avatar stop working once it is deleted.

#### Storage providers

New uploads go to the provider named by `PRIVATE_STORAGE_PROVIDER` (default `supabase`). Every image and avatar row stores the provider that holds it. Downloads, deletions, signed URLs and AI-worker reads always use that stored provider, never the current default. Changing the default therefore only affects new uploads:
- Images stored earlier keep working, as long as their provider stays registered and configured.
- Replacing or deleting an old image removes it from its own provider.
- Switching back later works the same way.

To add a backend such as an S3-compatible service:

1. Implement `PrivateObjectStorageProvider` (`src/storage/private-object-storage.provider.ts`): `put` (write-once), `get`, `delete` (exact key, idempotent, only report success once the object is really gone), `createSignedUrl`, and `isConfigured`. `createSignedUrl` must return the provider's own validity window (`issuedAt`/`expiresAt`, for example from `X-Amz-Date` + `X-Amz-Expires`) and refuse lifetimes above 60 s. Errors must be `PrivateStorageError`s with safe messages.
2. Give it a stable id matching `^[a-z][a-z0-9-]{0,31}$` (stored in `VARCHAR(32)` columns), register it in `StorageModule`, and validate its settings at startup.
3. Add it to the provider contract suite (`src/storage/provider-contract.private-cloud.spec.ts`). Supabase, a fake S3-compatible store and the local filesystem all pass the same cases there. Keys, ownership checks, validation and the image workflows need no changes.

Never rename or unregister a provider, or remove its credentials, while rows still reference it. At startup the API logs an error (`Stored images reference a storage provider that is not registered or not configured`) for every such provider found in images, avatars or pending deletions. While a provider is missing, its images answer `500 Image storage is unavailable`, AI runs that need them fail with a safe message, and their deletions stay `PENDING` in the cleanup ledger until the provider is registered again. They are never counted as done. The focused storage tests run with `npx jest private-cloud`.

### Live AI with OpenRouter

The backend defaults to live AI outside the test environment. Create a fresh OpenRouter key and add it only to the ignored `.env` file:

```dotenv
AI_MODE=live
OPENROUTER_API_KEY=your-new-key
OPENROUTER_MODEL=openrouter/free
```

Restart the API and BullMQ worker after changing environment variables. Use `AI_MODE=mock` for deterministic offline development. The optional analysis, guide, vision, and question model variables allow each operation to be routed independently without changing services or mobile API contracts.

Initial analysis and makeup checks read owned images from private storage and send them to OpenRouter as in-request data URLs. They are never exposed through permanent public URLs. Structured responses are validated again by Zod before any transaction changes workflow state. Provider timeouts, rate limits, and server failures use the existing BullMQ job retry budget; invalid credentials and other non-retryable requests fail immediately.

`openrouter/free` is useful for development, but model choice and availability can vary. For face-photo privacy, review the chosen model/provider policy and optionally set `OPENROUTER_DATA_COLLECTION=deny`; that restriction may leave fewer or no free providers. Production should pin evaluated vision/text models rather than rely on the free router.

### Bite-sized guide instructions

Spoken guides need a larger output budget than the former text-only guide. The example configuration uses `OPENROUTER_GUIDE_MAX_TOKENS=8000` and `OPENROUTER_GUIDE_TIMEOUT_MS=90000`. Update existing deployments too; changing `.env.example` does not override their environment. Token precedence remains operation-specific setting, then `OPENROUTER_MAX_TOKENS`, then the built-in operation default (8,000 for guides). Other operations keep their existing budgets. The increased cap can increase cost and latency; it is not a guarantee of provider capacity.

For a pinned model/provider that supports reasoning effort, optionally set `OPENROUTER_GUIDE_REASONING_EFFORT=low`. Leave it unset for models/routers with unverified support. Supported values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; the model must support the chosen value. Reasoning still consumes output tokens even when its text is excluded. See [OpenRouter reasoning controls](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

Provider failures are classified before checking for empty text: token exhaustion becomes `AI_OUTPUT_TRUNCATED`, content filtering becomes `AI_CONTENT_FILTERED`, and embedded provider errors (including HTTP 200 error envelopes) use the same retry policy as HTTP failures. Token exhaustion and filtering terminate immediately instead of repeating identical requests; transient failures still use the bounded queue retry policy. No partial guide is saved. After correcting configuration, restart API/workers and use the app's retry action; old failed jobs are not automatically re-run.

Worker retry/failure logs include the run ID, operation, error code, and allowlisted diagnostics (HTTP/provider status, normalized finish reason, completion/reasoning token counts, content character count, configured token limit and timeout). They never include raw provider errors, response text, reasoning, prompts, images, URLs, or credentials. Search logs for the run ID to distinguish a token cutoff, empty response, timeout, or provider failure. Public API contracts and workflow transitions are unchanged.

Conversational coaching uses `GUIDE_V4_PAIRED_COACHING` and `MAKEUP_CHECK_V2_SPOKEN_COACHING`. Guide output now includes `spokenIntro` (up to 140 characters) and `spokenSubsteps` (one per written substep, up to 220 characters each). The gateway enforces equal array lengths and validates nonempty bounded strings. Check output includes `spokenFeedback` (up to 400 characters) alongside the unchanged result, confidence, and written feedback. The prompts require the same actions and evaluation in both versions, evidence-based encouragement, one correction at a time, and explicit uncertainty when visibility is insufficient. Semantic consistency still requires model evaluation; schema validation cannot prove advice quality.

Guide V4 adds three paired checklist/voice examples to distinguish concise written instructions from conversational coaching. Examples demonstrate style only, not products or actions to insert into unrelated guides. The prompt discourages whole-array copying and mechanical filler while allowing an already-natural short sentence to remain unchanged. Validation, retry behavior, API contracts, and playback are unchanged. Restart API/workers and generate a new guide to test this prompt; existing stored guides are not rewritten. Prompt examples improve guidance but do not guarantee distinct model wording.

Migration `20260906210000_add_spoken_coaching` adds nullable intro/feedback fields and an empty-default spoken-substep array, preserving existing records. Spoken text is stored with the guide and attempt, and returned in the existing session/job responses. Older mobile clients can ignore these additive fields; new clients fall back to written text for old sessions. No additional AI requests, queues, or workflow transitions are introduced. Deploy migrations and restart API/workers before generating new guides.

Guide prompt `GUIDE_V4_PAIRED_COACHING` asks the existing OpenRouter model for 2–6 ordered `substeps` per main step. Each item is one concrete action, at most 180 characters. The shared prompt is used by the live gateway, and Zod validates this field before the worker persists it. The deterministic mock gateway follows the same contract.

Migration `20260906190000_add_guide_substeps` adds `GuideStep.substeps` as a non-null text array with an empty default, preserving existing guides. Deploy migrations and regenerate Prisma before restarting the API/workers. The session API returns the additive field; `instruction` remains available for older clients and history. No new job or endpoint is needed. The app controls local instruction-by-instruction playback, while NestJS retains ownership of main-step progression and checks.

### Traffic and provider capacity

The makeup worker processes I/O-bound AI jobs concurrently, while Redis-backed global concurrency and rate limits cap aggregate OpenRouter traffic across every running API instance. Interactive vision checks and coach questions receive higher queue priority than initial analysis and guide generation. A short provider `429` pauses the shared queue only for its requested delay and may defer a job twice. Multi-hour quota exhaustion fails immediately so jobs reach a terminal state instead of freezing the queue. Other transient failures use the three-attempt exponential backoff budget with jitter.

Defaults are conservative for development:

```dotenv
AI_QUEUE_GLOBAL_CONCURRENCY=4
AI_QUEUE_RATE_LIMIT_MAX=15
AI_QUEUE_RATE_LIMIT_DURATION_MS=60000
AI_QUEUE_MAX_BACKLOG=1000
AI_QUEUE_MAX_PROVIDER_PAUSE_MS=120000
AI_QUEUE_MAX_RATE_LIMIT_DEFERRALS=2
```

Increase these only after pinning production models and matching the limits on your OpenRouter account. Multiple backend instances can consume the same queue; the Redis limits remain global. New jobs receive a service-unavailable response once the configurable backlog ceiling is reached instead of growing an unbounded queue. `OPENROUTER_FALLBACK_MODELS` can provide comma-separated capacity fallbacks, and `OPENROUTER_PROVIDER_SORT=throughput` can favor faster providers. Large stored images are resized and JPEG-compressed in memory before provider delivery, while already-small mobile images pass through unchanged.

The free router is intended for development and cannot provide bulk-production capacity. Paid models, explicit account spending caps, production observability, and load testing are required before a public launch.

### Workflow and authentication reliability

- Session writes and AI result publication share a PostgreSQL row lock. Repeated completion requests do not reopen an earlier step. AI-run idempotency keys are scoped to their owner, session, operation, and step.
- Every 30 seconds, recovery checks pending runs older than `AI_JOB_RECOVERY_GRACE_MS` (default/minimum 120000 ms), in batches of 100. Missing or terminal BullMQ jobs become terminal `FAILED` runs so clients stop polling and can retry. Healthy waiting, prioritized, delayed, or active jobs are left alone. A Redis outage postpones recovery; it is not evidence that jobs are missing.
- Terminal runs and superseded worker attempts cannot publish late AI results. Recovery uses existing PostgreSQL/BullMQ state, not another queue. Restart the API/workers to activate it; no migration is required.
- Refresh-token rotation compares and replaces the token hash and updates the Redis session index in one Lua operation. Temporary Redis failures return 503 instead of invalidating authentication. These scripts use the existing single Redis instance, not Redis Cluster.
- Rate-limit exemptions match documentation/metrics paths only. Query-string text cannot disable throttling.
- `POST /v1/recommendations/:recommendationId/saved` accepts `{ "saved": true }` or `{ "saved": false }` for retry-safe state changes. A body without `saved` retains the legacy toggle behavior.

## API

Authentication routes:

| Method | Route                             | Purpose                                      |
| ------ | --------------------------------- | -------------------------------------------- |
| `POST` | `/auth`                           | Register and queue a verification email      |
| `POST` | `/auth/verify-email`              | Verify the six-character code                |
| `POST` | `/auth/resend-verification-email` | Queue a replacement code                     |
| `POST` | `/auth/login`                     | Return access token, refresh token, and user |
| `POST` | `/auth/refresh-token`             | Rotate the refresh token                     |
| `POST` | `/auth/logout`                    | Revoke the current session                   |
| `POST` | `/auth/logout-all`                | Revoke all user sessions                     |

Makeup routes require a bearer token:

| Method   | Route                                                              | Purpose                                            |
| -------- | ------------------------------------------------------------------ | -------------------------------------------------- |
| `POST`   | `/v1/sessions`                                                     | Create an owner-scoped session                     |
| `GET`    | `/v1/sessions?scope=active\|completed\|all`                        | List the user's sessions                           |
| `GET`    | `/v1/sessions/:sessionId`                                          | Read the full session aggregate                    |
| `DELETE` | `/v1/sessions/:sessionId`                                          | Delete a completed session                         |
| `POST`   | `/v1/sessions/:sessionId/images`                                   | Upload an initial face image                       |
| `GET`    | `/v1/images/:imageId/content`                                      | Read an owned private image                        |
| `GET`    | `/v1/images/:imageId/signed-url`                                   | 60-second signed download URL for an owned image   |
| `PATCH`  | `/v1/sessions/:sessionId/preferences`                              | Save preferences                                   |
| `POST`   | `/v1/sessions/:sessionId/analyze`                                  | Queue personalization analysis                     |
| `POST`   | `/v1/sessions/:sessionId/recommendations/:recommendationId/select` | Select a look and queue its guide                  |
| `POST`   | `/v1/recommendations/:recommendationId/saved`                      | Set saved state; legacy bodyless toggle supported   |
| `GET`    | `/v1/saved-recommendations`                                        | List saved recommendations                         |
| `POST`   | `/v1/guide-steps/:stepId/check`                                    | Queue a visual evaluation                          |
| `POST`   | `/v1/guide-steps/:stepId/snapshot`                                 | Save a step's final photo without an AI evaluation |
| `POST`   | `/v1/guide-steps/:stepId/questions`                                | Queue a contextual answer                          |
| `POST`   | `/v1/guide-steps/:stepId/complete`                                 | Advance the authoritative guide                    |
| `GET`    | `/v1/jobs/:runId`                                                  | Poll an asynchronous AI run                        |
| `GET`    | `/v1/profile/stats`                                                | Return persisted statistics                        |
| `GET`    | `/v1/profile`                                                      | Return the current user's profile                  |
| `POST`   | `/v1/profile/avatar`                                               | Upload or replace a private avatar                 |
| `GET`    | `/v1/profile/avatar/content`                                       | Read the current user's avatar                     |
| `GET`    | `/v1/profile/avatar/signed-url`                                    | 60-second signed download URL for the own avatar   |
| `DELETE` | `/v1/profile/avatar`                                               | Remove the current user's avatar                   |

Queueing mutations accept an `Idempotency-Key`. Every owned record is scoped with the JWT user ID; clients cannot supply another user's owner ID.

The image endpoint accepts `multipart/form-data` fields `image` and `purpose=INITIAL_ANALYSIS`. JPEG, PNG, and WebP files must be 10 MB or smaller and between 320 and 8192 pixels on each axis. The API derives this metadata from the actual bytes.

The avatar upload accepts a single `image` field. The mobile client crops and compresses it before upload; the API independently validates JPEG, PNG, or WebP content up to 5 MB and stores it under the authenticated user's private profile scope.

Private image reads require the same bearer token and verify ownership through the image's session. Completed-session deletion cascades through its guide, steps, attempts, questions, recommendations, and image metadata, then removes its private files. Active workflows cannot be deleted through the history endpoint.

Successful responses use one envelope:

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {}
}
```

### Subscriptions

Administration routes require a bearer token for an `ADMIN` or `SUPERADMIN` account; other roles, including `MODERATOR`, receive `403`. The role is read from the verified access token (no extra database lookup), so a role change applies once the user's access token is replaced or revoked through `tokenVersion`. Role names are the Prisma `userRole` values (`USER`, `MODERATOR`, `ADMIN`, `SUPERADMIN`); the TypeScript `UserRole` is derived from that enum.

| Method  | Route                         | Purpose                                |
| ------- | ----------------------------- | -------------------------------------- |
| `GET`   | `/v1/admin/subscription-plan` | Read the Pro plan configuration        |
| `PATCH` | `/v1/admin/subscription-plan` | Change any subset of the configuration |

MuseCue has a single Pro plan stored in the `SubscriptionPlan` table, so its settings survive restarts. Before an administrator saves anything, the API serves these defaults:

| Field                  | Type    | Default         | Accepted values                             |
| ---------------------- | ------- | --------------- | ------------------------------------------- |
| `planEnabled`          | boolean | `true`          | `true` / `false`                            |
| `monthlyPriceUsdCents` | integer | `1900` ($19)    | `1`–`999999` US cents                       |
| `yearlyPriceUsdCents`  | integer | `19000` ($190)  | `1`–`999999` US cents                       |
| `trialEnabled`         | boolean | `true`          | `true` / `false`                            |
| `trialDays`            | integer | `7`             | `1`–`365`; kept while the trial is disabled |

`PATCH` accepts any subset of these fields; omitted fields are unchanged. Empty bodies, `null`, fractional numbers, numeric or boolean strings, and unknown fields are rejected with `400`. The trial is switched off with `trialEnabled: false`, not with a zero length. Every change is recorded in `ActivityLogEvent` (old value, new value, administrator ID) in the same transaction as the plan update.

```json
{
  "code": "PRO",
  "currency": "USD",
  "planEnabled": true,
  "monthlyPriceUsdCents": 1900,
  "yearlyPriceUsdCents": 19000,
  "trialEnabled": true,
  "trialDays": 7,
  "updatedAt": null
}
```

Migration `20260912120000_plan_billing_intervals_and_toggles` upgrades configurations saved by `20260910120000_add_subscription_plan_config`: the former single `priceUsdCents` becomes the monthly price (or `1900` if it was never set), the yearly price starts at `19000`, and a former `trialDays: 0` becomes `trialEnabled: false` with `trialDays: 7`. Earlier audit entries keep the old `priceUsdCents` field name.

Each user has at most one `UserSubscription` record (migration `20260914120000_add_user_subscription`). A user without a record is `FREE`. The record tracks the one-time free trial (`trialUsed`, `trialStartedAt`, `trialExpiresAt`) separately from the renewable paid term (`billingInterval`, `proStartedAt`, `proExpiresAt`, `proCanceledAt`). Pro access is decided only in `src/subscription/subscription-access.policy.ts`, exposed through `SubscriptionAccessService`. Access is granted while the trial or the paid term is within its `[startedAt, expiresAt)` window, including a canceled term until it expires. The stored `status` (`FREE`, `TRIAL`, `PRO`, `EXPIRED`) is a snapshot and is not used on its own to grant access. A trial can be started only once, only while the plan and its trial are enabled, and never by a user with any paid Pro history (active, canceled or expired). Pro fields are never cleared, so `proStartedAt` serves as that history. CHECK constraints keep the record's fields and status consistent.

Subscription history is permanent at the database level (migration `20260916120000_protect_subscription_history`, a trigger that Prisma does not model). Once a trial has started, its dates never change and `trialUsed` stays `true`. A paid term can be renewed or replaced but never cleared, and the record cannot be deleted while its user exists; deleting the user still cascades. As a result, no code path can re-open trial eligibility or extend a trial.

Billing records for the future payment integration (migration `20260918120000_add_payments_and_subscription_events`; no checkout, webhooks or billing endpoints yet):

- `PaymentTransaction` records one charge attempt for one billing period. It stores the amount in cents, currency, status (`PENDING`, `SUCCEEDED`, `FAILED`, `PARTIALLY_REFUNDED`, `REFUNDED`), `provider` + `providerPaymentId`, the period, timestamps, and failure and refund details.
  - `(provider, providerPaymentId)` is unique, and only one verified payment may cover a given period.
  - Payments are never deleted. Amount, currency, provider IDs and period never change, and status only moves forward.
  - A user with payments cannot be hard-deleted.
- `SubscriptionEvent` is an append-only lifecycle log: `TRIAL_STARTED`, `CREATED`, `RENEWED`, `CANCELED`, `EXPIRED`. `CREATED` and `RENEWED` reference the `SUCCEEDED` payment for the period, and each payment backs at most one event.
- `UserSubscription` gains `paymentProvider` and `providerSubscriptionId` (unique together) to link the provider's recurring subscription.
- A paid term (`proStartedAt`/`proExpiresAt`) can only be created or extended by a `SUCCEEDED` payment of the same subscription and interval that covers the newly granted range and ends exactly at `proExpiresAt`. A new term may not start before its paid period, and a renewal's period must start no later than the current expiry, so it cannot bridge an unpaid gap. Early renewals and monthly-to-yearly changes may overlap. Pending, failed and refunded payments never grant or renew Pro access. Cancelling keeps access until `proExpiresAt`.
- A billing period ends exactly one calendar month or year after it starts, using PostgreSQL calendar arithmetic (migration `20260920120000_calendar_billing_periods_and_gap_free_terms`). Month-ends clamp: Jan 31 → Feb 28, or Feb 29 in a leap year. Feb 29 + 1 year → Feb 28. `src/subscription/billing.validation.ts` (`addBillingInterval`, `isValidBillingPeriod`, `getPaidTermRejection`, pricing and status-transition checks) applies the same rules for future checkout and webhook code.

`GET /v1/subscription` (bearer token) returns the caller's own subscription. The user comes only from the access token; query parameters cannot select another user. `status` is evaluated at request time from the stored dates, not the stored `status` column. Expiry therefore needs no background job, and reads never rewrite the record or its trial history.

| `status`  | When                                                                |
| --------- | ------------------------------------------------------------------- |
| `FREE`    | No trial and no paid term (including users without a record)      |
| `TRIAL`   | `trialStartedAt <= now < trialExpiresAt`                            |
| `PRO`     | `proStartedAt <= now < proExpiresAt` (also wins during a trial)     |
| `EXPIRED` | A trial or paid term existed and none is running (from the exact expiry instant) |

The response also contains `hasProAccess`, `accessSource`, `accessExpiresAt`, and two objects:

- `trial`: `eligible`, `ineligibleReason` (`ACCOUNT_INACTIVE`, `PLAN_DISABLED`, `TRIAL_DISABLED`, `TRIAL_ALREADY_USED`, `HAS_PRO_HISTORY`), `used`, `active`, `startedAt`, `expiresAt`.
- `pro`: `active`, `billingInterval`, `startedAt`, `expiresAt`, `canceledAt`.

`POST /v1/subscription/trial` (bearer token, no body) starts the caller's free trial. It stores `trialStartedAt` = now and `trialExpiresAt` = now + the plan's `trialDays`, and returns `201` with the access summary and trial dates. Rejections:

| Status | Message                                                                          |
| ------ | -------------------------------------------------------------------------------- |
| `403`  | `Only active accounts can start a free trial` (status `ACTIVE`, verified email, not soft-deleted) |
| `403`  | `The free trial is not currently available` (plan or trial disabled)             |
| `409`  | `The free trial has already been used`                                           |
| `409`  | `The free trial is only available to accounts that have never subscribed to Pro` |

Activation runs in one transaction: the account check, plan settings, trial write and audit event all succeed or fail together, so a failed activation never uses up the trial. Repeated or concurrent requests cannot create a second trial or change an existing trial's dates.

Pro feature endpoints are protected by `ProAccessGuard`, applied after `AuthGuard` in any module that imports `SubscriptionModule`:

```ts
@UseGuards(AuthGuard, ProAccessGuard)
@Get('some-pro-feature')
handler(@Req() req: ProAccessRequest) { /* req.proAccess: status, accessSource, accessExpiresAt */ }
```

The guard delegates to `SubscriptionAccessService`, the single Pro access decision. An active free trial and an active paid term unlock the same features, each within its own `[startedAt, expiresAt)` window. Without access, the guard returns `403` with `An active Pro subscription or free trial is required` and the handler does not run. Requests that did not pass `AuthGuard` are rejected with `401`, and lookup errors never grant access. No makeup endpoint uses the guard yet.

Database tests (`test/subscription-plan.*.e2e-spec.ts`, `test/user-subscription.*.e2e-spec.ts`, `test/subscription-trial.e2e-spec.ts`, `test/subscription-status.e2e-spec.ts`, `test/pro-access.e2e-spec.ts`, `test/trial-lifecycle.e2e-spec.ts`, `test/billing.e2e-spec.ts`, `test/subscription-security.e2e-spec.ts`) run only when `TEST_DATABASE_URL` is set, and are reported as skipped otherwise. Each test builds a temporary schema from the migration files and drops it afterwards, so the database user needs `CREATE` permission:

```bash
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/musecue_test npx jest --config ./test/jest-e2e.json test/subscription-plan test/user-subscription test/subscription-trial test/subscription-status test/pro-access test/trial-lifecycle test/billing test/subscription-security
```


## Domain

```text
authUser
|-- UserSubscription (0..1)
`-- MakeupSession
    |-- ImageAsset
    |-- MakeupPreferences
    |-- FaceAnalysis
    |-- Recommendation
    |-- AiRun
    `-- Guide
        `-- GuideStep
            |-- StepAttempt
            `-- Question
```

Mock and live gateways implement the same application-owned operations. The live gateway delegates transport to an OpenRouter provider adapter, workers validate and normalize model-shaped output, and NestJS alone persists it transactionally and advances workflow state. No frontend or public API contract changes are required to switch modes or add another provider adapter.

## Commands

```bash
npm run start:dev
npm run build
npm run lint
npm test
npx jest private-cloud   # private image storage unit tests
TEST_DATABASE_URL=... npx jest --config ./test/jest-e2e.json test/private-cloud   # storage workflows + cleanup ledger on PostgreSQL (mocked Supabase)
npm run test:e2e
npx prisma generate
npx prisma migrate dev
npx prisma migrate deploy
```
