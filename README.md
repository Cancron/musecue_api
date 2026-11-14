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
- a single Pro subscription plan: admin-configured monthly/yearly pricing and free trial, one-time trial activation, date-based Pro access through `ProAccessGuard`, payment/lifecycle records protected by database rules, and Stripe checkout for the monthly and yearly options with webhook-verified activation, automatic renewals, failed-payment handling and recovery, cancellation at period end, and refunds made in Stripe with immediate access revocation (see "Subscriptions" and "Stripe checkout" under API); requesting refunds from MuseCue and disputes are not implemented yet

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

Billing records (migration `20260918120000_add_payments_and_subscription_events`; written by the Stripe checkout described below):

- `PaymentTransaction` records one charge attempt for one billing period. It stores the amount in cents, currency, status (`PENDING`, `SUCCEEDED`, `FAILED`, `PARTIALLY_REFUNDED`, `REFUNDED`), `provider` + `providerPaymentId`, `providerInvoiceId` (the provider invoice the attempt tried to collect, migration `20261115120000_stripe_payment_failures`), the period, timestamps, and failure and refund details.
  - `(provider, providerPaymentId)` is unique, and only one verified payment may cover a given period.
  - Payments are never deleted. Amount, currency, provider IDs and period never change, and status only moves forward.
  - A user with payments cannot be hard-deleted.
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

Repeated or delayed events add no rows or events. Because the current state is always re-read from Stripe, a stale `pending` event cannot undo a succeeded refund. Refunded amounts only grow, and the term is only ever shortened, so no event can restore revoked access; replays of the payment's own `invoice.paid` or checkout events are already recorded. A refund Stripe reports as failed after it succeeded keeps its effect and is logged for review. If a refund arrives before its payment was recorded, the webhook answers `503` so Stripe retries after the payment event.

Handled events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`, `charge.refund.updated`, `refund.created`, `refund.updated`, `refund.failed`. Other events are acknowledged and ignored. Transient failures return `5xx`, so Stripe retries.

Configuration (`.env.example`): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CHECKOUT_SUCCESS_URL`, `STRIPE_CHECKOUT_CANCEL_URL` (absolute http(s) URLs), optional `STRIPE_PRO_PRODUCT_ID`, and `STRIPE_CHECKOUT_EXPIRES_MINUTES` (31–1440, default 60). In the Stripe dashboard, create a webhook endpoint for `https://<api>/v1/webhooks/stripe` with the thirteen events above. For local development, forward events with the Stripe CLI and use the printed signing secret:

```bash
stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired,invoice.paid,invoice.payment_failed,customer.subscription.updated,customer.subscription.deleted,charge.refunded,charge.refund.updated,refund.created,refund.updated,refund.failed --forward-to localhost:5000/v1/webhooks/stripe
```

Migration `20261113120000_add_stripe_checkout` adds `PaymentCustomer` and `CheckoutSession`. Database rules enforce one pending checkout per user, forward-only checkout status, an immutable price, interval, customer and provider session, and completion only by a `SUCCEEDED` payment of the same subscription. The webhook needs the raw body, so `main.ts` creates the app with `rawBody: true`.

Not implemented yet: immediate cancellation (including canceling a past-due subscription to stop Stripe's retries), undoing a cancellation (a cancellation reversed in Stripe is not reflected), the customer portal (so users cannot update their card in-app; Stripe's own emails and hosted invoice page can be used), exposing the past-due state in `GET /v1/subscription`, requesting refunds from MuseCue, disputes (`charge.dispute.*`), canceling the Stripe subscription automatically when a payment is refunded, revoking an active free trial on refund (a trial is not a payment and keeps running), reactions to other `customer.subscription.updated` changes (e.g. `unpaid`), and automatic refunds or cancellation of duplicate payments and subscriptions. Renewal delays within Stripe's retry window (up to 3 days) are handled. If a renewal for an older period arrives after a newer one, the older period is recorded but cannot be merged into the term: the database allows one payment per term change.

Database tests (`test/subscription-plan.*.e2e-spec.ts`, `test/user-subscription.*.e2e-spec.ts`, `test/subscription-trial.e2e-spec.ts`, `test/subscription-status.e2e-spec.ts`, `test/pro-access.e2e-spec.ts`, `test/trial-lifecycle.e2e-spec.ts`, `test/billing.e2e-spec.ts`, `test/subscription-security.e2e-spec.ts`, `test/stripe-checkout.e2e-spec.ts`, `test/stripe-renewal.e2e-spec.ts`, `test/stripe-payment-failure.e2e-spec.ts`, `test/stripe-cancellation.e2e-spec.ts`, `test/stripe-refund.e2e-spec.ts`, `test/subscription-billing.e2e-spec.ts`) run only when `TEST_DATABASE_URL` is set, and are reported as skipped otherwise. Each test builds a temporary schema from the migration files and drops it afterwards, so the database user needs `CREATE` permission:

```bash
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/musecue_test npx jest --config ./test/jest-e2e.json test/subscription-plan test/user-subscription test/subscription-trial test/subscription-status test/pro-access test/trial-lifecycle test/billing test/subscription-security test/stripe-checkout test/stripe-renewal test/stripe-payment-failure test/stripe-cancellation test/stripe-refund test/subscription-billing
```

The Stripe unit tests do not need a database or a Stripe account; they run the real Stripe SDK against an in-memory emulation of the few Stripe endpoints used (`test/support/fake-stripe-api.ts`):

```bash
npm test -- --runInBand stripe
npm test -- --runInBand subscription-billing
```


## Domain

```text
authUser
|-- PaymentCustomer (0..1 per provider)
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
npm run test:e2e
npx prisma generate
npx prisma migrate dev
npx prisma migrate deploy
```
