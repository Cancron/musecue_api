# MuseCue API

**AI makeup guidance, made for your face.**

The MuseCue API is the NestJS authority for authentication, authorization, workflow state, persistence, and AI orchestration. Supabase is not used. AI providers may interpret or generate data, but only NestJS validates results and advances application state.

The companion mobile application and detailed product specifications live in `../face_makeup_app`.

## Implemented

- PostgreSQL/Prisma local accounts, SMTP verification through BullMQ, login auditing, account lockout, and Google OAuth foundations
- short-lived JWT access tokens and rotating, revocable Redis-backed refresh tokens
- owner-scoped makeup sessions and the documented workflow state machine
- validated multipart image upload, private filesystem storage, image metadata, structured preferences, face analysis, ranked recommendations, saved looks, and selection
- generated guides, authoritative step progression, retained visual attempts, contextual questions, completion history, profile statistics, and optional private profile avatars
- BullMQ jobs for personalization, guide generation, visual checks, and guide questions
- `AiRun` audit records containing operation, provider, model, prompt version, latency, progress, result/error, and status
- a provider-neutral AI gateway with OpenRouter live mode, multimodal private-image input, strict structured output, runtime validation, bounded retries, and deterministic mock mode
- a single Pro subscription plan: admin-configured monthly/yearly pricing and free trial, one-time trial activation, date-based Pro access through `ProAccessGuard`, and payment/lifecycle records protected by database rules (see "Subscriptions" under API); checkout, webhooks and billing endpoints are not implemented yet
- personal data export: an authenticated user can request an asynchronous ZIP archive of their own account, profile, makeup history, subscription records and private photos, poll its status, and download it through a signed link valid for at most 15 minutes; archives expire 24 hours after export and are deleted by a scheduled retention sweep (see "Personal data export" under API)
- account deletion: the owner confirms their identity (password and an emailed code, or the code alone for accounts without a password), the account is blocked and every token invalidated at once (`PENDING_DELETION`), and a background sweep hard-deletes the account and all its data and files, keeping payment records detached (see "Account deletion" under API)

Migration `20260827174107_add_makeup_workflow` adds the makeup aggregate and removes the dormant job-tracker and subscription starter domains.

Intentionally deferred:

- a production cloud object-storage adapter and short-lived signed reads; the current private filesystem adapter is intended for local/self-hosted deployments
- generated preview images (recommendation reasoning is live, while the existing curated preview-image contract remains in place)
- production retention/deletion automation and AI cost accounting

## Requirements and setup

- Node.js 22+
- PostgreSQL 17
- Redis 7+
- working SMTP credentials

### Check PostgreSQL and Redis on Ubuntu

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

The API defaults to `http://localhost:5000`; development Swagger is at `http://localhost:5000/docs`.

Important environment variables are documented in `.env.example`. Never commit the real `.env` or log SMTP credentials, tokens, image contents, or future signed URLs.

`PRIVATE_UPLOAD_DIR` controls the private image root and defaults to `.data/private-images`. The directory is ignored by Git and is never mounted as a public static directory.

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
  - When a user is hard-deleted, their subscription is deleted and their payments are kept, detached: `subscriptionId` becomes `NULL` (`ON DELETE SET NULL`, migration `20260929120000_account_erasure`). This is the only change the database allows to `subscriptionId`, and only once the subscription no longer exists. A payment is never moved, re-attached or deleted.
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

Database tests (`test/subscription-plan.*.e2e-spec.ts`, `test/user-subscription.*.e2e-spec.ts`, `test/subscription-trial.e2e-spec.ts`, `test/subscription-status.e2e-spec.ts`, `test/pro-access.e2e-spec.ts`, `test/trial-lifecycle.e2e-spec.ts`, `test/billing.e2e-spec.ts`, `test/subscription-security.e2e-spec.ts`, `test/privacy-export.e2e-spec.ts`, `test/account-deletion.e2e-spec.ts`, `test/account-erasure.e2e-spec.ts`) run only when `TEST_DATABASE_URL` is set, and are reported as skipped otherwise. Each test builds a temporary schema from the migration files and drops it afterwards, so the database user needs `CREATE` permission:

```bash
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/musecue_test npx jest --config ./test/jest-e2e.json test/subscription-plan test/user-subscription test/subscription-trial test/subscription-status test/pro-access test/trial-lifecycle test/billing test/subscription-security test/privacy-export test/account-deletion test/account-erasure
```

Personal data export unit tests (no database or Redis needed):

```bash
npm test -- --runInBand privacy
```


### Personal data export

Routes require a bearer token. The owner is always the token's user; requests cannot name another user.

| Method | Route                            | Purpose                                          |
| ------ | -------------------------------- | ------------------------------------------------ |
| `POST` | `/v1/privacy/exports`            | Queue a ZIP export of the caller's data (`202`)  |
| `GET`  | `/v1/privacy/exports`            | List the caller's 20 most recent exports         |
| `GET`  | `/v1/privacy/exports/:exportId`  | Poll one export's status and progress            |
| `GET`  | `/v1/privacy/exports/:exportId/download` | Get a signed download link (max 15 minutes) |
| `GET`  | `/v1/privacy/exports/:exportId/archive?expires&signature` | Download the archive with the signed link |

`POST /v1/privacy/exports` takes no body; any body field (for example `userId`) is rejected with `400`. An optional `Idempotency-Key` header (1-128 characters of `A-Z a-z 0-9 _ . : -`) returns the same export on retry. Only one export per user can be `QUEUED` or `PROCESSING` at a time (a partial unique index); further requests, including concurrent ones, return that export instead of starting another. The route uses the strict rate limit. If the queue is unavailable the export is recorded as `FAILED` and the request returns `503`.

Status responses contain `id`, `status` (`QUEUED`, `PROCESSING`, `COMPLETED`, `FAILED` or `EXPIRED`), `progress` (0-100), `requestedAt`, `startedAt`, `completedAt`, `expiresAt`, `sizeBytes`, `sha256`, `photoCount`, `missingPhotoCount`, `attempts`, and, for a `FAILED` export, a client-safe `error` message with a machine-readable `errorCode`. Storage locations and idempotency keys are never returned. Another user's export returns the same `404` as a missing one, and malformed IDs return `400`. A completed export reports `EXPIRED` once `expiresAt` (completion + 24 hours) has passed.

The `privacy-export` BullMQ worker builds the archive outside the request:

```text
README.txt
manifest.json               every file with its size and SHA-256, plus photos that could not be included
data/account.json           account details and security settings (MFA on/off, last password change)
data/profile.json           profile and avatar reference
data/makeup-history.json    sessions, preferences, analyses, recommendations, guides, checks, questions, AI processing records
data/subscription.json      current access status, subscription record, payments and lifecycle events
data/sign-in-history.json
data/email-history.json
photos/profile/avatar.<ext>
photos/sessions/<sessionId>/<imageId>.<ext>
```

Every query is scoped to the owner, and every document is built from an explicit field allowlist. Password hashes, token versions, MFA secrets, OAuth provider subject IDs, storage keys, idempotency keys, raw AI results, payment-provider IDs, SMTP message IDs and activity-log rows (which can describe other users' records) are never exported. A photo is copied only if its storage key has exactly the format the image storage writes for that owner and scope (`<authId>/<sessionId or profile>/<file>.<jpg|png|webp>`). Keys with backslashes, `.`/`..`/empty segments, another owner or session, absolute paths or drive letters are refused. The shared private-storage resolver also rejects backslashes and dot segments on every platform. Photos are streamed one at a time. Missing files are listed in the manifest instead of failing the export.

Each worker attempt claims the export with a new `startedAt`. Progress, publication and failure are conditioned on that value, so a stalled attempt cannot overwrite a newer one. Retryable failures are retried 3 times with exponential backoff; between attempts the export shows `QUEUED` again with an increased `attempts`.

Failure reasons (`errorCode`, each with a fixed user-facing `error` message):

| `errorCode`           | When                                                         |
| --------------------- | ------------------------------------------------------------ |
| `GENERATION_FAILED`   | The archive could not be built after all retries             |
| `STORAGE_FULL`        | The export storage ran out of space (`ENOSPC`/`EDQUOT`)      |
| `ACCOUNT_UNAVAILABLE` | The account no longer exists (not retried)                   |
| `INTERRUPTED`         | The job was lost or ended without finishing (recovery sweep) |
| `QUEUE_UNAVAILABLE`   | The export could not be queued (the request returned `503`)  |

The database requires every `FAILED` export to have `error`, `errorCode` and `completedAt`, and no archive.

File cleanup and duplicates:

- Archives are written as `<uuid>.zip.partial` and renamed to `<uuid>.zip` only when complete, so an incomplete archive never has the final name.
- A failed attempt deletes its own partial archive. When an export finally fails, its status and reason are recorded first, then every file of the export is deleted and `filesDeletedAt` is set. If deletion fails, the export stays `FAILED` (the user still sees the reason) and the retention sweep retries the cleanup until it succeeds.
- After a successful publication, files left by earlier attempts (for example a crashed worker's partial archive) are removed, so a completed export has exactly one file.
- Repeated requests never create duplicate jobs: the same `Idempotency-Key` returns the same export (including a failed one), only one export per user can be waiting or running, and each export has exactly one BullMQ job (`jobId` = export ID). Redelivered jobs for completed or failed exports do nothing. A new request after a failure creates one new export.

Every 60 seconds, recovery fails exports older than `PRIVACY_EXPORT_RECOVERY_GRACE_MS` whose job is missing or finished (`INTERRUPTED`), so users are never blocked by a lost job.

#### Downloading a completed export

`GET /v1/privacy/exports/:exportId/download` returns a temporary link for the caller's own completed export:

```json
{
  "url": "/v1/privacy/exports/<id>/archive?expires=1788264900&signature=<43 base64url chars>",
  "method": "GET",
  "expiresAt": "2026-09-01T12:15:00.000Z",
  "fileName": "musecue-data-export-2026-09-01.zip",
  "sizeBytes": 123456,
  "sha256": "<archive checksum>"
}
```

- The link expires after `PRIVACY_EXPORT_DOWNLOAD_TTL_SECONDS` (default and maximum 900 seconds, minimum 60), and never later than the archive's own `expiresAt`. The URL is relative to the API base URL. It is never built from the request's `Host` header.
- `QUEUED`/`PROCESSING` and `FAILED` exports return `409`, expired exports return `410`, and another user's or an unknown export returns the same `404` as a missing one.
- The signature is an HMAC-SHA256 over the export ID, the owner's user ID, the archive's SHA-256 and the expiry. The key is `PRIVACY_EXPORT_DOWNLOAD_SECRET`, or a purpose-bound key derived from `JWT_ACCESS_SECRET` with HKDF. Verification is constant-time. Rotating the key invalidates issued links.
- **Using the link also requires the owner's bearer token.** The signature is checked against the caller's user ID, so a link that leaks (logs, screenshots, shared devices) is useless to anyone else. Without a token the response is `401`, with another user's token, a tampered expiry or signature, or another export's ID it is `403`, and after the link expires it is `410`. A link stops working early when the export expires or its archive is replaced or missing.
- The archive is streamed with `Content-Type: application/zip`, `Content-Disposition: attachment`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. Its size must still match the recorded size.
- Signed URLs are never logged: request logging and the exception filter redact `signature` (and `token`/`access_token`/`refresh_token`) query values.
- Archives stay private in storage. They live under `PRIVATE_EXPORT_DIR`, outside any static directory, in owner-only directories (`0700`) and files (`0600`), with random, unguessable names. Only finished `.zip` files are served, and only as regular files opened without following symbolic links.

#### Retention: expiry and cleanup

An archive expires **24 hours after it was exported** (`expiresAt` = completion + 24 hours). From that moment the export reads as `EXPIRED`, and new links and existing links are refused with `410`. Download links themselves still last at most 15 minutes and never outlive the archive.

Deletion does not depend on any user request. `PrivacyExportRetentionService` runs a sweep at startup, to catch up after downtime, and then every `PRIVACY_EXPORT_CLEANUP_INTERVAL_MS` (default 60 seconds) on every instance. It needs only PostgreSQL and storage, not Redis.

1. **Expire.** `COMPLETED` exports with `expiresAt <= now` become `EXPIRED` (one guarded update). The row keeps `storageKey` and `sha256`; the database requires this for `EXPIRED` rows.
2. **Delete files.** For every `FAILED`/`EXPIRED` export with `filesDeletedAt` null, that export's own directory (`<authId>/<exportId>/`) is deleted. Then `filesDeletedAt` is recorded. If deletion fails, nothing is recorded: the export stays pending with its reference and is retried on the next sweep. Pending exports are walked in ID order (up to 1,000 per sweep), so one export that keeps failing never blocks others.
3. **Storage scan** (at most every `PRIVACY_EXPORT_ORPHAN_SCAN_INTERVAL_MS`, default 1 hour, and on an instance's first sweep). Export directories whose record no longer exists are removed once unchanged for 1 hour. This happens, for example, when deleting an account cascades away its export rows. Files reappearing for exports already cleaned up are removed too. Directories of waiting, running and downloadable exports, and anything without the `<authId>/<exportId>` layout, are never touched.

Sweeps are idempotent and can run concurrently on several instances. Repeating a sweep changes nothing, and each step only ever affects the expired or failed export it is about, never other users' exports. All instances must share the same `PRIVACY_EXPORT_DIR` storage, because a sweep on one instance must be able to delete files that another instance wrote.

### Account deletion

Routes require a bearer token. The account is always the token's user. A request cannot name another account, and any extra body field (for example `userId`) is rejected with `400`.

| Method | Route | Purpose |
| ------ | ----- | ------- |
| `POST` | `/v1/privacy/account-deletion/confirmation-code` | Email a one-time confirmation code (accounts without a password, e.g. Google sign-in) |
| `POST` | `/v1/privacy/account-deletion` | Confirm identity and request permanent deletion (`202`) |

**Identity verification** follows the login conventions. Every deletion is confirmed with a one-time code sent to the account's email address (`POST .../confirmation-code`, no body):

- Accounts with a password send **both** `{ "password": "...", "code": "A1B2C3" }`. The password check uses constant-time bcrypt, and wrong passwords count toward the same lockout as failed logins (5 failures lock the account for 30 minutes and revoke its tokens). A wrong password does not use up the code.
- Accounts without a password (Google sign-in) send `{ "code": "A1B2C3" }` only; a password is rejected.
- Codes are 6 characters, stored only as a hash bound to the account, valid 10 minutes, single-use and limited to 5 guesses. At most 3 codes can be requested per 15 minutes.
- Missing proof or the wrong kind of proof returns `400`; a wrong password or code returns `403` (`Identity verification failed`). Confirmations are limited to 5 per 15 minutes (`429`).

**Acceptance and token invalidation.** In one transaction, the account moves from `ACTIVE` to `PENDING_DELETION` (a guarded update), its `tokenVersion` is incremented, and an `AccountDeletionRequest` is recorded.

- **Before the transaction commits,** the new token version is written to the token cache. If that write fails, the transaction rolls back and the request returns `503`, so a deletion is never approved while old tokens could still work.
- `AuthGuard` fills an empty cache entry only with `SET NX`, so a request that read the account just before the approval cannot put the old version back.
- After the commit, every refresh session is removed. Login, token refresh and Google sign-in refuse any account that is not `ACTIVE`.
- The response is `202` with `{ id, status, requestedAt, accountBlockedAt, sessionsRevoked }`.

**Multiple requests.** Only one open (not `COMPLETED`) request per account can exist; a partial unique index enforces this. Concurrent requests are serialized by the row lock and all receive the same request. A repeated request after approval is refused with `401`.

#### Erasure (hard deletion)

`AccountDeletionRecoveryService` runs at startup and every 30 seconds. It finishes any pending session revocation and hands every open request whose processing lease (`lockedUntil`, 5 minutes) is free or expired to `AccountErasureService`. Each step is recorded on the request, so a crash or failure resumes from the last completed step:

1. **Data (one transaction).**
   - Records the account's storage references as `AccountDeletionFile` rows: each private image inside the owner's own scope (session photos, avatar), plus the owner's whole image and export directories, which also catches files no row references any more.
   - Deletes activity-log entries about the account (its `authUser` and `UserSubscription` records).
   - Anonymizes entries the account made about shared records (for example an administrator changing the plan): the actor, IP, user agent and device are cleared, and the change itself is kept.
   - Hard-deletes the `authUser` row, guarded by `status = PENDING_DELETION`. Foreign keys cascade to every row the account owns: profile, security, sign-in and email history, makeup sessions with images, preferences, analyses, recommendations, guides, steps, attempts and questions, AI runs, subscription and events, and data exports.
   - Payments survive, detached. Either everything commits, references included, or nothing does (`dataErasedAt`).
2. **Files.** Deletes each referenced file and directory and marks it `deletedAt`. A storage failure is retried from the saved references (`filesDeletedAt`).
3. **Completion.** Once sessions are revoked, the data erased and the files deleted, the request becomes `COMPLETED`. Cached authentication data of the account (sessions, the token version, keys containing its email) and any outstanding code are removed.

The database allows `COMPLETED` only after all three steps, and the request (no foreign key, no personal data) remains as the record that the deletion happened. The request, the deletion files table, the plan and payments are never reachable by a user's cascade. A foreign-key audit test enforces this: nothing `RESTRICT`s a user's deletion, and only `ActivityLogEvent.actionedBy` and `PaymentTransaction.subscriptionId` are set to `NULL`.

## Domain

```text
authUser
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
```

Mock and live gateways implement the same application-owned operations. The live gateway delegates transport to an OpenRouter provider adapter, workers validate and normalize model-shaped output, and NestJS alone persists it transactionally and advances workflow state. No frontend or public API contract changes are required to switch modes or add another provider adapter.

## Commands

```bash
npm run start:dev
npm run build
npm run lint
npm test
npm run test:e2e
npx prisma generate
npx prisma migrate dev
npx prisma migrate deploy
```
