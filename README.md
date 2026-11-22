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
- AI credit configuration: administrators can read and change the trial credit allowance, the monthly Pro allowance, the OpenRouter cost per credit and the per-session overage allowance; the defaults are stored in PostgreSQL by migration and at startup, never overwriting administrator changes (see "AI credit settings" under API)
- discount, referral, daily reward and credit package configuration: administrators can read and change the first-purchase discount, the referral discount and the referrer's reward credits (all `0` = off by default), the daily reward amounts (10 credits, +10 per day, at most 50; at most 600 daily reward credits per user per UTC calendar month) and the three credit packages (250 credits for $5, 500 for $10, 1,000 for $20: credits, price in cents, availability); stored in PostgreSQL by migration and at startup, never overwriting administrator changes (see "Discount, referral, daily reward and credit package settings" under API). Configuration only: discounts are not applied, and rewards and packages are not granted or sold yet
- AI credit wallet and ledger: per-user wallets, allocations by source (trial, subscription, purchase, referral) with expiry, exact fractional balances, an append-only transaction ledger with grants, debits and expirations (recorded for every wallet by a scheduled sweep), and per-session overage, all in PostgreSQL and safe under concurrency (see "AI credit wallet and ledger")
- AI usage metering and credit deductions: every OpenRouter request of a makeup AI run is stored with its user, session, run, tokens and USD cost. Each run is charged once, in exact (fractional) credits converted from its actual cost at the administrator's rate ($0.025 at $0.005 per credit = 5 credits), and the cost and rate are kept in the ledger history (see "AI usage and credit deductions")
- credit balance and transaction history APIs: a signed-in user sees their own balance by source (granted, available, used, expired, expiry dates), their ledger (allocations, deductions with session overage, expirations, with sources, sessions and AI usage), and the AI usage of their sessions; nobody else's (see "Credit balance and transaction history")
- session credit overage and concurrency control: a session initialized with credits can finish beyond the balance, up to the administrator's overage allowance (default 5 credits). The balance never goes negative, one credit can only start one session, and concurrent sessions and requests can neither spend a credit twice nor bypass the overage limit (see "Session credit overage and concurrency control")
- credit-based access: creating a makeup session (`POST /v1/sessions`) requires usable credits, otherwise `403 Insufficient credits`; free sign-ups have none; activating the free trial allocates the trial allowance (ended at once if paid Pro is bought during the trial) every successful Stripe payment allocates monthly Pro credits, and yearly subscriptions receive theirs one month at a time from a restart-safe scheduler; purchased and referral credits (set up in PostgreSQL for now) work with or without Pro (see "Credit-based access to makeup sessions")
- a single Pro subscription plan: admin-configured monthly/yearly pricing and free trial, one-time trial activation, date-based Pro access through `ProAccessGuard`, payment/lifecycle records protected by database rules, and Stripe checkout for the monthly and yearly options with webhook-verified activation, automatic renewals, failed-payment handling and recovery, cancellation at period end, and refunds made in Stripe with immediate access revocation (see "Subscriptions" and "Stripe checkout" under API); requesting refunds from MuseCue and disputes are not implemented yet
- personal data export: an authenticated user can request an asynchronous ZIP archive of their own account, profile, makeup history, subscription records, AI credits (`data/credits.json`: allocations, transaction history, session overage and AI usage, without internal references) and private photos, poll its status, and download it through a signed link valid for at most 15 minutes; archives expire 24 hours after export and are deleted by a scheduled retention sweep (see "Personal data export" under API)
- account deletion: the owner confirms their identity (password and an emailed code, or the code alone for accounts without a password), the account is blocked and every token invalidated at once (`PENDING_DELETION`), and a background sweep hard-deletes the account and all its data and files (including its refresh sessions, one-time codes, queued or retained background jobs, its credit wallet and ledger, and its AI usage records), keeping payment records detached (see "Account deletion" under API)

Migration `20260827174107_add_makeup_workflow` adds the makeup aggregate and removes the dormant job-tracker and subscription starter domains.

Intentionally deferred:

- signed URLs for avatars and for images still on the local filesystem (they keep using the authenticated content routes)
- copying images stored on the filesystem before the Supabase migration into the bucket (they remain readable through the `local` provider while its directory is present)
- additional S3-compatible storage providers (the provider interface is in place; see "Private image storage")
- generated preview images (recommendation reasoning is live, while the existing curated preview-image contract remains in place)
- production retention/deletion automation and further credit features: issuing purchased and referral credits through the API (see "Credit-based access to makeup sessions")
- using the discount, referral, daily reward and credit package settings: applying discounts at checkout, referral sign-ups and rewards, claiming daily rewards (and enforcing the monthly cap), and buying credit packages through Stripe

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
  the user can retry).
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

Every OpenRouter request asks for usage accounting, and its tokens and cost are recorded and charged in credits (see "AI usage and credit deductions").

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
| `POST` | `/auth/login`                     | Return access token, refresh token, and user |
| `POST` | `/auth/refresh-token`             | Rotate the refresh token                     |
| `POST` | `/auth/logout`                    | Revoke the current session                   |
| `POST` | `/auth/logout-all`                | Revoke all user sessions                     |

Makeup routes require a bearer token:

| Method   | Route                                                              | Purpose                                            |
| -------- | ------------------------------------------------------------------ | -------------------------------------------------- |
| `POST`   | `/v1/sessions`                                                     | Create an owner-scoped session (requires credits)  |
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
| `GET`    | `/v1/sessions/:sessionId/ai-usage`                                 | AI requests, cost and credits of the session       |
| `GET`    | `/v1/credits/balance`                                              | The user's credit balance by source                |
| `GET`    | `/v1/credits/transactions`                                         | The user's credit transaction history              |
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

Activation runs in one transaction: the account check, plan settings, trial write, audit event and the trial credits (the administrator's `trialCredits`, default 50, expiring with the trial; see "Credit-based access to makeup sessions") all succeed or fail together, so a failed activation never uses up the trial and a trial never exists without its credits. Repeated or concurrent requests cannot create a second trial, allocate trial credits again or change an existing trial's dates.

Pro feature endpoints are protected by `ProAccessGuard`, applied after `AuthGuard` in any module that imports `SubscriptionModule`:

```ts
@UseGuards(AuthGuard, ProAccessGuard)
@Get('some-pro-feature')
handler(@Req() req: ProAccessRequest) { /* req.proAccess: status, accessSource, accessExpiresAt */ }
```

The guard delegates to `SubscriptionAccessService`, the single Pro access decision. An active free trial and an active paid term unlock the same features, each within its own `[startedAt, expiresAt)` window. Without access, the guard returns `403` with `An active Pro subscription or free trial is required` and the handler does not run. Requests that did not pass `AuthGuard` are rejected with `401`, and lookup errors never grant access. The only makeup endpoint using the guard is `POST /v1/sessions`, in credit mode (`@RequireCredits()`; see "Credit-based access to makeup sessions").

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

Database tests (`test/auth-state.e2e-spec.ts`, `test/postgres-job-queue.e2e-spec.ts`, `test/postgres-mode.e2e-spec.ts`, `test/rate-limit-contract.e2e-spec.ts` (PostgreSQL part), `test/subscription-plan.*.e2e-spec.ts`, `test/user-subscription.*.e2e-spec.ts`, `test/subscription-trial.e2e-spec.ts`, `test/subscription-status.e2e-spec.ts`, `test/pro-access.e2e-spec.ts`, `test/trial-lifecycle.e2e-spec.ts`, `test/billing.e2e-spec.ts`, `test/subscription-security.e2e-spec.ts`, `test/privacy-export.e2e-spec.ts`, `test/account-deletion.e2e-spec.ts`, `test/account-erasure.e2e-spec.ts`, `test/stripe-checkout.e2e-spec.ts`, `test/stripe-renewal.e2e-spec.ts`, `test/stripe-payment-failure.e2e-spec.ts`, `test/stripe-cancellation.e2e-spec.ts`, `test/stripe-refund.e2e-spec.ts`, `test/subscription-billing.e2e-spec.ts`, `test/stripe-webhook-reliability.e2e-spec.ts`, `test/stripe-payment-lifecycle.e2e-spec.ts`) run only when `TEST_DATABASE_URL` is set, and are reported as skipped otherwise. Each test builds a temporary schema from the migration files and drops it afterwards, so the database user needs `CREATE` permission:

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


### AI credit settings

Configuration for the AI credit system. Credit features read it through `CreditSettingsService.getSettings()` (exported by `CreditsModule`): trial and monthly Pro allocations use the allowances, AI usage deductions use `creditCostUsdMicros` and `deductionStepMicroCredits` (see "AI usage and credit deductions"), and sessions use `sessionOverageCredits`, fixed when each session is initialized (see "Session credit overage and concurrency control"). A change applies to later allocations, charges and sessions only.

| Method  | Route                        | Purpose                                |
| ------- | ---------------------------- | -------------------------------------- |
| `GET`   | `/v1/admin/credit-settings`  | Read the credit configuration          |
| `PATCH` | `/v1/admin/credit-settings`  | Change any subset of the configuration |

Access works like the plan administration routes: a bearer token for an `ADMIN` or `SUPERADMIN` account is required. Missing, invalid or revoked tokens receive `401`, and other roles (`USER`, `MODERATOR`) receive `403` for both reading and changing.

The settings are one row in the `CreditSettings` table (migration `20261122120000_add_credit_settings`). The defaults are the table's column defaults and are stored in PostgreSQL before any administrator change: migration `20261123120000_seed_credit_settings` inserts the row, and at startup the application inserts it again if it is missing (for example after a manual delete). Both use `INSERT ... ON CONFLICT DO NOTHING`, so a stored row, including every administrator change, is never overwritten by a deployment or restart. The application does not fall back to values in code. Defaults:

| Field                       | Type    | Default         | Accepted values                                                        |
| --------------------------- | ------- | --------------- | ---------------------------------------------------------------------- |
| `trialCredits`              | integer | `50`            | `1`–`100000` (switch the trial off on the plan instead)                |
| `proMonthlyCredits`         | integer | `1000`          | `1`–`1000000`                                                          |
| `creditCostUsdMicros`       | integer | `5000` ($0.005) | `1`–`1000000` millionths of a US dollar ($0.000001–$1)                 |
| `sessionOverageCredits`     | integer | `5`             | `0`–`1000` (`0` = no overage)                                          |
| `deductionStepMicroCredits` | integer | `1` (exact)     | `1`–`1000000` millionths of a credit (deductions are rounded up to it) |

`creditCostUsdMicros` is the OpenRouter cost one credit covers, in millionths of a US dollar, so money is never stored as a floating-point number: `5000` is $0.005, `2500` is $0.0025. Responses also contain the read-only `creditCostUsd` (the same amount as an exact decimal string, e.g. `"0.005"`), `deductionStepCredits` (the step in credits, e.g. `"0.000001"` or `"0.1"`) and `updatedAt` (when the row was last written). `deductionStepMicroCredits` (migration `20261126120000_ai_usage_credit_deductions`) is the granularity of AI usage deductions. The default `1` deducts the exact amount to the ledger's six decimal places: at the default rate, $0.025 -> 5 credits and $0.023 -> 4.6. `100000` rounds up to tenths, and `1000000` to whole credits ($0.023 -> 5). Migration `20261127120000_session_credit_overage` made `1` the default. It also changed a stored `1000000` to `1` if no administrator had ever set the step (audit log).

`PATCH` accepts any subset of the five fields; omitted fields are unchanged. The row is locked during an update, so concurrent changes are applied one at a time. Empty bodies, negative or out-of-range values, zero where not allowed, fractions (including dollar amounts such as `0.005` for `creditCostUsdMicros`), `null`, numeric strings, read-only fields and unknown fields are rejected with `400`. A request with any invalid field changes nothing. CHECK constraints additionally stop any write path from storing a second row, negative allowances, a zero credit cost, or a deduction step outside 1–1000000. Every change is recorded in `ActivityLogEvent` (old value, new value, administrator ID) in the same transaction as the update.

```json
{
  "trialCredits": 50,
  "proMonthlyCredits": 1000,
  "creditCostUsdMicros": 5000,
  "creditCostUsd": "0.005",
  "sessionOverageCredits": 5,
  "deductionStepMicroCredits": 1,
  "deductionStepCredits": "0.000001",
  "updatedAt": "2026-11-23T12:00:00.000Z"
}
```

### Discount, referral, daily reward and credit package settings

Administrator-managed configuration for promotions and credit purchases. For now these routes only store and validate the configuration; nothing applies discounts, grants rewards or sells packages yet. Later features read it through `DiscountSettingsService.getSettings()`, `DailyRewardSettingsService.getSettings()` and `CreditPackageSettingsService.listPackages()` (exported by `DiscountsModule`, `DailyRewardsModule` and `CreditPackagesModule`).

| Method  | Route                                     | Purpose                                         |
| ------- | ----------------------------------------- | ----------------------------------------------- |
| `GET`   | `/v1/admin/discount-settings`             | Read the discount and referral configuration    |
| `PATCH` | `/v1/admin/discount-settings`             | Change any subset of it                         |
| `GET`   | `/v1/admin/daily-reward-settings`         | Read the daily reward configuration             |
| `PATCH` | `/v1/admin/daily-reward-settings`         | Change any subset of it                         |
| `GET`   | `/v1/admin/credit-package-settings`       | List the credit packages (SMALL, MEDIUM, LARGE) |
| `GET`   | `/v1/admin/credit-package-settings/:code` | Read one package                                |
| `PATCH` | `/v1/admin/credit-package-settings/:code` | Change any subset of one package                |

Access works like the other administration routes: a bearer token for an `ADMIN` or `SUPERADMIN` account is required. Missing, invalid or revoked tokens receive `401`, and other roles (`USER`, `MODERATOR`) receive `403` for both reading and changing.

Storage (migration `20261130120000_add_promotion_settings`): `DiscountSettings` and `DailyRewardSettings` are single-row tables (`id = 1`) and `CreditPackage` has one row per package code. The migration stores the defaults, and at startup the application inserts any missing row again (for example after a manual delete). Both use `INSERT ... ON CONFLICT DO NOTHING`, so administrator changes are never overwritten by a deployment or restart.

**Discount settings.** `0` switches the corresponding offer off; all three default to `0`.

| Field                          | Type    | Default | Accepted values                                                            |
| ------------------------------ | ------- | ------- | -------------------------------------------------------------------------- |
| `firstPurchaseDiscountPercent` | integer | `0`     | `0`–`100` whole percent off a user's first paying purchase                 |
| `referralDiscountPercent`      | integer | `0`     | `0`–`100` whole percent off the purchase of a referred user                |
| `referrerRewardCredits`        | integer | `0`     | `0`–`100000` credits for the referring user after the referred user's first paying purchase succeeds |

Responses also contain the read-only `firstPurchaseDiscountActive`, `referralDiscountActive` and `referrerRewardActive` (whether the value is above `0`) and `updatedAt`.

**Daily reward settings.** The reward for the n-th consecutive day is `min(startingRewardCredits + (n - 1) × dailyIncrementCredits, maxDailyRewardCredits)`: with the defaults 10, 20, 30, 40, 50, 50, … credits.

| Field                   | Type    | Default | Accepted values                              |
| ----------------------- | ------- | ------- | -------------------------------------------- |
| `startingRewardCredits` | integer | `10`    | `1`–`600`, at most `maxDailyRewardCredits`   |
| `dailyIncrementCredits` | integer | `10`    | `0`–`600` (`0` = the same reward every day)  |
| `maxDailyRewardCredits` | integer | `50`    | `1`–`600`, at least `startingRewardCredits`  |

A user can receive at most **600** daily reward credits per UTC calendar month. This is a fixed product rule (`DAILY_REWARD_MONTHLY_CAP_CREDITS`), not a setting: responses show it as the read-only `monthlyCapCredits`, and no single day's reward may exceed it. The rule `startingRewardCredits <= maxDailyRewardCredits` is checked on the combined result of the stored values and the request, with the row locked, so a partial update (or two concurrent ones) can never store an invalid combination; a violation answers `400` (e.g. `startingRewardCredits (60) cannot exceed maxDailyRewardCredits (50)`) and changes nothing.

**Credit packages.** The set of packages is fixed; a package is withdrawn from sale with `available: false`, never deleted.

| Code     | Default `credits` | Default `priceUsdCents` | Default `available` |
| -------- | ----------------- | ----------------------- | ------------------- |
| `SMALL`  | `250`             | `500` ($5.00)           | `true`              |
| `MEDIUM` | `500`             | `1000` ($10.00)         | `true`              |
| `LARGE`  | `1000`            | `2000` ($20.00)         | `true`              |

`credits` accepts whole credits `1`–`1000000`, `priceUsdCents` whole US cents `50`–`999999` (`$0.50`, Stripe's minimum charge, to `$9,999.99`; never dollar amounts such as `4.99`), and `available` a boolean. Responses also contain `code`, `currency` (`"USD"`), the read-only `priceUsd` (e.g. `"5.00"`) and `updatedAt`. An unknown code (codes are upper case) answers `404 Credit package not found`.

```json
{
  "code": "SMALL",
  "currency": "USD",
  "credits": 250,
  "priceUsdCents": 500,
  "priceUsd": "5.00",
  "available": true,
  "updatedAt": "2026-11-30T12:00:00.000Z"
}
```

For all three, `PATCH` accepts any subset of the editable fields; omitted fields are unchanged. Empty bodies, negative or out-of-range values, fractions (credits, percentages and cents are whole numbers), `null`, numeric or boolean strings, read-only fields and unknown fields are rejected with `400`. A request with any invalid field changes nothing. The row is locked during an update, so concurrent changes apply one at a time. CHECK constraints additionally stop any write path from storing a second settings row, a negative amount, a percentage outside 0–100, a zero package credit amount or price, or a daily reward above 600 or below the starting reward. Every change is recorded in `ActivityLogEvent` (table `DiscountSettings`, `DailyRewardSettings` or `CreditPackage` with the package code; old value, new value, administrator ID) in the same transaction as the update.

### AI credit wallet and ledger

The persistent store for AI credits, in `CreditWalletService` (exported by `CreditsModule`; users read it through "Credit balance and transaction history"). Trial credits and monthly Pro credits are granted through it (see "Credit-based access to makeup sessions"), and AI usage is debited through it (see "AI usage and credit deductions"); issuing purchased and referral credits is future work. Migration `20261123130000_add_credit_wallet_ledger` adds:

| Table                  | Holds                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `CreditWallet`         | One per user (`authId` unique); created on first use; its row is the lock for every change                                           |
| `CreditAllocation`     | Credits granted from one source: `source` (`TRIAL`, `SUBSCRIPTION`, `PURCHASE`, `REFERRAL`), `sourceReference`, `amount`, `remaining`, `grantedAt`, `expiresAt`; for `SUBSCRIPTION` also `subscriptionId`, `paymentId` and `periodStart` |
| `CreditTransaction`    | Append-only ledger: `GRANT`, `DEBIT`, `EXPIRATION`, signed `amount`, `overageAmount`, `balanceAfter`, `idempotencyKey`, `sessionId`, `occurredAt`, ordered by `sequence`; AI usage debits also `usageCostUsd` and `creditCostUsdMicros` |
| `CreditLedgerEntry`    | How each transaction changed each allocation (signed amount)                                                                         |
| `CreditSessionOverage` | The credit record of each initialized makeup session: `status`, reserved credits, overage limit and overage used (see "Session credit overage and concurrency control") |

Rules:

- **Ownership.** Allocations, transactions and overage rows carry `(walletId, authId)`, which must match the wallet's (composite foreign key). Entries can only link a transaction and an allocation of the same wallet.
- **Sources and expiry.** `TRIAL` and `SUBSCRIPTION` credits must have an `expiresAt` after the grant; `PURCHASE` and `REFERRAL` credits never expire (`expiresAt` is `NULL`). A user receives `TRIAL` credits at most once. All of this is enforced by CHECK constraints and a partial unique index as well as by the service.
- **Fractional amounts.** `NUMERIC(18, 6)` in PostgreSQL and `Prisma.Decimal` in the application, never floating point. Amounts with more than six decimal places are rejected, not rounded; views return exact decimal strings (`"0.3"`).
- **Available balance** is the sum of `remaining` over allocations whose period has started (`periodStart IS NULL OR periodStart <= now`) and that have not expired (`expiresAt IS NULL OR expiresAt > now`). Expired credits stop counting at the exact expiry instant, even before their expiration has been recorded. Credits of a month that has not started yet (a renewal paid before its period) are reported as `upcoming`. Each transaction's `balanceAfter` is what the wallet holds after it: the available balance plus upcoming credits.
- **Debits** spend the credits that expire soonest first, then never-expiring credits (oldest first). A debit the balance cannot cover is rejected (`403` `Insufficient credits`, the same response as `POST /v1/sessions` without credits; code `INSUFFICIENT_CREDITS`) and writes nothing, unless it is for one of the user's initialized makeup sessions: then the shortfall may use the session's overage allowance (`sessionOverageCredits`, fixed when the session is initialized). Debits never spend credits reserved by the user's other sessions. Overage is recorded in `overageAmount` and `CreditSessionOverage`; it is not repaid from later grants (see "Session credit overage and concurrency control").
- **Expirations.** Every expired allocation that still holds credits is closed with one `EXPIRATION` transaction (effective at the expiry time, `description` naming the source), so expired credits are traceable in the history of every wallet, including wallets nobody uses any more. `CreditExpirationSweepService` records them at startup and then every `CREDIT_EXPIRATION_SWEEP_INTERVAL_MS` (default 60 s, minimum 10 s; not started when `NODE_ENV=test`), in bounded batches, skipping and retrying wallets that fail; any change to a wallet also records its due expirations first. Several instances can sweep at once: each expiration is written once, under the wallet's lock.
- **Concurrency.** Every change locks the user's wallet row (`SELECT ... FOR UPDATE`), so concurrent grants, debits and expirations of one user apply one at a time; different users do not block each other. Grants are idempotent per `(user, source, sourceReference)` (a repeat with the same values returns the original; different values are a `409` conflict) and debits per `(user, idempotencyKey)`; unique indexes enforce the same at the database level.
- **Reliable history.** Transactions and entries cannot be updated or deleted; an allocation's grant details cannot change and its `remaining` can only decrease. At commit, database triggers check that each allocation's `remaining` and each transaction's `amount` equal the sum of their entries, that every `balanceAfter` continues the previous one, and that the latest `balanceAfter` equals what the wallet's allocations hold. Deleting the user deletes the wallet and its history (account erasure); nothing else can.

### Credit-based access to makeup sessions

Creating a makeup session (`POST /v1/sessions`) requires usable credits that no other session has reserved (see "Session credit overage and concurrency control"). Without them the request is rejected with `403` and nothing is written:

```json
{ "success": false, "statusCode": 403, "message": "Insufficient credits" }
```

Other endpoints (listing and reading sessions, uploads, completing steps, profile, subscription, ...) stay open to signed-in users without credits, including for sessions they created earlier. The exception is queueing AI requests, which need the session to be able to pay. Creating a session consumes no credits, but it reserves up to one. Its AI requests consume credits (see "AI usage and credit deductions").

The check is `ProAccessGuard` in credit mode: `POST /v1/sessions` uses `@UseGuards(AuthGuard, ProAccessGuard)` with `@RequireCredits()`. Other handlers that use `ProAccessGuard` without `@RequireCredits()` keep the Pro check (`403 An active Pro subscription or free trial is required`). The decision is made by `CreditEligibilityService`:

| Credits                | Where they come from                                                                                                                                               | Usable                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| none                   | A free sign-up: registration and sign-ins never grant credits                                                                                                      | -                                                                               |
| `TRIAL`                | Allocated when the free trial is activated, in the same transaction: `trialCredits` (50), once per user, expiring with the trial. Buying paid Pro during the trial expires the unused rest at once | Only while the trial is active and paid Pro has not been bought                 |
| `SUBSCRIPTION`         | Monthly Pro credits: `proMonthlyCredits` (1000) per month of a successful Stripe payment that creates or renews the paid term. Monthly billing: allocated with the payment for its billing period. Yearly billing: the first month with the payment, then one month at a time as each begins (never 12 months at once). Each expires at the end of its month | Only while the paid term is active. A refund that ends the access a payment paid for also expires that payment's unused credits at once |
| `PURCHASE`, `REFERRAL` | Set up directly in PostgreSQL for now (below); never expire                                                                                                        | Always, with or without Pro, including after Pro expires                        |

Monthly Pro credits (see "Monthly Pro credits from Stripe payments" below) and trial credits (at activation) are allocated with the event that pays for or starts them; trials activated and payments recorded before these releases are caught up on the next `POST /v1/sessions`. Each is allocated once per trial and once per payment and month, also under concurrent requests and redelivered webhooks. Amounts are the credit settings at the time of the allocation; a setting changed later does not alter credits already allocated.

#### Monthly Pro credits from Stripe payments

- **Only successful payments allocate.** The webhook transaction that records a verified first payment (`checkout.session.completed`, or the first invoice's `invoice.paid`) or a verified renewal (`invoice.paid`) and creates or extends the paid term also allocates its credits. Nothing is allocated for failed attempts (`invoice.payment_failed`) and their retries, pending or rejected checkouts, redelivered or concurrent duplicate events (`ALREADY_PROCESSED`), a second payment that does not change the term (`DUPLICATE_PAYMENT`), or a delayed renewal for a period already covered.
- **Fresh credits per payment, one month at a time.** Every term-granting payment writes its months to `CreditAllocationSchedule` in the same transaction (migration `20261125120000_credit_allocation_schedule`): one month for a monthly payment (exactly its billing period as Stripe reports it, anchored periods such as Jan 31 -> Feb 28 -> Mar 31 included), twelve for a yearly payment (counted from its start on the same day, clamped the same way). The first month is allocated with the payment (a renewal paid before its period starts counts from the period start); the later months of a yearly payment are allocated by `CreditAllocationScheduler` when each begins, so a yearly subscriber never holds more than the current month's credits.
- **Monthly allocation scheduler.** `CreditAllocationScheduler` runs at startup and then every `CREDIT_ALLOCATION_INTERVAL_MS` (default 60 s, minimum 10 s; not started when `NODE_ENV=test`); the next `POST /v1/sessions` of the user also allocates a month that has just begun. Each month is a `CreditAllocationSchedule` row that moves `PENDING` -> `ALLOCATED` (with its `allocationId`) or `SKIPPED` (with `skipReason`), never back (database trigger), and is allocated in its own transaction together with that status change:
  - **Restarts.** A worker that stops (or crashes) half-way rolls back only the month it was on; the row stays `PENDING` (with `attempts` and `lastError`) and the next run, including the one at startup, allocates it. Months missed while nothing ran are allocated on restart as of their own start (the `GRANT` is effective at the month start) and, if already over, expire at their end, so the history reads as if the scheduler had run on time; only the current month's credits are usable.
  - **No duplicates.** Workers claim a month with `FOR UPDATE SKIP LOCKED` (a month another worker or instance holds is left to it), a user's request waits for it instead, and the database allows one schedule row per payment and month and one allocation per row and per payment and month. Repeated runs, several instances, restarts and concurrent requests therefore never allocate a month twice.
  - **Only inside the subscription.** A month is allocated only if its payment is still `SUCCEEDED` and the paid term covers the month's start; otherwise (for example after a refund) it is `SKIPPED` (`PAYMENT_NOT_SUCCEEDED`, `OUTSIDE_PAID_TERM`). No months exist beyond the paid period. Payments recorded before this migration have their remaining months scheduled by it. Credits that already exist for a payment and month (granted under another reference) are linked to the month instead of being granted again.
  - **Refunds.** The refund that ends the access a payment paid for also ends that payment's credits, in the same transaction. Its unused credits expire at once, as an `EXPIRATION` with the description `SUBSCRIPTION credits expired: payment refunded`, and its months not allocated yet are `SKIPPED`. Credits of other payments and of other sources are not touched.
- **Expiry at the billing boundary.** Each month's credits expire at its period end, the next billing boundary: the unused rest is removed with an `EXPIRATION` transaction effective at the boundary (written by the expiration sweep or the next change to the wallet), whether or not the subscription renews. Purchased and referral credits are never touched.
- **Linked records.** Each `SUBSCRIPTION` allocation records the user (`authId`), the `UserSubscription` (`subscriptionId`), the `PaymentTransaction` (`paymentId`) and the month (`periodStart` to `expiresAt`), and its `GRANT` transaction references it through the ledger entry. Migration `20261124120000_subscription_credit_allocations` enforces one allocation per payment and month (unique index), and a trigger accepts a new one only for a `SUCCEEDED` payment of the same user's subscription that created or renewed the term (`CREATED`/`RENEWED` event), within the payment's period. The migration also links monthly Pro credits granted by the earlier release to the payment of their month, and stops with an error if one cannot be linked.

To give a user purchased or referral credits until issuance is implemented, run this in PostgreSQL (fill in the first four values; the reference must be unique per user and source). It locks the wallet like the application does and writes the allocation, its `GRANT` transaction and ledger entry together, so the database's ledger checks accept it. The e2e tests run the same statement (`test/support/credit-fixtures.ts`):

```sql
DO $$
DECLARE
  v_auth_id     text := '<user id>';
  v_source      "CreditSource" := 'PURCHASE';  -- 'PURCHASE' or 'REFERRAL'
  v_reference   text := '<unique reference>';  -- unique per user and source
  v_amount      numeric(18, 6) := 100;
  v_wallet      text;
  v_allocation  text := gen_random_uuid()::text;
  v_transaction text := gen_random_uuid()::text;
  v_balance     numeric(18, 6);
BEGIN
  INSERT INTO "CreditWallet" ("id", "authId")
  VALUES (gen_random_uuid()::text, v_auth_id)
  ON CONFLICT ("authId") DO NOTHING;
  SELECT "id" INTO v_wallet FROM "CreditWallet" WHERE "authId" = v_auth_id FOR UPDATE;
  SELECT COALESCE((SELECT "balanceAfter" FROM "CreditTransaction"
                   WHERE "walletId" = v_wallet ORDER BY "sequence" DESC LIMIT 1), 0)
    INTO v_balance;

  INSERT INTO "CreditAllocation" ("id", "walletId", "authId", "source", "sourceReference",
                                  "amount", "remaining", "grantedAt", "expiresAt", "updatedAt")
  VALUES (v_allocation, v_wallet, v_auth_id, v_source, v_reference,
          v_amount, v_amount, now(), NULL, now());
  INSERT INTO "CreditTransaction" ("id", "walletId", "authId", "type", "amount", "balanceAfter",
                                   "idempotencyKey", "description", "occurredAt")
  VALUES (v_transaction, v_wallet, v_auth_id, 'GRANT', v_amount, v_balance + v_amount,
          'grant:' || v_source || ':' || v_reference, 'Set up in PostgreSQL', now());
  INSERT INTO "CreditLedgerEntry" ("id", "walletId", "transactionId", "allocationId", "amount")
  VALUES (gen_random_uuid()::text, v_wallet, v_transaction, v_allocation, v_amount);
END $$;
```

Tests: the unit and HTTP tests in `src/credits` and `src/subscription/credit-*` need no database. `test/credit-settings.e2e-spec.ts` boots the complete application against a temporary, migrated PostgreSQL schema: it checks the stored defaults before any administrator change, signs in through `POST /auth/login`, checks the stored rows and audit records, and restarts the application on the same schema. `test/credit-wallet.e2e-spec.ts` runs the wallet against PostgreSQL: ownership, expiry rules, exact fractions, concurrent grants/debits/overage/expirations, expirations recorded for unused wallets, and the database rules. `test/credit-access.e2e-spec.ts` runs the complete application: free sign-ups and repeated sign-ins, `403 Insufficient credits`, other endpoints staying open, purchased and referral credits (set up in PostgreSQL) after Pro expires, and trial and monthly Pro allowances. `test/credit-subscription.e2e-spec.ts` covers monthly Pro credits through checkout and signed Stripe webhooks with `FakeStripeApi` and controlled time: the initial purchase, annual subscriptions (the first month at purchase and the others scheduled, monthly grants by the scheduler, expiry at each month's end, a whole year and nothing after it, a refund, monthly plans, duplicate events and concurrent runs), renewals (including an admin amount change and a renewal paid early), failed first payments and renewals with retries and recovery, duplicated and concurrent events, expiry at the billing boundary, the database's idempotency and ownership rules, and the migration that links earlier allocations. `test/credit-scheduler.e2e-spec.ts` covers the scheduler with controlled time and real application restarts: months missed while it was stopped, an allocation interrupted half-way, a month held by a hung worker, a restart in the middle of a run, and idempotency under repeated runs, concurrent workers on separate connections and user requests. `test/credit-trial.e2e-spec.ts` covers trial credits through the HTTP API with controlled time and Stripe replaced by a local fake: allocation at activation (including the configured amount and all-or-nothing activation), one-time allocation under repeated and concurrent activations, expiry and its logged `EXPIRATION`, and the upgrade to paid Pro during and after the trial. None contacts an external service (no Redis, Stripe, OpenRouter or SMTP); all are skipped without `TEST_DATABASE_URL`:

```bash
npm test -- --runInBand credit
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/musecue_test npx jest --config ./test/jest-e2e.json --runInBand test/credit-settings test/credit-wallet test/credit-access test/credit-trial test/credit-subscription test/credit-scheduler test/credit-usage test/credit-overage test/credit-apis
```

### AI usage and credit deductions

Every OpenRouter request made by a makeup AI run (analysis, guide generation, visual check, question) is metered and paid for with credits. Migration `20261126120000_ai_usage_credit_deductions` adds the `AiUsage` table, the `deductionStepMicroCredits` setting and the charge columns of `CreditTransaction`.

- **Tracking.** The provider is asked for usage accounting (`usage: { include: true }`). For every response, `AiUsage` stores the user (`authId`), the makeup session (`sessionId`), the AI run (`runId`), the operation, the model, the OpenRouter generation ID (`providerRequestId`), input, output and total tokens and `usage.cost` in US dollars (`costUsd`, `NUMERIC(20, 10)`, parsed as an exact decimal and never as a float). A session can have any number of usage rows, and its totals are summed in PostgreSQL. Responses that OpenRouter billed but that failed (for example invalid structured output) are stored with `outcome` `FAILED`. A generation is stored once (unique `(provider, providerRequestId)`), so a redelivered job never duplicates it.
- **Conversion.** credits = `costUsd` / `creditCostUsdMicros` (default $0.005 per credit), rounded up to the deduction step `deductionStepMicroCredits`. The default step `1` deducts the exact amount to six decimal places: $0.025 -> 5 credits, $0.023 -> 4.6, $0.000123 -> 0.0246. An administrator can choose a coarser step: `100000` rounds up to tenths, and `1000000` to whole credits. Every usage row keeps the exact credits (`creditsExact`), the credits due after rounding (`creditsDue`) and the credits actually deducted (`creditsCharged`).
- **What is charged.** A run is charged once, for the response whose result it publishes. The charge happens in the same transaction that publishes the result: the `DEBIT` (idempotency key `ai-run:<runId>`) and the usage's charge are committed with the result or not at all. Failed attempts, retried requests and results that are never published (for example a cancelled run) are recorded as `NOT_CHARGED` with a `chargeNote` (`FAILED_ATTEMPT`, `RESULT_DISCARDED`, ...), and the platform absorbs their cost. A response without a reported cost is `NOT_CHARGED` (`COST_UNAVAILABLE`).
- **History.** The `DEBIT` stores the OpenRouter cost (`usageCostUsd`) and the rate that was used (`creditCostUsdMicros`) next to the credits (`amount`). The usage row stores the same rate and its `transactionId`. A database trigger keeps the usage facts immutable and lets the charge be written only once (from `PENDING`). Another trigger (migration `20261129120000_credit_review_constraints`) checks that a charged usage matches its `DEBIT`: the same user, session, cost and rate, and `creditsCharged` equal to the credits taken from the balance plus the overage. Changing the rate or the step therefore affects only later charges, never the ones already recorded.
- **Retries, duplicates and concurrency.** Repeating a charge (a job retry, a redelivered job or a second worker) finds the run's `DEBIT` by its idempotency key and deducts nothing (`RUN_ALREADY_CHARGED`). Charges lock the user's wallet row, so parallel requests of a user are deducted one after another and exactly.
- **Not enough credits.** When an AI run is queued, and again before the worker calls OpenRouter, the session must have free credits or unused overage. Otherwise the request is refused with `403 Insufficient credits`, or the run fails with `Insufficient credits` (`INSUFFICIENT_CREDITS`, not retried), and OpenRouter is not contacted. If a finished request costs more than the free balance and the session's overage can cover, everything available is deducted. The usage is recorded as `UNCOLLECTED` with the shortfall (`creditsDue` > `creditsCharged`), and the result is still delivered, because OpenRouter has already been paid. Only credits the user may use now are spent (for example, no expired trial credits; see "Session credit overage and concurrency control").
- `AI_MODE=mock` reports no usage, so nothing is recorded or charged.

`GET /v1/sessions/:sessionId/ai-usage` returns the caller's own session usage (`404` for another user's session). `costUsd` and the credit amounts are exact decimal strings:

```json
{
  "usages": [
    {
      "id": "...",
      "runId": "...",
      "operation": "GUIDE_GENERATION",
      "model": "openai/gpt-4o-mini",
      "outcome": "SUCCEEDED",
      "inputTokens": 1200,
      "outputTokens": 300,
      "totalTokens": 1500,
      "costUsd": "0.025",
      "chargeStatus": "CHARGED",
      "chargeNote": null,
      "creditCostUsdMicros": 5000,
      "creditCostUsd": "0.005",
      "creditsExact": "5",
      "creditsDue": "5",
      "creditsCharged": "5",
      "overageCredits": "0",
      "transactionId": "...",
      "occurredAt": "2026-11-26T12:00:00.000Z"
    }
  ],
  "totals": {
    "requests": 1,
    "inputTokens": 1200,
    "outputTokens": 300,
    "totalTokens": 1500,
    "costUsd": "0.025",
    "creditsCharged": "5",
    "overageCredits": "0",
    "uncollectedCredits": "0"
  },
  "credits": { "reservedCredits": "1", "reservationRemaining": "0", "overageLimit": "5", "overageUsed": "0", "...": "..." }
}
```

Tests: `test/credit-usage.e2e-spec.ts` runs the complete application with `AI_MODE=live` against a local fake of the OpenRouter API (`test/support/fake-openrouter.ts`; no network access). It covers several requests per session with exact sums, the $0.025 -> 5 credit deduction, exact fractional deductions and the stored history, a configured rounding step, retried requests (tracked, charged once), duplicated deliveries and repeated charges, parallel requests, and a user who runs out of credits (partial collection, then refusal without calling OpenRouter). `test/credit-settings.e2e-spec.ts` also changes the conversion rate through the admin API. Charges made after the change use the new rate ($0.025 at $0.002 per credit -> 12.5 credits), and earlier deductions keep their rate and credits. Unit tests: `src/credits/credit-usage.service.spec.ts`, `src/makeup/makeup-credit.service.spec.ts`, `src/makeup/queues/makeup-job-credit.spec.ts`, `src/makeup/ai/providers/openrouter-credit-usage.spec.ts`.

### Session credit overage and concurrency control

A makeup session that starts with credits can finish even when its actual OpenRouter usage goes beyond the balance. The part the balance cannot cover becomes **session overage**, up to the administrator's `sessionOverageCredits` (default 5 credits per session). The balance itself never goes below zero. Migration `20261127120000_session_credit_overage` extends `CreditSessionOverage` into the session's credit record.

- **Initialization.** `POST /v1/sessions` creates the session and initializes it in the same transaction, under the user's wallet lock. Initialization needs **free credits**: the usable balance minus the credits the user's other sessions have reserved. It reserves up to one of them for the session (`reservedCredits`) and fixes the session's overage limit (`overageLimit`, the setting at that moment). Without free credits nothing is created and the response is `403 Insufficient credits`. Because these steps run one at a time under the lock, one credit can only initialize one session. For example, six concurrent `POST /v1/sessions` with 1 credit give one `201` and five `403`.
- **Charges.** A session's charges use its reservation and the free balance first, never credits reserved by the user's other sessions. The rest is covered by its overage, up to its limit, and what neither covers is recorded as `UNCOLLECTED`. Example: a session initialized with 1 credit that uses 6 credits is charged 1 credit from the balance and 5 as overage, and the balance ends at 0. A session that used 5 credits would be charged 1 from the balance and 4 as overage, keeping 1 credit of overage. Overage is recorded on the `DEBIT` (`overageAmount`, with `authId` and `sessionId`) and in the session's `CreditSessionOverage.overageUsed`. It is never repaid from later grants.
- **AI requests.** Queueing an AI run (`analyze`, `select`, `check`, `questions`) checks, under the session and wallet locks, that the session can still pay: free credits or overage left. Otherwise the request fails with `403 Insufficient credits`, and no run is created or sent to OpenRouter. The worker checks again before it calls OpenRouter. If the session cannot pay, the run fails with `Insufficient credits` (not retried). A session that was never initialized (for example, created before this release) is initialized at its first AI request if free credits exist. Otherwise it is refused and gets no overage. Non-AI actions such as uploads and completing steps stay open, so a session whose overage is used up can still be completed.
- **Every subsequent session** needs free credits again: once the balance and the reservations are used up, `POST /v1/sessions` answers `403 Insufficient credits` until new credits arrive.
- **Releasing reservations.** An unfinished session keeps its reservation and its overage allowance however long it is idle, so it can always be continued. A completed or deleted session releases the unused rest of its reservation. A reservation only holds credits that still exist: once reserved credits expire, the reservations of unfinished sessions are reduced (oldest first) to the credits left, so new credits can start a new session. These releases are applied whenever the user's wallet is locked. (Migration `20261128120000_remove_session_reservation_lapse` removed an earlier idle lapse.)
- **Concurrency control.** Initialization, AI-request checks, charges, grants and expirations of one user all lock the user's `CreditWallet` row, so they apply one at a time against the latest balance, reservations and overage. Charges of one run also lock the run's usage rows, in a fixed order. Each run is charged at most once (`DEBIT` idempotency key `ai-run:<runId>`). Under any number of concurrent sessions and requests, a credit is therefore never spent twice and a session never exceeds its overage limit.
- **Interrupted and unsuccessful requests.** OpenRouter errors without a response are not recorded, and billed failures are recorded as `FAILED` (never charged). A retried run is charged once, for the response it publishes. Usage left `PENDING` by an attempt that stopped after OpenRouter answered is settled as `NOT_CHARGED`:
  - `SUPERSEDED_ATTEMPT` when another attempt publishes the run's result;
  - `RUN_FAILED` when the run fails;
  - `INTERRUPTED` for anything left over, settled by the AI recovery sweep (`MakeupRecoveryService`).
  
  None of these writes a second deduction or overage record.
- **Database rules.** CHECK constraints keep `0 <= overageUsed <= overageLimit` and `0 <= reservationRemaining <= reservedCredits`. A trigger fixes the limit, lets overage only grow, and lets a reservation only be used up or released. A deferred trigger checks at commit that every session's `overageUsed` equals the sum of the `overageAmount` of its `DEBIT`s, and that no `DEBIT` uses overage without the session's record.

`GET /v1/sessions/:sessionId/ai-usage` shows the session's credit state next to its usage (`overageCredits` per request and in the totals):

```json
"credits": {
  "sessionId": "...",
  "reservedCredits": "1",
  "reservationRemaining": "0",
  "overageLimit": "5",
  "overageUsed": "5",
  "overageRemaining": "0",
  "initializedAt": "2026-11-27T12:00:00.000Z"
}
```

Tests: `test/credit-overage.e2e-spec.ts` runs the complete application with `AI_MODE=live` against the local OpenRouter fake and checks the stored rows. It covers:
- a session initialized with 1 credit that uses 5 and then 6 credits (1 deducted + 4, then 5 overage) and is then completed;
- `403 Insufficient credits` for later sessions and AI requests;
- the administrator's overage limit, fixed at initialization;
- concurrent session creation (1 credit gives exactly one session; 2.5 credits give three);
- concurrent sessions and parallel AI requests without double spend or overage bypass, and 30 concurrent charges, including duplicated charges of one run;
- retried, interrupted and failed OpenRouter requests;
- reservation release for completed sessions, and unfinished sessions keeping theirs however long they are idle;
- the PostgreSQL rules;
- the migrations, applied to data of the earlier releases: the new default deduction step (kept if an administrator chose one), sessions that used overage before, lapsed sessions, and AI usage charges that must match their `DEBIT`.

Unit tests: `src/credits/credit-wallet.service.spec.ts` (sessions), `src/credits/credit-session.policy.spec.ts` and `src/makeup/makeup-session-credit.spec.ts`.

### Credit balance and transaction history

The signed-in user's own credits, read-only. Each route requires a bearer token (`401` without a valid one, including a token revoked by a security event such as logout-all). The user is always the token's user and is never a request parameter, so no route can show another user's credits: user parameters (e.g. `?userId=`) are rejected with `400`, and another user's session is `404 Session not found`. The routes are open to every signed-in user, with or without credits, Pro or a trial. History stays readable after credits expired, after the subscription ended and after a session was deleted (`CreditAccountModule`, `src/credits/account`).

| Method | Route                                | Purpose                                                                 |
| ------ | ------------------------------------ | ----------------------------------------------------------------------- |
| `GET`  | `/v1/credits/balance`                | Balance by source: granted, available, used, expired, expiry dates      |
| `GET`  | `/v1/credits/transactions`           | Allocations, deductions (with session overage) and expirations          |
| `GET`  | `/v1/sessions/:sessionId/ai-usage`   | AI requests of a session: tokens, cost, rate, credits, overage          |

**Balance.** Every allocation is split into `available`, `upcoming` (a month that has not started), `used` and `expired`, which add up to `granted`. Credits past their expiry count as `expired` at once, even before the expiration is written to the ledger, so expired credits never count towards `available`. `PURCHASE` and `REFERRAL` credits never expire (`expires: false`, `expiresAt: null`) and stay available. Response fields:
- totals: `available` (all sources), `usable` (sources the user may spend now; trial credits only during the trial, subscription credits only during the paid term), `reserved` (held by unfinished sessions), `free` (usable minus reserved: what a new session can start with), `upcoming`, `granted`, `used`, `expired`, and `overageUsed` (session overage in total);
- `nextExpiration`: the earliest expiry, with the amount and sources;
- `sources`: all four sources, each with the same amounts, `expires`, `usableNow` and `nextExpiresAt`;
- `allocations`: every allocation, newest first, with `state` (`AVAILABLE`, `UPCOMING`, `USED_UP`, `EXPIRED`), `grantedAt`, `expiresAt` and `expiredAt`.

```json
{
  "available": "26", "usable": "26", "reserved": "0", "free": "26", "upcoming": "0",
  "granted": "1085", "used": "219", "expired": "840", "overageUsed": "0",
  "nextExpiration": null,
  "sources": [
    { "source": "TRIAL", "granted": "50", "available": "0", "upcoming": "0", "used": "10", "expired": "40", "expires": true, "usableNow": false, "nextExpiresAt": null },
    { "source": "PURCHASE", "granted": "30", "available": "21", "upcoming": "0", "used": "9", "expired": "0", "expires": false, "usableNow": true, "nextExpiresAt": null }
  ],
  "allocations": [
    { "id": "...", "source": "TRIAL", "state": "EXPIRED", "granted": "50", "available": "0", "upcoming": "0", "used": "10", "expired": "40",
      "grantedAt": "2026-10-21T10:00:00.000Z", "periodStart": null, "expiresAt": "2026-10-28T10:00:00.000Z", "expiredAt": "2026-10-28T10:00:00.000Z" }
  ],
  "asOf": "2026-11-30T10:00:00.000Z"
}
```

**Transaction history.** `GET /v1/credits/transactions?limit=&before=&type=&sessionId=` returns the ledger newest first:
- `limit`: 1-100, default 50.
- `before`: the previous page's `nextCursor`.
- `type`: `ALLOCATION`, `DEDUCTION`, `EXPIRATION`, or `OVERAGE` (deductions that used session overage).
- `sessionId`: one of the caller's sessions, also a deleted one.

Each item has:
- `type` (`ALLOCATION`, `DEDUCTION`, `EXPIRATION`), the signed `amount` (change to the balance), `overageAmount` and `creditsCharged` (the balance part plus overage), and `balanceAfter`;
- the credit `source`: the allocation's source, or `MIXED` when a deduction took from several sources or used overage. `sources` details each part with its `allocationId` and `expiresAt`, and the overage part as `SESSION_OVERAGE`;
- `occurredAt`: when the change took effect; an expiration takes effect at the expiry;
- `sessionId` and `session` (`null` once the session is deleted; `sessionId` is kept);
- for AI deductions, `aiUsage`: the run, operation, model, tokens, USD cost, conversion rate (`creditCostUsdMicros`, `creditCostUsd`) and credits.

```json
{
  "items": [
    {
      "id": "...", "sequence": "42", "type": "DEDUCTION",
      "amount": "-1", "overageAmount": "3", "creditsCharged": "4", "balanceAfter": "0",
      "source": "MIXED",
      "sources": [
        { "source": "REFERRAL", "amount": "-1", "allocationId": "...", "expiresAt": null },
        { "source": "SESSION_OVERAGE", "amount": "-3", "allocationId": null, "expiresAt": null }
      ],
      "description": "AI PERSONALIZATION (openai/gpt-4.1-mini)",
      "occurredAt": "2026-11-30T10:00:00.000Z",
      "sessionId": "...", "session": { "id": "...", "status": "RECOMMENDATIONS_READY", "createdAt": "..." },
      "aiUsage": { "id": "...", "runId": "...", "operation": "PERSONALIZATION", "model": "openai/gpt-4.1-mini",
                   "inputTokens": 1000, "outputTokens": 250, "totalTokens": 1250, "costUsd": "0.02",
                   "creditCostUsdMicros": 5000, "creditCostUsd": "0.005", "creditsDue": "4", "creditsCharged": "4" }
    }
  ],
  "nextCursor": null
}
```

**Session AI usage.** `GET /v1/sessions/:sessionId/ai-usage` lists each OpenRouter request of the session once, oldest first. A retried or repeated request is never listed twice, and a billed failure is listed as `FAILED` / `NOT_CHARGED`. Each entry shows the input, output and total tokens, `costUsd`, the conversion rate used (`creditCostUsdMicros`, `creditCostUsd`), `creditsExact`, `creditsDue` and `creditsCharged`, `overageCredits`, `chargeStatus` and `chargeNote`, and the `transactionId` of its deduction in the history. The totals add `overageCredits` and `uncollectedCredits`, and `credits` shows the session's reservation and overage (see "AI usage and credit deductions"). Another user's session is `404`. A deleted session's usage stays readable.

Tests: `test/credit-apis.e2e-spec.ts` runs the complete application with `AI_MODE=live` against the local OpenRouter fake. Earlier months are set up through the wallet with their own dates. It covers:
- a user with an expired trial, an expired Pro month (and ended subscription), purchased and referral credits, and a makeup session with retried and repeated AI requests, and a new user without credits;
- the balance by source and by allocation, with expiry dates;
- credits with a next expiry, session overage, and reserved credits;
- the full history with amounts, sources, types, dates, balances, sessions and AI usage;
- the type and session filters, and paging;
- the history after expiry, subscription end and session deletion;
- the AI usage of sessions without duplicates;
- `401` for missing, invalid and revoked tokens, `400` for user parameters and invalid queries, and `404` for another user's session.

Unit tests: `src/credits/account/credit-account.policy.spec.ts` and `src/credits/account/credit-account.service.spec.ts`.

## Domain

```text
authUser
|-- RefreshSession (hashed refresh tokens, rotation lineage)
|-- AuthChallenge (hashed one-time codes, one per purpose)
|-- InfrastructureJob (PostgreSQL queue driver; deleted with the account)
|-- PaymentCustomer (0..1 per provider)
|-- UserSubscription (0..1)
|-- CreditWallet (0..1)
|   |-- CreditAllocation -> CreditLedgerEntry
|   |-- CreditTransaction -> CreditLedgerEntry
|   `-- CreditSessionOverage (session credit record: reservation and overage; references a MakeupSession id without a foreign key)
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
SubscriptionPlan, CreditSettings, DiscountSettings, DailyRewardSettings: single-row administrator configuration, no owner
CreditPackage: administrator configuration, one row per package code (SMALL, MEDIUM, LARGE), no owner
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
npm test -- --runInBand credit   # AI credit unit/HTTP tests
TEST_DATABASE_URL=... npx jest --config ./test/jest-e2e.json --runInBand test/credit-settings test/credit-wallet test/credit-access test/credit-trial test/credit-subscription test/credit-scheduler test/credit-usage test/credit-overage test/credit-apis   # AI credits on PostgreSQL
npx jest discount   # discount and referral settings unit/HTTP tests (likewise: daily, credit-package)
TEST_DATABASE_URL=... npx jest --config ./test/jest-e2e.json discount   # discount settings on PostgreSQL (likewise: daily, credit-package)
TEST_DATABASE_URL=... npx jest --config ./test/jest-e2e.json test/private-cloud   # storage workflows + cleanup ledger on PostgreSQL (mocked Supabase)
npm run test:e2e
npx prisma generate
npx prisma migrate dev
npx prisma migrate deploy
```

### Storage merge and privacy workflows

Privacy exports read photos from their recorded provider and object key. Account erasure preserves that provider on each deletion record and sweeps each configured backend, including legacy local files. Apply the `20261119120000_account_erasure_storage_provider` migration with the merge so deletion retries continue to target the correct backend. New providers must implement owner enumeration for account erasure.
