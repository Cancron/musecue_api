# MuseCue API

**AI makeup guidance, made for your face.**

The MuseCue API is the NestJS authority for authentication, authorization, workflow state, persistence, and AI orchestration. Supabase Auth and Database are not used; Supabase Storage serves only as the server-side private image store. AI providers may interpret or generate data, but only NestJS validates results and advances application state.

The companion mobile application and detailed product specifications live in `../face_makeup_app`.

## Implemented

- PostgreSQL/Prisma local accounts, SMTP verification through the background email queue, login auditing, account lockout, and Google OAuth foundations
- short-lived JWT access tokens and rotating, revocable refresh tokens stored as hashes in PostgreSQL
- optional Redis: `REDIS_ENABLED=true` (default) uses BullMQ queues, Redis rate limiting and a Redis token-version cache; `REDIS_ENABLED=false` runs the same jobs and limits on PostgreSQL only (see "Infrastructure mode")
- owner-scoped makeup sessions and the documented workflow state machine
- validated multipart image upload, private object storage (a private Supabase Storage bucket by default, behind a provider interface), image metadata, structured preferences, face analysis, ranked recommendations, saved looks, and selection
- generated guides, authoritative step progression, retained visual attempts, contextual questions, completion history, profile statistics, and optional private profile avatars
- background jobs (BullMQ or PostgreSQL) for personalization, guide generation, visual checks, and guide questions
- `AiRun` audit records containing operation, provider, model, prompt version, latency, progress, result/error, and status
- a provider-neutral AI gateway with OpenRouter live mode, multimodal private-image input, strict structured output, runtime validation, bounded retries, and deterministic mock mode
- a single Pro subscription plan: admin-configured monthly/yearly pricing and free trial, one-time trial activation, date-based Pro access through `ProAccessGuard`, payment/lifecycle records protected by database rules, and Stripe checkout for the monthly and yearly options with webhook-verified activation, automatic renewals, failed-payment handling and recovery, cancellation at period end, and refunds made in Stripe with immediate access revocation (see "Subscriptions" and "Stripe checkout" under API); requesting refunds from MuseCue and disputes are not implemented yet
- personal data export: an authenticated user can request an asynchronous ZIP archive of their own account, profile, makeup history, subscription records and private photos, poll its status, and download it through a signed link valid for at most 15 minutes; archives expire 24 hours after export and are deleted by a scheduled retention sweep (see "Personal data export" under API)
- account deletion: the owner confirms their identity (password and an emailed code, or the code alone for accounts without a password), the account is blocked and every token invalidated at once (`PENDING_DELETION`), and a background sweep hard-deletes the account and all its data and files (including its refresh sessions, one-time codes and queued or retained background jobs), keeping payment records detached (see "Account deletion" under API)
- optional MFA with an authenticator app (TOTP): the signed-in owner starts an enrollment, confirms it with the app's current six-digit code within 10 minutes, and reads whether MFA is enabled; secrets are stored only encrypted, codes work only in their own 30 seconds and only once, and five incorrect codes within 15 minutes block enrollment for 15 minutes. Enabling MFA issues ten single-use recovery codes (shown once, stored only as salted scrypt hashes) that verify instead of the app's code, and can be regenerated with a second factor. Password and Google sign-in of an MFA user returns an MFA challenge instead of tokens, completed with the app's code or a recovery code; the device can then be trusted for 30 days (listed and revocable). MFA credentials use their own key (`MFA_ENCRYPTION_KEY`) and never depend on a JWT secret (see "Multi-factor authentication" under API)
- step-up authentication for sensitive actions (MFA enrollment, recovery codes, subscription cancellation, personal data export and download, account deletion): a ten-minute approval bound to the user, the sign-in session and the action, proven with an authenticator or recovery code (MFA users), the password (others) or a new Google sign-in (Google-only accounts); trusted devices never replace it (see "Step-up authentication" under API)

Migration `20260827174107_add_makeup_workflow` adds the makeup aggregate and removes the dormant job-tracker and subscription starter domains.

Intentionally deferred:

- signed URLs for avatars and for images still on the local filesystem (they keep using the authenticated content routes)
- copying images stored on the filesystem before the Supabase migration into the bucket (they remain readable through the `local` provider while its directory is present)
- additional S3-compatible storage providers (the provider interface is in place; see "Private image storage")
- generated preview images (recommendation reasoning is live, while the existing curated preview-image contract remains in place)
- production retention/deletion automation and AI cost accounting

## Requirements and setup

- Node.js 22+
- PostgreSQL 17 (always required)
- Redis 7+ (only with `REDIS_ENABLED=true`, the default)
- working SMTP credentials

### Check PostgreSQL and Redis on Ubuntu

Redis is only needed with `REDIS_ENABLED=true` (the default); with
`REDIS_ENABLED=false` skip the Redis checks below (see "Infrastructure mode").

Check whether the commands are installed:

```bash
psql --version
redis-server --version
```

Check the Ubuntu PostgreSQL clusters and whether the services are ready:

```bash
pg_lsclusters
pg_isready -h 127.0.0.1 -p 5432
redis-cli ping
```

PostgreSQL should report `accepting connections`, and Redis should return
`PONG`. If the packages are installed but stopped, start them with:

```bash
sudo pg_ctlcluster 17 main start
sudo systemctl start redis-server
```

On a system using `systemd`, service status is also available through:

```bash
systemctl status postgresql --no-pager
systemctl status redis-server --no-pager
```

### Install native services on Ubuntu

The repository setup script installs PostgreSQL 17 from the official
PostgreSQL APT repository, installs Redis, starts both services, and verifies
that they respond. It supports Ubuntu/Debian environments with `apt`; run it
from the repository root:

```bash
npm run setup:services
```

You can also invoke it directly:

```bash
bash scripts/setup-services.sh
```

The script may ask for the current user's `sudo` password. It installs and
starts the services, but intentionally does not create application roles or
databases.

### Create development and test databases

Create a local application role and two separate databases. `createuser`
prompts for the new role's password, which avoids putting it in shell history:

```bash
sudo -u postgres createuser --pwprompt musecue
sudo -u postgres createdb --owner=musecue musecue
sudo -u postgres createdb --owner=musecue musecue_test
```

If the `musecue` role or either database already exists, do not recreate it.
Use the PostgreSQL administrator account to inspect them instead:

```bash
sudo -u postgres psql -c '\du musecue'
sudo -u postgres psql -c '\l musecue'
sudo -u postgres psql -c '\l musecue_test'
```

For native services, update `.env` to use port `5432` and the password chosen
above. URL-encode the password if it contains reserved URL characters:

```dotenv
DATABASE_URL=postgresql://musecue:replace-with-local-password@127.0.0.1:5432/musecue
TEST_DATABASE_URL=postgresql://musecue:replace-with-local-password@127.0.0.1:5432/musecue_test
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=
```

The native Redis installation created by the script has no password by
default. Configure Redis authentication before exposing it outside a trusted
local development environment.

Apply migrations only to the development database:

```bash
npx prisma migrate deploy
```

The PostgreSQL-backed E2E tests create and drop temporary schemas inside
`musecue_test`; they do not use or reset the development database. Export the
test URL before running Jest because the E2E helper reads
`TEST_DATABASE_URL` from the process environment:

```bash
export TEST_DATABASE_URL='postgresql://musecue:replace-with-local-password@127.0.0.1:5432/musecue_test'
npm run test:e2e -- --runInBand
```

The `musecue` role owns `musecue_test`, so it has the `CREATE` permission the
tests need for their temporary schemas.

### Docker setup

The example environment uses Docker PostgreSQL on host port `5433`, unlike
the native Ubuntu service on port `5432`:

```bash
cp .env.example .env
docker compose up -d postgres_db redis-stack
npm install
npx prisma migrate deploy
npm run start:dev
```

Without Redis, set `REDIS_ENABLED=false` in `.env` (and keep
`JWT_REFRESH_SECRET` set) and start only PostgreSQL:

```bash
docker compose up -d postgres_db
```

The API defaults to `http://localhost:5000`; development Swagger is at `http://localhost:5000/docs`.

Important environment variables are documented in `.env.example`. Never commit the real `.env` or log SMTP credentials, tokens, image contents, or future signed URLs.

### Infrastructure mode (`REDIS_ENABLED`)

One setting selects the infrastructure drivers when the API starts. PostgreSQL
is required in both modes; Redis only with `REDIS_ENABLED=true`.

| | `REDIS_ENABLED=true` (default) | `REDIS_ENABLED=false` |
| --- | --- | --- |
| Background jobs (email, makeup AI, privacy exports) | BullMQ on Redis | `InfrastructureJob` table, worker inside the API process |
| Request throttling and auth rate limits | Redis | `RateLimitBucket` table |
| Token-version cache (AuthGuard) | Redis | none: the database is read on every request |
| Refresh sessions, email/deletion codes, OAuth states | PostgreSQL | PostgreSQL |
| Redis connection | yes | none (no client is created; `REDIS_*` is ignored) |

- An omitted or empty `REDIS_ENABLED` means `true`, so existing deployments
  keep Redis. Any value other than `true` or `false` (surrounding whitespace
  is ignored) stops the API at startup. The selection never changes while the API runs: there is no
  automatic fallback from one driver to the other.
- Startup logs the selected drivers once, for example
  `REDIS_ENABLED=false: queue driver postgres, rate-limit driver postgres, token-version cache none (no Redis connection)`.
  No credentials are logged.
- HTTP routes, request DTOs and response contracts are identical in both
  modes. Job retries, priorities, backlog limits and route rate limits are
  the same: email 3 attempts with exponential backoff from 2 seconds; makeup
  AI 3 attempts with the existing priorities, jittered backoff from 3 seconds,
  `AI_QUEUE_GLOBAL_CONCURRENCY` and `AI_QUEUE_RATE_LIMIT_*`; privacy exports
  3 attempts with backoff from 15 seconds.
- `REDIS_ENABLED=false` supports **one API instance**: the worker runs inside
  it, and the AI concurrency and rate limits are enforced in that process.
  Scale out only with Redis.
- `REDIS_ENABLED=false` requires `JWT_REFRESH_SECRET`. Job payloads are
  encrypted with AES-256-GCM under a key derived from it (as are OAuth
  states; one-time codes and rate-limit keys are stored as keyed hashes).
  Rotating the secret makes pending PostgreSQL jobs, outstanding codes and
  OAuth states unusable (interrupted jobs fail their export or AI run, which
  the user can retry). MFA credentials do not depend on it: authenticator
  secrets use `MFA_ENCRYPTION_KEY` and recovery codes are keyless scrypt
  hashes (see "Multi-factor authentication").
- The PostgreSQL worker starts with the API in every environment, including
  `NODE_ENV=test`, exactly like the BullMQ workers in Redis mode: queued jobs
  are never left unprocessed because of the environment name.

#### How the PostgreSQL queue works

- **Polling and leases.** The worker polls every second (cycles never
  overlap), leases due jobs (highest priority first, i.e. the lowest number)
  with a 120-second lease renewed every 30 seconds, and runs them with the
  same job handlers as the BullMQ processors. Concurrency and rate limits are
  per queue: email 1, privacy exports 2, makeup AI
  `AI_QUEUE_GLOBAL_CONCURRENCY` (at most 8) and `AI_QUEUE_RATE_LIMIT_MAX`
  starts per `AI_QUEUE_RATE_LIMIT_DURATION_MS`.
- **Deduplication and backpressure.** The jobs of an AI run or export are
  keyed by its ID, so a retried request never creates a second job. Backlog
  limits (`AI_QUEUE_MAX_BACKLOG`, `PRIVACY_EXPORT_MAX_BACKLOG`) count waiting
  and running jobs, as with BullMQ.
- **Retries.** A failed attempt is retried after its backoff; after the last
  attempt the job is `FAILED` and the handler has already failed its AI run,
  export or email record. A provider `429` postpones the makeup job without
  using an attempt and pauses that queue for the requested delay.
- **Interruptions.** On shutdown (SIGTERM) running jobs get five seconds to
  finish and are then handed back without using an attempt. If the process
  dies instead, the job's lease expires after at most 120 seconds: the
  interrupted attempt counts, the job is retried after its backoff, and after
  its last attempt it fails together with its AI run or export.
- **Retention.** Completed jobs are removed after an hour (their payload is
  cleared at once); failed jobs are kept for seven days for diagnosis, with
  the encrypted payload and only the error class and code (never a message).
  Jobs carrying a one-time code are deleted as soon as they finish.
- **Ownership and account deletion.** Every job is recorded with the account
  it belongs to (`InfrastructureJob.authId`: verification, welcome and
  deletion-code emails, AI runs, exports). Erasing an account deletes all of
  its jobs, waiting, running or retained, through a cascading foreign key:
  nothing is sent to an erased address and no payload of it is kept. A job
  that is already running when its account is erased may finish, but nothing
  about it is recorded afterwards, and no new job can be added for an account
  that no longer exists.

#### Operating the PostgreSQL queue

Jobs are rows of `InfrastructureJob` (payloads are encrypted; never try to
read or edit them). Useful read-only queries:

```sql
-- Pending and running work per queue (the backlog)
SELECT queue, status, count(*) FROM "InfrastructureJob"
WHERE status IN ('WAITING', 'ACTIVE') GROUP BY queue, status;

-- Recent failures (error class and code only)
SELECT queue, name, "jobKey", "attemptsMade", "lastError", "finishedAt"
FROM "InfrastructureJob" WHERE status = 'FAILED'
ORDER BY "finishedAt" DESC LIMIT 50;
```

A failed AI run or export is retried by the user (a new request creates a new
job); failed jobs are not re-run automatically. Rate-limit counters are rows of
`RateLimitBucket` (keyed by HMAC only) and expired ones are removed every five
minutes.

#### Rollout and switching drivers

Two migrations belong to this feature:

- `20261120120000_optional_redis_infrastructure` moves authentication
  security state to PostgreSQL and adds the PostgreSQL queue and rate-limit
  tables and `AiRun.jobInput`. It increments every user's token version:
  **every user has to sign in again**, and verification, deletion and OAuth
  codes issued before the migration no longer work (users request new ones).
- `20261121120000_infrastructure_job_owner` adds the job owner
  (`InfrastructureJob.authId`, deleted with the account). Jobs queued before
  it keep running without an owner.

Neither changes payment, subscription or other existing data, and both apply
to fresh and populated databases.

1. Deploy this version with `REDIS_ENABLED=true` (or unset) and run
   `npx prisma migrate deploy`. BullMQ keeps processing the jobs queued before
   the deployment.
2. Let BullMQ drain: no waiting, delayed or active jobs remain in the
   `email`, `makeup-ai` and `privacy-export` queues.
3. Set `REDIS_ENABLED=false` and restart the API. Redis can then be removed.

Changing drivers in either direction is a maintenance operation: do not switch
while the current queue still contains jobs, because jobs left in the other
driver are not run. The recovery sweeps fail AI runs and exports whose jobs
were left behind after their grace period, so clients stop polling. With
`REDIS_ENABLED=true`, startup warns when PostgreSQL jobs from a previous
`false` run are still pending.

#### Testing both modes

`npm test` needs neither PostgreSQL nor Redis. The PostgreSQL-backed e2e tests
need `TEST_DATABASE_URL`; the Redis ones additionally need a real Redis in
`TEST_REDIS_URL` (they are reported as skipped without it). Redis tests use a
unique key prefix per run and remove their keys afterwards.

```bash
# PostgreSQL-only mode, with Redis stopped or unreachable
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/musecue_test \
  REDIS_ENABLED=false npm run test:e2e -- --runInBand

# Redis mode against a real Redis, plus everything above
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/musecue_test \
  TEST_REDIS_URL=redis://127.0.0.1:6379 \
  REDIS_ENABLED=true npm run test:e2e -- --runInBand
```

Each mode-specific suite sets `REDIS_ENABLED` itself, so the variable on the
command line only documents the intent; `TEST_REDIS_URL` decides whether the
Redis suites run. The suites for this feature:

| Suite | Covers |
| --- | --- |
| `test/postgres-mode.e2e-spec.ts` | The whole app with `REDIS_ENABLED=false` and Redis unreachable: registration and email verification, login, refresh rotation (incl. concurrent reuse), logout-all, the makeup AI workflow, a privacy export and its download, route rate limits, account deletion over HTTP (sessions, codes and jobs removed); asserts that Redis was never contacted |
| `test/redis-mode.e2e-spec.ts` | The same flows with `REDIS_ENABLED=true` on BullMQ and a real Redis |
| `test/postgres-job-queue.e2e-spec.ts` | The PostgreSQL queue driver: encryption, priority, deduplication, retries and backoff, terminal failure, rate-limit deferral, lease renewal and recovery, retention, job ownership and the account-deletion cascade |
| `test/rate-limit-contract.e2e-spec.ts` | The same rate-limit scenarios against the PostgreSQL and Redis drivers (storage, HTTP 429 response, authentication limits) |
| `test/auth-state.e2e-spec.ts` | Refresh sessions, one-time codes and OAuth states in PostgreSQL, and both migrations on existing data |

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

How failures during deletion are handled:

- **Provider crash or timeout.** After the first transient failure for a provider, the remaining deletions for that provider are left queued (`PENDING`, due) instead of each waiting for a timeout. A session with many images therefore costs one timeout, not one per image, and the cleaner keeps serving other providers in the same pass.
- **Database failure.**
  - The reference change and its deletion records commit together, or neither does.
  - If the object was deleted but its row could not be removed, the row is retried after its lease; the delete is idempotent.
  - If a failed deletion could not be recorded, it is retried after the lease and recorded then.
- **Process crash.** At each point (after the commit, after claiming a row, after the provider deleted the object) the row stays in the table, and any instance completes it after the 5-minute lease.
- **Repeats and concurrency.**
  - Every cleaner write is fenced on its own claim (`lastAttemptAt`). A stale or slow cleaner can never remove a row that a newer request has re-recorded.
  - Recording a deletion for an object that already has a row re-arms that row (pending, due now, attempts reset) instead of silently skipping it.
  - Each object is deleted once, however often requests or recovery run.
- **Other users' files.** Deletions are recorded only for keys inside the requesting user's own folder (`<userId>/...`). A corrupted reference into another user's folder is refused and logged, never queued.

Every row keeps the `provider` and `storageKey` needed for recovery until the provider confirms the deletion.

To inspect or recover:

```sql
SELECT id, provider, "storageKey", reason, status, attempts, "lastErrorCode", "nextAttemptAt"
FROM "PrivateStorageCleanup" ORDER BY "createdAt";

-- After fixing the cause (credentials, bucket, provider outage), requeue failed rows:
UPDATE "PrivateStorageCleanup"
SET status = 'PENDING', attempts = 0, "nextAttemptAt" = now(), "lastAttemptAt" = NULL
WHERE status = 'FAILED';
```

The same recovery is available in code as `PrivateImageLifecycleService.requeueFailedDeletions({ provider?, ids? })`. It only touches `FAILED` rows, keeps provider, key, reason and last error, and is safe to run repeatedly or while the cleaner runs. No HTTP endpoint is exposed for it.

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

Private storage keys always use `/` (for example `<authId>/<sessionId>/<uuid>.jpg`) on every operating system; only the resolved filesystem path uses the platform separator. Keys containing `\`, `.`/`..` or empty segments are rejected, so the same stored keys work on Linux, macOS and Windows.

`PRIVATE_EXPORT_DIR` holds generated personal data export archives and defaults to `.data/private-exports`. It follows the same private convention (`<authId>/<exportId>/<uuid>.zip`, owner-only file permissions) but is a separate root because archives have their own retention lifecycle.

### Live AI with OpenRouter

The backend defaults to live AI outside the test environment. Create a fresh OpenRouter key and add it only to the ignored `.env` file:

```dotenv
AI_MODE=live
OPENROUTER_API_KEY=your-new-key
OPENROUTER_MODEL=openrouter/free
```

Restart the API and BullMQ worker after changing environment variables. Use `AI_MODE=mock` for deterministic offline development. The optional analysis, guide, vision, and question model variables allow each operation to be routed independently without changing services or mobile API contracts.

Initial analysis and makeup checks load owned images through the same code path as `GET /v1/images/:id/content` (`loadOwnedPrivateImage`). It looks the image up scoped to its owner, then reads the original bytes through the storage provider and key stored on the image, just as the filesystem adapter used to be read, and checks them against the stored type. The worker calls that code path directly rather than the HTTP endpoint, because it holds no user access token.

Before anything is sent to OpenRouter, **every** image is normalized, whatever its size:
- decoded with the same 8192 × 8192 limit as uploads
- turned upright from its EXIF orientation
- resized to fit `OPENROUTER_IMAGE_MAX_EDGE`
- flattened onto white and re-encoded as JPEG, which removes all metadata (EXIF location, device, XMP)
- reduced a few times if still over `OPENROUTER_IMAGE_MAX_BYTES`

Only those bytes are embedded as a `data:` URL; no storage URL, key, bucket or credential is ever part of the request. An undecodable image fails with `AI_IMAGE_INVALID` and an image that cannot be made small enough with `AI_IMAGE_TOO_LARGE`. Both are non-retryable and OpenRouter is not contacted. Previously an undecodable image was reported as a retryable "Unable to reach OpenRouter".

When the worker cannot load an image, the run stores only a generic message and never names the provider, bucket or key:
- **Missing image or record:** fails immediately with "The photo for this request is no longer available. Please upload it again."
- **Storage timeout or outage:** retried within the job's retry budget.
- **Rejected credentials, unknown provider, or an object that is not the recorded image:** fails with "Your photo could not be loaded right now. Please try again."

Images are never exposed through permanent public URLs. Structured responses are validated again by Zod before any transaction changes workflow state. Provider timeouts, rate limits, and server failures use the existing BullMQ job retry budget; invalid credentials and other non-retryable requests fail immediately.

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

The makeup worker processes I/O-bound AI jobs concurrently, while global concurrency and rate limits cap aggregate OpenRouter traffic (Redis-backed across every running API instance, or enforced in the single API process with `REDIS_ENABLED=false`). Interactive vision checks and coach questions receive higher queue priority than initial analysis and guide generation. A short provider `429` pauses the shared queue only for its requested delay and may defer a job twice. Multi-hour quota exhaustion fails immediately so jobs reach a terminal state instead of freezing the queue. Other transient failures use the three-attempt exponential backoff budget with jitter.

Defaults are conservative for development:

```dotenv
AI_QUEUE_GLOBAL_CONCURRENCY=4
AI_QUEUE_RATE_LIMIT_MAX=15
AI_QUEUE_RATE_LIMIT_DURATION_MS=60000
AI_QUEUE_MAX_BACKLOG=1000
AI_QUEUE_MAX_PROVIDER_PAUSE_MS=120000
AI_QUEUE_MAX_RATE_LIMIT_DEFERRALS=2
```

Increase these only after pinning production models and matching the limits on your OpenRouter account. With Redis, multiple backend instances can consume the same queue and the limits remain global. New jobs receive a service-unavailable response once the configurable backlog ceiling is reached instead of growing an unbounded queue. `OPENROUTER_FALLBACK_MODELS` can provide comma-separated capacity fallbacks, and `OPENROUTER_PROVIDER_SORT=throughput` can favor faster providers. Large stored images are resized and JPEG-compressed in memory before provider delivery, while already-small mobile images pass through unchanged.

The free router is intended for development and cannot provide bulk-production capacity. Paid models, explicit account spending caps, production observability, and load testing are required before a public launch.

### Workflow and authentication reliability

- Session writes and AI result publication share a PostgreSQL row lock. Repeated completion requests do not reopen an earlier step. AI-run idempotency keys are scoped to their owner, session, operation, and step.
- Every 30 seconds, recovery checks pending runs older than `AI_JOB_RECOVERY_GRACE_MS` (default/minimum 120000 ms), in batches of 100. Missing or terminal jobs of the selected queue driver become terminal `FAILED` runs so clients stop polling and can retry. Healthy waiting, prioritized, delayed, or active jobs are left alone. A queue outage postpones recovery; it is not evidence that jobs are missing.
- Terminal runs and superseded worker attempts cannot publish late AI results. Recovery uses existing PostgreSQL/queue state, not another queue.
- Each AI run records its operation input (`AiRun.jobInput`, e.g. the photo of a visual check or the question) when it is created; it is immutable and never returned by the API, so workers do not depend on the queue payload.
- Refresh-token rotation revokes the presented session and stores its replacement in one PostgreSQL transaction: of concurrent requests with the same token exactly one succeeds. A reused token is rejected without revoking the winner or other devices; a token whose hash does not match revokes every session of the user. Logins take a per-user advisory lock (a concurrent login of the same user gets 409) and revoke the oldest sessions beyond five devices in the same transaction. Temporary database failures return 503 instead of invalidating authentication.
- Email verification and account deletion codes are stored as purpose-bound HMACs, allow five checks, expire and work once. OAuth states are single-use and expire after ten minutes. Expired authentication rows are removed hourly.
- Rate-limit exemptions match documentation/metrics paths only. Query-string text cannot disable throttling.
- `POST /v1/recommendations/:recommendationId/saved` accepts `{ "saved": true }` or `{ "saved": false }` for retry-safe state changes. A body without `saved` retains the legacy toggle behavior.

## API

Authentication routes:

| Method | Route                             | Purpose                                      |
| ------ | --------------------------------- | -------------------------------------------- |
| `POST` | `/auth`                           | Register and queue a verification email      |
| `POST` | `/auth/verify-email`              | Verify the six-character code                |
| `POST` | `/auth/resend-verification-email` | Queue a replacement code                     |
| `POST` | `/auth/login`                     | Return access token, refresh token, and user; an MFA challenge instead for users with MFA |
| `POST` | `/auth/login/mfa`                 | Complete the MFA challenge (app code or recovery code); optionally trust the device |
| `POST` | `/auth/refresh-token`             | Rotate the refresh token                     |
| `POST` | `/auth/logout`                    | Revoke the current session                   |
| `POST` | `/auth/logout-all`                | Revoke all user sessions                     |
| `GET`  | `/auth/mfa`                       | Whether MFA is enabled; enrollment state (bearer token) |
| `POST` | `/auth/mfa/enrollment`            | Start an authenticator-app enrollment (bearer token, step-up `MFA_ENROLLMENT`) |
| `POST` | `/auth/mfa/enrollment/confirm`    | Confirm it with a six-digit code and enable MFA; shows the recovery codes once (bearer token) |
| `POST` | `/auth/mfa/verify`                | Verify a second factor: app code or recovery code (bearer token) |
| `POST` | `/auth/mfa/recovery-codes`        | Replace all recovery codes; shows them once (bearer token, step-up `MFA_RECOVERY_CODES`) |
| `GET`  | `/auth/step-up`                   | How this account steps up (`mfa`, `password`, `google`) (bearer token) |
| `POST` | `/auth/step-up`                   | Approve a sensitive action with a code or the password (bearer token) |
| `POST` | `/auth/step-up/google`            | Start a Google reauthentication (Google-only accounts) (bearer token) |
| `POST` | `/auth/step-up/google/callback`   | Complete it with Google's `code` and `state` (bearer token, same session) |
| `GET`  | `/auth/mfa/trusted-devices`       | List the devices trusted to skip MFA (bearer token) |
| `DELETE` | `/auth/mfa/trusted-devices/:deviceId` | Revoke one of them (bearer token) |

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

Private image reads require the same bearer token and verify ownership through the image's session.

`GET /v1/images/:imageId/content` returns the original bytes exactly as stored. `Content-Type` is the type validated and recorded at upload, and it is checked against the bytes' own format signature. A provider answer that is not that image (a corrupted object, an error page, a different file) is never served; it becomes `500 Image storage is unavailable`. `Content-Length` is set.

Every response from this route, including errors, carries `Cache-Control: private, no-store, max-age=0`, `Pragma: no-cache`, `Expires: 0`, `Vary: Authorization` and `X-Content-Type-Options: nosniff`, so no proxy, CDN or client cache keeps private images. No ETag or cookie is sent, and no header reveals the storage provider.

The mobile app authenticates exactly as for every other route: `Authorization: Bearer <access token>` (React Native / Expo image components accept request headers). Tokens in the URL are never accepted. An expired token answers a JSON `401` (`Token has expired`), so the app can refresh through `POST /auth/refresh-token` and retry. Image components that cannot send headers should use the 60-second signed URL from `GET /v1/images/:imageId/signed-url` instead.

Responses:
- `404 Image not found` for a missing image *or another user's image* (they are indistinguishable).
- `404 Image content is unavailable` for a missing object or a non-uploaded image.
- `503` for storage timeouts or outages.
- `500` for misconfiguration or an integrity failure.

None of these name the provider. Completed-session deletion cascades through its guide, steps, attempts, questions, recommendations, and image metadata, then removes its private files. Active workflows cannot be deleted through the history endpoint.

Successful responses use one envelope:

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {}
}
```

### Multi-factor authentication

Optional MFA with an authenticator app (TOTP, RFC 6238: HMAC-SHA-1, six digits, 30-second periods), for example Google Authenticator, 1Password or Authy, with single-use recovery codes. All MFA routes require a bearer token and always act on the token's user: no route accepts a user ID, start takes no body, the others accept only their documented fields, and unknown fields are rejected with `400`.

1. `POST /auth/mfa/enrollment` (`201`) starts an enrollment and returns, only in this response (`Cache-Control: no-store`), a new 160-bit secret for manual entry and its `otpauth://` URI for a QR code:

   ```json
   {
     "secret": "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
     "otpauthUrl": "otpauth://totp/MuseCue:ann%40example.com?secret=...&issuer=MuseCue&algorithm=SHA1&digits=6&period=30",
     "issuer": "MuseCue", "algorithm": "SHA1", "digits": 6, "period": 30,
     "expiresAt": "2026-11-22T12:10:00.000Z"
   }
   ```

   The enrollment stays active until it is confirmed, for at most 10 minutes. Starting again replaces the secret and restarts the 10 minutes.
2. `POST /auth/mfa/enrollment/confirm` with `{ "code": "123456" }` (`200`) enables MFA and returns the status below plus `"recoveryCodes": ["ABCDE-FGHJK", ...]` (ten codes). This is the only time they are shown (`Cache-Control: no-store`); see "Recovery codes".
3. `GET /auth/mfa` (`200`) reports the status:

   ```json
   {
     "enabled": false,
     "method": null,
     "recoveryCodesRemaining": null,
     "enrollment": { "status": "PENDING", "expiresAt": "2026-11-22T12:10:00.000Z", "blockedUntil": null, "remainingAttempts": 5 }
   }
   ```

   `enrollment.status` is `NONE`, `PENDING`, `EXPIRED` (start again) or `BLOCKED` (until `blockedUntil`). Once MFA is enabled: `enabled: true`, `method: "totp"`, status `NONE`, and `recoveryCodesRemaining` is the number of unused recovery codes (never the codes).

Rules:

- **Codes:** a code is accepted only during its own 30-second period (no tolerance for a phone clock that is off; see below) and only once. A code for an earlier period (expired), a later period or another secret is rejected. Malformed codes (not exactly six digits) fail validation with `400` and are not counted.
- **Responses:** invalid or expired code: `400 Invalid or expired authenticator code. N attempt(s) remaining.`; enrollment older than 10 minutes: `410` (its secret is discarded); no enrollment in progress: `409`; MFA already enabled (including a replay of the code that enabled it): `409`; blocked: `429` with the end of the block in the message; database or key failure: `503`, never reported as a wrong code.
- **Lockout:** five incorrect codes within any 15 minutes (a sliding window) block the enrollment for 15 minutes from the fifth. While it is blocked, starting and confirming both answer `429`, even with a correct code, and nothing extends the block. The pending secret is discarded. Restarting an enrollment never resets the count. The lockout is per account and only affects MFA enrollment, not sign-in.
- **Storage:** the pending secret (`MfaEnrollment.secret`) and the confirmed secret (`authSecurity.mfaSecret`) are encrypted with AES-256-GCM under the dedicated `MFA_ENCRYPTION_KEY` (see "MFA keys"; never a JWT secret). Each ciphertext names its key and is bound to its user and role, so it cannot be copied to another account. Confirming sets `authSecurity.mfaEnabled = true`, `mfaMethod = totp`, re-encrypts the secret into `mfaSecret`, records the accepted period in `mfaLastUsedStep` (replay protection for later checks) and deletes the enrollment, in one transaction. Starting and confirming take a per-user advisory lock, so of concurrent confirmations with the same code exactly one succeeds. The change is written to `ActivityLogEvent` (never the secret). Secrets and codes are never logged.
- **Cleanup:** the hourly authentication sweep discards expired pending secrets and removes enrollment rows once their failures and block are over. Account erasure deletes the enrollment with the account.

#### Recovery codes and MFA verification

Enabling MFA issues ten recovery codes such as `K7MPQ-3XWNR`: 10 characters from a 31-character alphabet without look-alikes (no `0/O`, `1/I/L`), about 49.5 bits each, all distinct. Each code can be used once instead of the authenticator code.

- `POST /auth/mfa/verify` (`200`) verifies a second factor of the signed-in user. The body holds exactly one of `{ "code": "123456" }` (the app's current code) or `{ "recoveryCode": "K7MPQ-3XWNR" }` (case and the hyphen do not matter). Neither, both, or a malformed value is a `400` validation error and is not counted. The response is `{ "verified": true, "method": "totp" | "recovery_code", "recoveryCodesRemaining": 9 }`.
- `POST /auth/mfa/recovery-codes` (`201`, no body) needs a step-up approval for `MFA_RECOVERY_CODES` (which for an MFA user is an app code or a recovery code; see "Step-up authentication"). It replaces **all** previous codes (used or not) with ten new ones in one transaction and shows them once (`{ "recoveryCodes": [...], "recoveryCodesRemaining": 10 }`, `Cache-Control: no-store`). Without an approval it answers `403` and nothing changes. Users who enabled MFA before recovery codes existed use this route to get their first codes.

Rules:

- **Shown once, never logged:** codes appear only in the response that issues them (enrollment confirmation or regeneration). Status, verification and every other response carry only a count. Codes, like secrets, are never logged or written to the audit log.
- **Storage:** only `MfaRecoveryCode.codeHash` is stored: a salted scrypt hash (`scrypt$14$8$1$<salt>$<hash>`: N = 2^14, r = 8, p = 1, a 16-byte random salt per code) over the user ID and the normalized code. It is one-way and uses no key, so no configuration change (JWT or MFA key rotation) can ever affect recovery codes; equal codes never give equal hashes, and a hash only verifies for its own user. The database accepts only this format (CHECK), so plaintext can never be stored. Verifying compares the input with each of the user's unused codes (at most ten, asynchronously, without stopping at the first match).
- **One use, recorded in PostgreSQL:** the matching code is consumed by one conditional `UPDATE ... SET "usedAt" = now WHERE "id" = code AND "authId" = user AND "usedAt" IS NULL`. Of concurrent requests with the same code exactly one succeeds, and using one code never touches the others. A trigger makes consumption permanent: a used code can never be reset, and no code can move to another user. Each use is audited as a count (`mfaRecoveryCodesRemaining`: 10 → 9).
- **Declined alike:** wrong, already used, replaced (after regeneration) and other users' codes, as well as used or expired app codes, all answer `400 Invalid MFA code. N attempt(s) remaining.` App codes are checked like at enrollment (their own 30 seconds only) and each is accepted once (`mfaLastUsedStep`, including the code that enabled MFA).
- **Lockout:** five declined codes within any 15 minutes block verification and regeneration for 15 minutes (`429`). During the block a valid code is refused and not consumed. A success clears the count. This is separate from the enrollment lockout. Note that duplicate submissions of one code count: the first succeeds, and each repeat is declined and counted.
- **Concurrency:** verification takes the same per-user advisory lock as enrollment. Single use would hold without it (the conditional `UPDATE`), but the lock keeps the failure count exact when wrong codes arrive in parallel, so the lockout cannot be raced.
- `409` when MFA is not enabled. `503` for database or key failures, never reported as a wrong code.

Tests:

#### MFA at sign-in

Users without MFA sign in exactly as before (`POST /auth/login` and the Google callbacks return tokens; responses now also carry `"mfaRequired": false`). For a user with MFA enabled, a correct first factor (password, or Google) returns **no tokens**, only a challenge:

```json
{ "mfaRequired": true, "challengeToken": "mfac_...", "expiresAt": "2026-11-24T09:05:00.000Z", "methods": ["totp", "recovery_code"] }
```

`POST /auth/login/mfa` completes it (`200`, `Cache-Control: no-store`):

```json
{ "challengeToken": "mfac_...", "code": "123456", "trustDevice": true, "deviceName": "Ann's iPhone" }
```

with exactly one of `code` (the app's current code) or `recoveryCode`; `trustDevice` and `deviceName` (1-100 characters) are optional. The response is a regular login response (`accessToken`, `refreshToken`, `user`, `expiresIn`, `mfaRequired: false`) plus `mfaMethod` and `trustedDevice` (`null`, or `{ id, token, name, expiresAt }` when the device was trusted; the token is shown only here).

- **No access before MFA:** the challenge token is an opaque random value (`mfac_` + 256 bits), not a JWT. It is refused as a bearer token (`401`), as a refresh token (`400`, not a JWT) and everywhere except `POST /auth/login/mfa`. No refresh session exists until MFA succeeds.
- **Challenge rules:** stored only as a SHA-256 hash (`MfaLoginChallenge`), valid for 5 minutes, consumed by the first successful completion (a per-user advisory lock serializes completions: of concurrent completions exactly one succeeds, and the others' codes are not consumed).
- **All or nothing:** the challenge, the code (recovery code or authenticator step), the trusted device and the new refresh session are written in **one transaction**. If the session cannot be stored (database error: `503`; a concurrent sign-in of the same user: `409`), nothing is consumed: the same challenge and the same code complete the sign-in on retry (within the challenge's five minutes). The login history records the sign-in only after it committed. An unknown, used or expired challenge answers `401 The MFA challenge is invalid or has expired. Please sign in again.` A wrong code answers `400` and leaves the challenge usable. Codes are checked exactly like `POST /auth/mfa/verify`, with the same replay protection and the same 5-in-15-minutes lockout (`429`), and only against the challenge owner's credentials: another user's app or recovery code never completes it.
- **Google:** the callbacks return the same challenge (`message: "MFA verification required"`). The browser redirect flow redirects to `redirectUrl` with `mfa_required=true`, `mfa_challenge_token` and `mfa_challenge_expires_at` instead of tokens. The challenge records `provider: google`.
- **Trusted devices:** with `trustDevice: true`, the device gets a token (`mfatd_` + 256 bits) that skips the challenge for **30 days** (fixed; never extended). Send it as the `X-MFA-Trusted-Device` header on `POST /auth/login`, `POST /auth/google/callback`, or `GET /auth/google` (for the browser flow: only its SHA-256 travels in the encrypted OAuth state). It skips only the second factor, never the password or Google, and only for the user it was issued to: an expired, revoked, unknown or other user's token is ignored and the challenge is issued. Devices are stored in PostgreSQL (`MfaTrustedDevice`: SHA-256 of the token, owner, name, IP, user agent, creation, last use, expiry, revocation); a user has at most 10 active ones (the oldest is revoked). A database CHECK limits trust to 30 days and a trigger keeps owner, token and expiry unchangeable and makes a revocation permanent.
- `GET /auth/mfa/trusted-devices` lists the caller's active devices (`id`, `name`, `ipAddress`, `createdAt`, `lastUsedAt`, `expiresAt`, `current`: the device whose `X-MFA-Trusted-Device` header came with the request). Tokens are never returned again. `DELETE /auth/mfa/trusted-devices/:deviceId` revokes one (`{ "id": ..., "revoked": true }`); another user's device, or an unknown one, answers `404`.
- Expired or consumed challenges and expired or revoked devices are removed by the hourly authentication sweep; everything is deleted with the account.

#### MFA keys and upgrading

MFA never depends on `JWT_ACCESS_SECRET` or `JWT_REFRESH_SECRET`, so rotating them never locks anyone out of MFA.

- `MFA_ENCRYPTION_KEY` (required for MFA): 32 random bytes as base64 or 64 hex characters (`openssl rand -base64 32`). It encrypts authenticator secrets. The API refuses to start with an invalid value or one equal to a JWT secret. Without it, enrolling and authenticator codes answer `503`, while recovery codes, challenges and trusted devices keep working. Treat it like the database credentials: losing it makes every authenticator secret unreadable.
- Rotating it: set the new key in `MFA_ENCRYPTION_KEY` and move the old one to `MFA_ENCRYPTION_PREVIOUS_KEYS` (comma-separated). Each ciphertext names its key (`mfa2.<keyId>...`), so both keep working, and a secret is re-encrypted with the new key the next time it verifies an app code. Keep old keys until no secret uses them.
- Recovery codes are keyless scrypt hashes: no key, no rotation.
- **Upgrading from the first MFA build** (whose secrets were derived from `JWT_REFRESH_SECRET`): run `npx prisma migrate deploy`, set `MFA_ENCRYPTION_KEY`, then `npm run build && npm run mfa:rekey` before serving MFA users. The command re-encrypts every old (`v1.`) authenticator secret with `MFA_ENCRYPTION_KEY`, keeping its value, so users' apps keep working. It needs the `JWT_REFRESH_SECRET` value those secrets were written with (`MFA_LEGACY_JWT_REFRESH_SECRET`, default `JWT_REFRESH_SECRET`), is idempotent, prints counts only, and exits `1` if a secret cannot be read. Until it has run, those users get `503` for app codes. Migration `20261124120000_mfa_login_and_independent_keys` deletes the old recovery codes (keyed with the JWT-derived key, they cannot be converted: only users know the codes) and clears old pending enrollments; the command reports how many MFA users have no recovery codes, and they create new ones with `POST /auth/mfa/recovery-codes` (signing in with their app).

Tests:

```bash
# Unit tests (no database or Redis), run with an empty JWT refresh secret:
# TOTP (RFC 6238 vectors), keys and encryption, scrypt recovery codes, lockout,
# the services (enrollment, verification, sign-in, trusted devices), HTTP contract
npm test -- --runInBand mfa
# Real endpoints of the whole application on a temporary PostgreSQL schema
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/musecue_test npx jest --config ./test/jest-e2e.json test/mfa-
```

`test/mfa-login.e2e-spec.ts` covers sign-in with and without MFA (password and Google, with Google's servers simulated), challenges, token issuance (including a refused session write that consumes nothing), trusted-device validity, expiry, revocation and ownership; `test/mfa-step-up.e2e-spec.ts` step-up authentication; `test/mfa-rekey.e2e-spec.ts` the upgrade command.

Migrations: `20261122120000_mfa_totp_enrollment` adds `MfaEnrollment` (CHECK: a pending secret always has an expiry; at most five stored failures) and `authSecurity.mfaLastUsedStep`. `20261123120000_mfa_recovery_codes` adds `MfaRecoveryCode` (protecting trigger) and the verification lockout (`authSecurity.mfaFailedAttemptsAt`, `mfaBlockedUntil`). `20261124120000_mfa_login_and_independent_keys` adds `MfaLoginChallenge` and `MfaTrustedDevice` (CHECKs and trigger above) and switches recovery codes to scrypt (see "Upgrading"). Existing users keep MFA disabled.

Not implemented yet: disabling MFA or resetting a lost authenticator (an administrator procedure is needed for users who lose both the app and their recovery codes), revoking all trusted devices at once or on a security event (for example `logout-all`), and re-encrypting secrets under a previous key without waiting for their next use.

### Step-up authentication

Sensitive actions need a fresh proof of identity, even in a signed-in session and even on a trusted device:

| Action | Protected routes |
| --- | --- |
| `MFA_ENROLLMENT` | `POST /auth/mfa/enrollment` |
| `MFA_RECOVERY_CODES` | `POST /auth/mfa/recovery-codes` |
| `SUBSCRIPTION_CANCEL` | `POST /v1/subscription/cancel` |
| `DATA_EXPORT` | `POST /v1/privacy/exports` |
| `DATA_EXPORT_DOWNLOAD` | `GET /v1/privacy/exports/:exportId/download`, `GET /v1/privacy/exports/:exportId/archive` |
| `ACCOUNT_DELETION` | `POST /v1/privacy/account-deletion` |

1. `GET /auth/step-up` tells the client how this account proves it: `mfa`, `password` or `google` (decided by the account, never by the client).
2. Get an approval for one action:
   - **MFA enabled:** `POST /auth/step-up` `{ "action": "DATA_EXPORT", "code": "123456" }` or `{ ..., "recoveryCode": "K7MPQ-3XWNR" }` (the password is refused with `400`). Codes are checked like at sign-in: current 30-second step only, each code once, a recovery code is consumed (in the same transaction as the approval), and the shared 5-in-15-minutes MFA lockout applies (`400`, then `429`).
   - **No MFA, with a password:** `POST /auth/step-up` `{ "action": ..., "password": "..." }`. A wrong password answers `403 Incorrect password` and counts toward the account lockout (like failed sign-ins); codes are refused with `400`.
   - **Google-only (no password, no MFA):** `POST /auth/step-up/google` `{ "action": ... }` returns a Google authorization `url` (with `login_hint`, `prompt=select_account`, `max_age=0`, PKCE and a nonce) and its `state`. Google returns the user to `GOOGLE_STEP_UP_REDIRECT_URI` (a client URL; default `GOOGLE_REDIRECT_URI`), and the client posts `{ "code", "state" }` to `POST /auth/step-up/google/callback` **with the same session's access token**. The one-time challenge (encrypted OAuth state, ten minutes) records the user, session and action; the first callback uses it up, whatever its outcome. Refused with `403`: expired or repeated callbacks, another session or user, an ID token for another nonce, another Google account (`sub` must be the account's), or a Google sign-in older than the challenge (when Google reports `auth_time`).
   The answer is `{ "stepUpToken": "stup_...", "action", "method", "expiresAt" }` (`201`, `Cache-Control: no-store`).
3. Send it as `X-Step-Up-Token` on the protected request. It is valid for **ten minutes**, for that action, that user and that sign-in session only, and may be used for that action repeatedly within those ten minutes (for example the download link and the archive, or a retry). Without it, with an expired one, or with one for another action, user or session, the route answers `403` before anything is read or changed. Ending the session (logout, logout-all, security events) ends its approvals at once.

Sessions: every sign-in now has an ID (`RefreshSession.familyId`) that refresh-token rotation keeps; access tokens carry it as `sid`. Access tokens issued before this change have no `sid`: they keep working for everything else, but step-up answers `401 This session cannot approve sensitive actions. Please sign in again.` until the app refreshes its tokens (the refreshed token has the session's ID). Approvals are stored in `StepUpApproval` (SHA-256 of the token, user, session, action, method, ten-minute expiry; a CHECK refuses longer approvals) and are deleted with the account; expired ones are removed by the hourly authentication sweep.

Migration `20261125120000_step_up_authentication` adds `StepUpApproval` and `RefreshSession.familyId` (existing sessions get the first session of their rotation chain).

Account deletion keeps its own confirmation (password and emailed code) in addition to the step-up.

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

Billing records (migration `20260918120000_add_payments_and_subscription_events`; written by the Stripe checkout described below):

- `PaymentTransaction` records one charge attempt for one billing period. It stores the amount in cents, currency, status (`PENDING`, `SUCCEEDED`, `FAILED`, `PARTIALLY_REFUNDED`, `REFUNDED`), `provider` + `providerPaymentId`, `providerInvoiceId` (the provider invoice the attempt tried to collect, migration `20261115120000_stripe_payment_failures`), the period, timestamps, and failure and refund details.
  - `(provider, providerPaymentId)` is unique, and only one verified payment may cover a given period.
  - Payments are never deleted. Amount, currency, provider IDs and period never change, and status only moves forward.
  - When a user is hard-deleted, their subscription is deleted and their payments are kept, detached: `subscriptionId` becomes `NULL` (`ON DELETE SET NULL`, migration `20260929120000_account_erasure`). This is the only change the database allows to `subscriptionId`, and only once the subscription no longer exists. A payment is never moved, re-attached or deleted.
  - `PaymentRefund` (migration `20261117120000_stripe_refunds`) records each provider refund of a collected payment: Stripe refund and charge IDs, amount, currency, status (`PENDING`, `REQUIRES_ACTION`, `SUCCEEDED`, `FAILED`, `CANCELED`), reason and time. Refund facts never change, statuses only move forward, rows are never deleted, and succeeded refunds can never exceed the payment (database trigger).
- `SubscriptionEvent` is an append-only lifecycle log: `TRIAL_STARTED`, `CREATED`, `RENEWED`, `CANCELED`, `EXPIRED`, `PAYMENT_FAILED`. `CREATED` and `RENEWED` reference the `SUCCEEDED` payment for the period, and each payment backs at most one event.
- `UserSubscription` gains `paymentProvider` and `providerSubscriptionId` (unique together) to link the provider's recurring subscription.
- A paid term (`proStartedAt`/`proExpiresAt`) can only be created or extended by a `SUCCEEDED` payment of the same subscription and interval that covers the newly granted range and ends exactly at `proExpiresAt`. A new term may not start before its paid period, and a renewal's period must start no later than the current expiry, so it cannot bridge an unpaid gap. Early renewals and monthly-to-yearly changes may overlap. Pending, failed and refunded payments never grant or renew Pro access. Cancelling keeps access until `proExpiresAt`.
- A billing period is one calendar month or year as Stripe bills it (migration `20261114120000_stripe_anchored_billing_periods`, which replaces the exact rule of `20260920120000_calendar_billing_periods_and_gap_free_terms`). It either ends exactly one calendar interval after it starts (month-ends clamp: Jan 31 → Feb 28, or Feb 29 in a leap year; Feb 29 + 1 year → Feb 28), or it is anchored on a day the start month lacks. Stripe bills a subscription started on Jan 31 on Feb 28, then Mar 31, so Feb 28 → Mar 31 is valid. Such a period starts on its month's last day and ends later in the next month (next year for yearly) at the same time of day. Periods like Mar 1 → Mar 29 or Jan 31 → Mar 3 are still rejected. `src/subscription/billing.validation.ts` (`addBillingInterval`, `isValidBillingPeriod`, `getPaidTermRejection`, pricing and status-transition checks) applies the same rules in the application.

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

### Stripe checkout

| Method | Route                       | Auth                      | Purpose                                            |
| ------ | --------------------------- | ------------------------- | -------------------------------------------------- |
| `POST` | `/v1/subscription/checkout` | bearer token              | Start (or reuse) a hosted Stripe checkout for Pro  |
| `POST` | `/v1/subscription/cancel`   | bearer token              | Cancel the caller's own subscription at period end |
| `GET`  | `/v1/subscription/billing`  | bearer token              | The caller's billing information                   |
| `GET`  | `/v1/subscription/payments` | bearer token              | The caller's payment history (paged)               |
| `POST` | `/v1/webhooks/stripe`       | `Stripe-Signature` header | Stripe events; the only way paid Pro is granted    |

`POST /v1/subscription/checkout` accepts exactly `{ "billingInterval": "MONTHLY" }` or `{ "billingInterval": "YEARLY" }`. Any other value, `null`, lowercase values and extra fields (a price, currency, user ID or "paid" flag) are rejected with `400`. The user comes from the access token, and the price from the plan configuration (`monthlyPriceUsdCents` / `yearlyPriceUsdCents`) at the moment the checkout is created. The response (`201`) is:

```json
{
  "checkoutSessionId": "6f0c…",
  "provider": "stripe",
  "status": "OPEN",
  "billingInterval": "MONTHLY",
  "amountCents": 1900,
  "currency": "USD",
  "url": "https://checkout.stripe.com/c/pay/cs_…",
  "expiresAt": "2026-11-13T13:00:00.000Z",
  "reused": false
}
```

The app opens `url`. Returning to the success URL does not activate anything: the app should poll `GET /v1/subscription` until `status` is `PRO`.

Rules:

- Every user has their own Stripe customer (`PaymentCustomer`), created on the first checkout and reused afterwards. It is unique per user, and a Stripe customer belongs to exactly one user.
- Users with an active paid term, including a canceled term that has not expired, receive `409 You already have an active Pro subscription`. Trial users and users whose paid term expired can buy.
- A user whose record is linked to a Stripe subscription can buy again only after Stripe reports that subscription ended (`canceled` or `incomplete_expired`; the API asks Stripe on each such checkout). Until then the response is `409 Your previous Pro subscription has not ended yet and may still renew; a new checkout could charge you twice`. This covers the renewal window after `proExpiresAt` (Stripe collects a renewal up to about an hour after the period ends, and its webhook can be later still) and a refund that ended access while the Stripe subscription continues. Without it, a second subscription could be charged on top of the first. If Stripe cannot be asked, the response is `503` and nothing is created.
- A user has at most one pending checkout (a partial unique index on `CheckoutSession`). Repeating the request for the same option returns the same checkout with `reused: true`, as long as Stripe confirms it is still open, however little time it has left. It keeps the price it was created with: an admin price change applies only to checkouts created afterwards. Choosing the other option first expires the open Stripe session and creates the new one only after Stripe has confirmed the expiration. If the expiration cannot be confirmed, nothing new is created and the old checkout stays pending. This covers Stripe being unreachable, an error, a lost response and a result other than `expired`. The response is `503 The previous checkout could not be closed; please try again shortly`, or `409` when Stripe shows the old session was just paid or expired by a concurrent request. A later request replaces the old checkout once Stripe reports it expired. The old checkout is closed in the same transaction that creates its replacement.
- Concurrent requests are serialized by the user's `UserSubscription` row lock, which is held only for short database work, never during Stripe calls. Stripe objects are created with idempotency keys derived from the user or the checkout, so concurrent or retried requests get the same Stripe customer and session. At most one payable session exists per user.
- If the user paid but the webhook has not arrived yet, new checkouts receive `409 Your previous checkout payment is still being processed` and nothing is granted.
- While a failed renewal is past due (Stripe may still collect it), new checkouts receive `409 Your last Pro renewal payment failed and Stripe is still retrying it; a new checkout could charge you twice`. This holds even after the paid term has lapsed. It ends when Stripe collects the invoice or ends the subscription.
- Stripe failures return `503`. A checkout whose creation may have reached Stripe (timeout, network or server error) is kept and recovered through the same idempotency key on the next request. A definitive rejection marks it `FAILED`.

Other responses: `403` for inactive, unverified or soft-deleted accounts and while the plan is disabled, and `503 Payments are not configured` until the Stripe settings below are present.

Activation happens only in `POST /v1/webhooks/stripe`. The endpoint has no bearer token and is excluded from rate limiting. Each event is verified against the raw request body and the `Stripe-Signature` header, with Stripe's 5-minute replay tolerance; an invalid signature returns `400`. The API then re-reads the session, its subscription and its first invoice from the Stripe API, never trusting the event payload. It grants Pro only if all of these match the stored checkout:

- the session is complete with `payment_status = paid`, for the user's own customer;
- the subscription has exactly one item at the stored price and interval;
- the first invoice (`subscription_create`) is paid in full in USD.

One transaction then records the `SUCCEEDED` `PaymentTransaction` (provider `stripe`, invoice ID, amount, currency, interval, and the billing period exactly as Stripe reports it), sets the paid term and the Stripe subscription link on `UserSubscription`, appends a `CREATED` `SubscriptionEvent`, completes the checkout and writes an audit record. The existing database trigger independently checks that the payment covers the term. Replayed or concurrent deliveries record the payment once.

A payment that fails verification is logged and acknowledged, and access is not granted. A payment that arrives while another paid term is active is recorded but never stacks a second term; it is logged as needing a refund.

#### Automatic renewals

Stripe charges the subscription at the end of each period. The API extends Pro only when it receives `invoice.paid` for a `subscription_cycle` invoice, re-reads the invoice and subscription from the Stripe API, and verifies all of the following:

- the invoice belongs to the Stripe subscription bought through MuseCue and to the user's own customer;
- it is `paid`, in full, in USD, at the price the subscription was bought for (admin price changes do not apply to existing subscriptions);
- the subscription still has one item at that price and interval;
- the invoice covers a valid billing period.

One transaction under the user's row lock then records the `SUCCEEDED` `PaymentTransaction` (invoice ID and the period dates Stripe reports), extends `proExpiresAt` to the period end, appends a `RENEWED` `SubscriptionEvent` and writes an audit record. The trial fields and `proStartedAt` of a running term are never changed, and the database trigger again checks that the payment covers the extension.

- Until the payment is confirmed nothing changes. A failed or open invoice grants nothing, and access ends at `proExpiresAt`. When a late payment arrives, the term is extended from its old expiry.
- The invoice ID identifies the payment, so repeated, concurrent or delayed deliveries record it once. They never create a second renewal event or overwrite the subscription. A replay makes no Stripe API call.
- A delayed event for an older period that the term already covers is recorded in the payment history, but never shortens or moves the term.
- A renewal arriving after a gap (a period starting after `proExpiresAt`) starts a new term at the period Stripe reports.
- `invoice.paid` for the first invoice (`subscription_create`) confirms the first payment, like the checkout events. It checks the invoice and subscription, including the checkout ID in the subscription metadata. Whichever event arrives first records the payment and its `CREATED` event; the others find it recorded.
- A second charge for an already paid period is not recorded, and a renewal of a duplicate Stripe subscription never extends access. Both are logged at error level for a refund.

#### Failed payments and recovery

`invoice.payment_failed` reports one failed collection attempt, of the first invoice or of a renewal. The API re-reads the invoice and subscription from Stripe and checks them like a payment (customer, subscription, price, interval, period). It also asks Stripe for the attempt's decline reason; this is best effort, so a lookup failure still records the attempt as `payment_failed`. One transaction then records:

- a `FAILED` `PaymentTransaction` for the attempt: invoice ID in `providerInvoiceId`, period, `failedAt`, `failureCode` (e.g. `insufficient_funds`) and `failureMessage`. Its `providerPaymentId` is `<invoice>:failed:<event>`, so every attempt keeps its own immutable record and a redelivered event is recorded once;
- a `PAYMENT_FAILED` `SubscriptionEvent`;
- for a still-unpaid renewal of the subscription that backs the paid term, `UserSubscription.pastDueSince`: the first failure, kept across retries.

A failed attempt never grants, extends or shortens access. Users keep Pro until `proExpiresAt` of the period they paid for; access ends exactly then, and the payment state machine is unchanged (`FAILED` stays terminal). A failed first payment grants nothing, and the checkout stays open, so the customer can try another card.

Recovery is Stripe collecting the invoice (a retry or a new card):

- A renewal arrives as `invoice.paid` and is recorded like any renewal: one `SUCCEEDED` payment keyed by the invoice ID, one `RENEWED` event, and the term extended to Stripe's period end. The period starts at the old expiry, even if access had lapsed meanwhile. `pastDueSince` is cleared.
- A first payment arrives as `checkout.session.completed`, `async_payment_succeeded` or `invoice.paid`, whichever comes first. It is recorded once with one `CREATED` event.
- Repeated, concurrent or late deliveries never create a second payment, event or extension.
- A failure event that arrives after the invoice was collected is kept as history only: it is not marked past due and the term is unchanged.

`customer.subscription.deleted` for the linked subscription, confirmed as `canceled` through the Stripe API, means Stripe stopped retrying (or the subscription was canceled). It sets `proCanceledAt` (access continues until `proExpiresAt`), appends one `CANCELED` event and clears `pastDueSince`, so the user can check out again. Configure Stripe to cancel subscriptions after the final failed retry. With "mark as unpaid" or "leave past due", the user stays past due until the invoice is paid or the subscription is canceled.

#### Billing information and payment history

Both routes are read-only and require a bearer token (`401` without a valid one). They always describe the token user: user, customer or payment IDs are never accepted (unknown query parameters are rejected with `400`; a request body is ignored). They read only PostgreSQL, where only verified Stripe events write (checkout, invoices, failures, cancellation, refunds). They never call Stripe and keep nothing in memory, so the same data gives the same answer after a restart. No Stripe identifiers (customer, subscription, invoice, charge, refund), credentials or raw failure messages are returned.

`GET /v1/subscription/billing`:

```json
{
  "status": "PRO",
  "hasProAccess": true,
  "accessExpiresAt": "2026-12-01T10:00:00.000Z",
  "subscriptionState": "ACTIVE",
  "plan": { "code": "PRO", "billingInterval": "MONTHLY", "priceCents": 1900, "currency": "USD" },
  "currentPeriod": { "start": "2026-11-01T10:00:00.000Z", "end": "2026-12-01T10:00:00.000Z" },
  "autoRenew": true,
  "nextRenewalAt": "2026-12-01T10:00:00.000Z",
  "canceledAt": null,
  "pastDueSince": null
}
```

- `status`, `hasProAccess` and `accessExpiresAt` follow the same rules as `GET /v1/subscription`.
- `subscriptionState` is one of:
  - `NONE`: never paid (including trial-only users);
  - `ACTIVE`: the paid term is running;
  - `CANCELED`: the paid term is running but will not renew;
  - `PAST_DUE`: a renewal failed and Stripe is retrying;
  - `ENDED`: expired, or revoked by a refund.
- `plan` is the paid plan: its interval and the price the subscription is billed at. That is the purchase price, which renewals also charge; later admin price changes do not apply. `plan` stays shown after the subscription ended, and is `null` without any paid term.
- `currentPeriod` is the paid billing period running now, or `null` without active paid access.
- `nextRenewalAt` is the period end while the subscription will renew (`autoRenew`: active, backed by Stripe, not canceled, not past due).
- `canceledAt` and `pastDueSince` are the stored cancellation and first-failure times.

`GET /v1/subscription/payments?page=1&limit=20` (`limit` 1–100, default 20) returns `{ items, meta }` in the project's paginated shape (`page`, `limit`, `total`, `totalPages`, `hasPreviousPage`, `hasNextPage`). It covers every payment attempt and refund of the caller, newest first. Ties are ordered by record time and ID, so pages are stable. Each entry has:

- `id`, `type` (`PAYMENT` or `REFUND`), `purpose` (`NEW_SUBSCRIPTION` or `RENEWAL`; for a refund, that of the refunded payment);
- `status`, `amountCents`, `currency`, `date`, `billingInterval` and the billed `period`:
  - a payment is `SUCCEEDED`, `FAILED`, `PARTIALLY_REFUNDED` or `REFUNDED`; its date is when it was paid or failed, and it has `refundedAmountCents`;
  - a refund is `PENDING`, `REQUIRES_ACTION`, `SUCCEEDED`, `FAILED` or `CANCELED`; its date is when Stripe created it, and `paymentId` names the refunded payment entry;
- for failed payments, a `failureReason` such as `insufficient_funds` or `expired_card`. Decline codes that Stripe advises not to show customers (e.g. `stolen_card`, `fraudulent`) are reported as `card_declined`.

Cancellations do not add entries; they appear in the billing information.

#### Cancellation at period end

`POST /v1/subscription/cancel` (bearer token, no body) cancels the caller's own paid subscription at the end of its current period. The subscription is always the token user's: user or subscription IDs in the body or query are ignored, so nobody can cancel another user's subscription. Response (`200`):

```json
{
  "status": "PRO",
  "hasProAccess": true,
  "autoRenew": false,
  "canceledAt": "2026-03-10T09:00:00.000Z",
  "endsAt": "2026-03-31T10:00:00.000Z",
  "accessExpiresAt": "2026-03-31T10:00:00.000Z",
  "alreadyCanceled": false
}
```

- Only a running paid term backed by a Stripe subscription can be canceled. Otherwise the response is `409 You do not have an active paid Pro subscription to cancel`: no subscription, trial only, an ended term (access ends exactly at `proExpiresAt`), or a term without a Stripe subscription.
- The API first asks Stripe to set `cancel_at_period_end`, outside any database transaction and with an idempotency key per subscription and term. Nothing is refunded or shortened.
- The cancellation is recorded only when Stripe confirms it. It sets `UserSubscription.proCanceledAt` to Stripe's cancellation time and appends one `CANCELED` `SubscriptionEvent` with the same time, plus an audit record by the user. `proExpiresAt` never changes: Pro features stay available until the period ends, and `GET /v1/subscription` shows `pro.canceledAt`.
- The cancellation is saved only after Stripe responds positively. If the request fails or Stripe's answer does not confirm it, nothing is saved and the response is `503 Cancellation could not be confirmed; please retry or check subscription status`. The API does not claim the subscription will renew: Stripe may have canceled even if its response was lost. If Stripe canceled but its response was lost, a retry or Stripe's `customer.subscription.updated` webhook records it.
- Repeated requests return the same cancellation (`alreadyCanceled: true`) without calling Stripe. Concurrent requests and webhooks are serialized by the user's row lock, and only the first sets `proCanceledAt`. A partial unique index (migration `20261116120000_subscription_cancellation`) also refuses a second `CANCELED` event for the same cancellation.
- `customer.subscription.updated` (re-read from Stripe) records a period-end cancellation made outside MuseCue, e.g. in the Stripe dashboard. It never reverses a recorded cancellation, so stale or out-of-order updates change nothing.
- When Stripe ends the subscription at period end (`customer.subscription.deleted`), nothing is added: the cancellation and expiry are already recorded.
- A canceled but running term still counts as an active subscription, so a new checkout returns `409` until it ends. Trial history, payments and renewal rules are unchanged.

#### Refunds

Refunds are made in Stripe (for example from the dashboard); MuseCue has no refund endpoint. Stripe reports them with `charge.refunded`, `charge.refund.updated`, `refund.created`, `refund.updated` or `refund.failed`. Each event only names the charge. The API then reads the charge and all of its refunds from the Stripe API, finds the invoice the charge paid, and matches it to the recorded payment (its `providerPaymentId`). It checks that the charge is the user's own Stripe customer, in USD, for the recorded amount. One transaction under the user's row lock then:

- stores every Stripe refund once in `PaymentRefund`, keyed by its Stripe `re_…` ID. A `PENDING`, `FAILED` or `CANCELED` refund is stored with its status but changes nothing else;
- sets the payment's `refundedAmountCents` to the sum of its succeeded refunds and `refundedAt` to the latest of them. The status becomes `REFUNDED` for a full refund and `PARTIALLY_REFUNDED` for a partial one (partial refunds can later complete to `REFUNDED`);
- appends one `PAYMENT_REFUNDED` event for each refund that newly succeeded;
- revokes, immediately, the access the refunded payment paid for, full or partial: `proExpiresAt` is cut to now even if the period had not ended, and the stored `status` is recomputed (normally `EXPIRED`). `GET /v1/subscription` and `ProAccessGuard` deny Pro from that instant.

Only the refunded payment's access is revoked. If its period is already over, the current access comes from a newer payment and is left alone. A duplicate payment that never granted access can be refunded without touching anyone's access. A later paid period (for example Stripe's next renewal, since a refund does not cancel the Stripe subscription) starts a new term and grants access again.

Repeated or delayed events add no rows or events. Because the current state is always re-read from Stripe, a stale `pending` event cannot undo a succeeded refund. Refunded amounts only grow, and the term is only ever shortened, so no event can restore revoked access; replays of the payment's own `invoice.paid` or checkout events are already recorded. A refund Stripe reports as failed after it succeeded keeps its effect and is logged for review. If a refund arrives before its payment was recorded, the webhook answers `503` so Stripe retries after the payment event. The payment event then applies it at once: after a first payment or renewal is recorded, the API asks Stripe whether that invoice's charge has refunded money and, if so, records the refunds and revokes the access in the same delivery, not at Stripe's next retry of the refund event. If Stripe cannot be asked at that point, the payment stays recorded and the retried refund event applies the refund.

Handled events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`, `charge.refund.updated`, `refund.created`, `refund.updated`, `refund.failed`. Other events are acknowledged and ignored. Transient failures return `5xx`, so Stripe retries.

#### Webhook security and reliability

- **Verified first:** every event goes through `StripeWebhookService.receive`. It verifies the `Stripe-Signature` header against the raw body before anything is read or written; a missing, forged, tampered, other-secret or stale (more than 5 minutes old) signature gets `400` and changes nothing. Only `verifyEvent` produces a `VerifiedStripeEvent`, and `handleEvent` accepts nothing else (a compile-time guarantee).
- **Facts from the API:** payment facts are then always re-read from the Stripe API and matched to what MuseCue stored (customer, subscription, checkout, price, interval, amount). Payloads are never trusted for them.
- **Events that are not ours:** events of connected accounts (`account` set) or of the other mode (a live event at a test key, or the reverse) are acknowledged without effect (`NOT_FOR_THIS_ACCOUNT`). So is an event naming an object that does not exist in this Stripe account (`UNKNOWN_OBJECT`), instead of being retried for days.
- **Event log:** each verified event is recorded in `PaymentWebhookEvent` (migration `20261118120000_payment_webhook_events`) before processing. The row has the Stripe event ID, type, object ID, mode and creation time, but no payload. It is then updated with the status (`PROCESSED` or `FAILED`), the outcome, the number of deliveries and, on failure, an error class (never a message).
- **Failures:** a failure answers a generic `500 Webhook processing failed` (no internal details), or `503` for retry-later cases. Because every change is one transaction, nothing is half-applied, and Stripe's redelivery applies the event once. An event still `FAILED` after Stripe's retries can be resent from the Stripe dashboard (events are kept for 30 days):

  ```sql
  SELECT "providerEventId", "type", "attempts", "lastErrorCode", "receivedAt"
    FROM "PaymentWebhookEvent" WHERE "status" = 'FAILED' ORDER BY "receivedAt";
  ```

- **Early arrivals:** a renewal, or a cancellation made in Stripe, can arrive before the subscription's first payment is recorded. It answers `503` so Stripe delivers it again, instead of being acknowledged and lost.

Review notes (November 2026):

- **What was checked:** every event type for signature handling, payload trust, cross-customer matching, duplicates, concurrency, delays and ordering, and failures after Stripe confirmed a payment. Most of it was already correct:
  - signature before processing;
  - re-reading payment facts from Stripe;
  - customer/subscription matching;
  - one transaction per change under the user's row lock;
  - idempotency keyed by Stripe IDs;
  - terms that are only ever extended by newer paid periods and only ever shortened by refunds.
- **Problems found and fixed:**
  1. A processing error returned the raw internal error message (database details and IDs) in the webhook response body.
  2. A renewal arriving before its subscription's first payment was recorded was answered `200` and so lost for good.
  3. The same happened to a period-end cancellation made in Stripe.
  4. Connected-account events were processed like the account's own.
  5. A refund event for a charge outside this Stripe account was answered `500`, so Stripe retried it for days.
  6. A verified event that kept failing left no trace once Stripe stopped retrying.
- **Checks that now run:**
  - `test/stripe-webhook-reliability.e2e-spec.ts` (PostgreSQL): database failures are injected with real triggers after Stripe confirmed a payment, renewal or refund, and everything rolls back and is applied once on redelivery; it also covers a whole lifecycle delivered reversed, duplicated and concurrently, replays after a refund, and foreign and invalid events.
  - `src/subscription/stripe/stripe-webhook.reliability.spec.ts` (unit): the same cases.
- **Known limits:**
  - Processing uses the provider state at the time of processing, so a refund revokes access when the refund event is processed, not retroactively.
  - An older renewal applied after a newer one after a gap cannot merge into the term (see above).
  - Cancellations requested through `POST /v1/subscription/cancel` are saved from Stripe's direct API response, not from a webhook, as required for that endpoint.

#### Payment lifecycle integration tests

- **What `test/stripe-payment-lifecycle.e2e-spec.ts` runs (PostgreSQL, simulated Stripe):**
  - the whole lifecycle for monthly and yearly plans, through the HTTP API and signed webhooks, with test users and a frozen clock at month-end and leap-day anchors: checkout, redirect only, confirmed payment, activation, renewal, failed payment, recovery, cancellation, restart, expiration, full and partial refund, and no payment;
  - checks on status, Pro access at exact instants, amounts, period lengths, Stripe references and the stored event history;
  - concurrent checkouts, webhooks and cancellations; duplicated events; an application restart;
  - a free-trial user buying Pro: the trial history never changes through purchase, renewal, cancellation and expiration; a refund during the trial ends only the paid term;
  - billing boundaries: concurrent checkouts while a lapsed term's renewal is still being collected are refused (one Stripe subscription), and a refund made before its payment was recorded is applied as soon as the payment is;
  - the same lifecycle delivered reversed and in three shuffled orders, duplicated and concurrent, compared with the in-order stored state;
  - after every test, SQL checks of database invariants: each access change has a collected payment; terms are covered by payments; refund totals match; no duplicate payments or events; every webhook logged as processed.
- **Problems found and fixed:**
  1. A renewal delivered while its first payment was being recorded could be answered `200` as "unknown subscription", so the paid renewal was lost. The same race could drop a subscription end.
  2. The end of a subscription delivered before its first payment was recorded was lost.
  3. An ended subscription stored its end time instead of Stripe's cancellation time (`canceled_at`).
  4. A failed concurrent duplicate delivery could mark an already processed webhook as `FAILED`.
  5. (Final review) A user whose paid term had lapsed locally, but whose Stripe subscription could still renew, could start a second subscription and be charged twice. Checkout now waits until Stripe reports the subscription ended.
  6. (Final review) A refund made before its payment was recorded left Pro granted until Stripe's next retry of the refund event. It is now applied as soon as the payment is recorded.
- **Known limit:** when a renewal is recorded before an older renewal that bridges it to the current term, only the "Pro since" date (`proStartedAt`) differs from in-order delivery (see the limitation below). Payments, periods, events and current access are the same.

Configuration (`.env.example`): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CHECKOUT_SUCCESS_URL`, `STRIPE_CHECKOUT_CANCEL_URL` (absolute http(s) URLs), optional `STRIPE_PRO_PRODUCT_ID`, and `STRIPE_CHECKOUT_EXPIRES_MINUTES` (31–1440, default 60). In the Stripe dashboard, create a webhook endpoint for `https://<api>/v1/webhooks/stripe` with the thirteen events above. For local development, forward events with the Stripe CLI and use the printed signing secret:

```bash
stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired,invoice.paid,invoice.payment_failed,customer.subscription.updated,customer.subscription.deleted,charge.refunded,charge.refund.updated,refund.created,refund.updated,refund.failed --forward-to localhost:5000/v1/webhooks/stripe
```

Migration `20261113120000_add_stripe_checkout` adds `PaymentCustomer` and `CheckoutSession`. Database rules enforce one pending checkout per user, forward-only checkout status, an immutable price, interval, customer and provider session, and completion only by a `SUCCEEDED` payment of the same subscription. The webhook needs the raw body, so `main.ts` creates the app with `rawBody: true`.

Not implemented yet: immediate cancellation (including canceling a past-due subscription to stop Stripe's retries), undoing a cancellation (a cancellation reversed in Stripe is not reflected), the customer portal (so users cannot update their card in-app; Stripe's own emails and hosted invoice page can be used), exposing the past-due state in `GET /v1/subscription`, requesting refunds from MuseCue, disputes (`charge.dispute.*`), canceling the Stripe subscription automatically when a payment is refunded, revoking an active free trial on refund (a trial is not a payment and keeps running), reactions to other `customer.subscription.updated` changes (e.g. `unpaid`), and automatic refunds or cancellation of duplicate payments and subscriptions. Renewal delays within Stripe's retry window (up to 3 days) are handled. If a renewal for an older period arrives after a newer one, the older period is recorded but cannot be merged into the term: the database allows one payment per term change.

Database tests (`test/auth-state.e2e-spec.ts`, `test/mfa-enrollment.e2e-spec.ts`, `test/mfa-recovery.e2e-spec.ts`, `test/mfa-login.e2e-spec.ts`, `test/mfa-rekey.e2e-spec.ts`, `test/mfa-step-up.e2e-spec.ts`, `test/postgres-job-queue.e2e-spec.ts`, `test/postgres-mode.e2e-spec.ts`, `test/rate-limit-contract.e2e-spec.ts` (PostgreSQL part), `test/subscription-plan.*.e2e-spec.ts`, `test/user-subscription.*.e2e-spec.ts`, `test/subscription-trial.e2e-spec.ts`, `test/subscription-status.e2e-spec.ts`, `test/pro-access.e2e-spec.ts`, `test/trial-lifecycle.e2e-spec.ts`, `test/billing.e2e-spec.ts`, `test/subscription-security.e2e-spec.ts`, `test/privacy-export.e2e-spec.ts`, `test/account-deletion.e2e-spec.ts`, `test/account-erasure.e2e-spec.ts`, `test/stripe-checkout.e2e-spec.ts`, `test/stripe-renewal.e2e-spec.ts`, `test/stripe-payment-failure.e2e-spec.ts`, `test/stripe-cancellation.e2e-spec.ts`, `test/stripe-refund.e2e-spec.ts`, `test/subscription-billing.e2e-spec.ts`, `test/stripe-webhook-reliability.e2e-spec.ts`, `test/stripe-payment-lifecycle.e2e-spec.ts`) run only when `TEST_DATABASE_URL` is set, and are reported as skipped otherwise. Each test builds a temporary schema from the migration files and drops it afterwards, so the database user needs `CREATE` permission:

```bash
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/musecue_test npx jest --config ./test/jest-e2e.json test/subscription-plan test/user-subscription test/subscription-trial test/subscription-status test/pro-access test/trial-lifecycle test/billing test/subscription-security test/privacy-export test/account-deletion test/account-erasure
```

Personal data export unit tests (no database or Redis needed):

```bash
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/musecue_test npx jest --config ./test/jest-e2e.json test/subscription-plan test/user-subscription test/subscription-trial test/subscription-status test/pro-access test/trial-lifecycle test/billing test/subscription-security test/stripe-checkout test/stripe-renewal test/stripe-payment-failure test/stripe-cancellation test/stripe-refund test/subscription-billing test/stripe-webhook-reliability test/stripe-payment-lifecycle
```

All payment database suites (each uses its own schema, so they can run in parallel workers):

```bash
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/musecue_test npm run test:e2e:payments
```

The Stripe unit tests do not need a database or a Stripe account; they run the real Stripe SDK against an in-memory emulation of the few Stripe endpoints used (`test/support/fake-stripe-api.ts`):

```bash
npm test -- --runInBand stripe   # or: npm run test:stripe
npm test -- --runInBand subscription-billing
```


## Domain

```text
authUser
|-- RefreshSession (hashed refresh tokens, rotation lineage)
|-- AuthChallenge (hashed one-time codes, one per purpose)
|-- MfaEnrollment (0..1: encrypted pending TOTP secret, failed codes)
|-- MfaRecoveryCode (salted scrypt hashes of single-use recovery codes)
|-- MfaLoginChallenge (SHA-256 of pending sign-in challenges)
|-- MfaTrustedDevice (SHA-256 of 30-day trusted-device tokens)
|-- StepUpApproval (SHA-256 of ten-minute approvals: user, session, action)
|-- InfrastructureJob (PostgreSQL queue driver; deleted with the account)
|-- PaymentCustomer (0..1 per provider)
|-- UserSubscription (0..1)
|-- DataExport
|-- (AccountDeletionRequest -> AccountDeletionFile: references authId without a foreign key)
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

OAuthState, RateLimitBucket: short-lived, keyed by hashes, no owner
```

Mock and live gateways implement the same application-owned operations. The live gateway delegates transport to an OpenRouter provider adapter, workers validate and normalize model-shaped output, and NestJS alone persists it transactionally and advances workflow state. No frontend or public API contract changes are required to switch modes or add another provider adapter.

## Commands

```bash
npm run start:dev
npm run build
npm run lint
npm test
TEST_DATABASE_URL=... REDIS_ENABLED=false npm run test:e2e -- --runInBand   # PostgreSQL-only mode (Redis suites skipped)
TEST_DATABASE_URL=... TEST_REDIS_URL=redis://127.0.0.1:6379 REDIS_ENABLED=true npm run test:e2e -- --runInBand   # adds Redis mode (see "Testing both modes")
npx jest private-cloud   # private image storage unit tests
TEST_DATABASE_URL=... npx jest --config ./test/jest-e2e.json test/private-cloud   # storage workflows + cleanup ledger on PostgreSQL (mocked Supabase)
npm run test:e2e
npx prisma generate
npx prisma migrate dev
npx prisma migrate deploy
```

### Storage merge and privacy workflows

Privacy exports read photos from their recorded provider and object key. Account erasure preserves that provider on each deletion record and sweeps each configured backend, including legacy local files. Apply the `20261119120000_account_erasure_storage_provider` migration with the merge so deletion retries continue to target the correct backend. New providers must implement owner enumeration for account erasure.
