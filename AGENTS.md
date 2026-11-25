# MuseCue API agent instructions

## Purpose

This NestJS service is the application authority for MuseCue — AI makeup guidance, made for your face. It owns authentication, authorization, workflow state, persistence, private media access, and AI orchestration.

## Architecture rules

- Supabase Auth, Database, and client SDKs are not used. NestJS is the only authentication and application backend. Supabase Storage is used only as a server-side private object store behind `StorageModule`.
- AI may analyze, recommend, generate, and evaluate. NestJS must validate AI output, persist it, and decide workflow transitions.
- Do not allow AI responses to mutate application state directly.
- Long-running AI and image operations belong in durable background jobs on the selected queue driver, not synchronous request handlers. `REDIS_ENABLED` selects the driver at startup (BullMQ when `true`, the PostgreSQL queue when `false`): dispatch through `JobDispatcher`, inspect through `JobInspector`, and put the processing in a transport-independent job handler registered with `registerJobHandler`. Never import BullMQ, `RedisService` or a driver implementation in feature code, and never fall back to running the work inside a request.
- Infrastructure abstractions (`JobDispatcher`, `JobInspector`, `RateLimitStore`, `TokenVersionCache`) are provided by `InfrastructureModule`. New code must work in both modes; PostgreSQL is always available, Redis is not.
- Every makeup resource must be scoped to the authenticated owner.
- Store face images in private object storage and expose only short-lived signed URLs.
- Never log image content, signed URLs, passwords, SMTP credentials, access tokens, refresh tokens, or raw AI prompts containing sensitive user data.
- Validate all request DTOs with `class-validator` and all AI outputs against explicit runtime schemas.
- Successful API responses are wrapped once by `TransformInterceptor`; controllers return domain data directly.
- Pro feature endpoints must use `@UseGuards(AuthGuard, ProAccessGuard)` (import `SubscriptionModule`). Do not decide Pro access in feature services or read `UserSubscription` directly for it; use the decision on `req.proAccess` or `SubscriptionAccessService`.
- Credit-gated endpoints add `@RequireCredits()` to `ProAccessGuard`; it admits users with available credits from any source, regardless of Pro status (`req.creditAccess`). Only `POST /v1/sessions` uses it. Read and change credits through `CreditWalletService`, never the credit tables directly (the database rejects inconsistent ledger writes).
- Billable AI providers must report each request's usage (`AiCallMetadata`: generation ID, model, tokens, `costUsd`), also on errors after a billed answer (`AiProviderError.billedResponse`). The job handler records it (`CreditUsageService`) and charges the run inside the transaction that publishes its result; do not charge elsewhere.

## Authentication

- Access tokens are short-lived JWTs accepted through `Authorization: Bearer <token>`.
- Refresh tokens rotate through `POST /auth/refresh-token` and are stored as hashes in PostgreSQL (`RefreshSession`, in both infrastructure modes); rotation revokes the presented session and stores its replacement in one transaction.
- One-time codes (`AuthChallenge`) and OAuth states (`OAuthState`) are stored only as purpose-bound hashes, with any other secret data encrypted; never store or log them in plaintext.
- Protected handlers must derive the user ID from `req.user`, never from a request body or query parameter.
- Security events must invalidate cached token versions where applicable (through `TokenVersionCache`; without Redis the database is read on every request).
- SMTP email verification is required before password login.

## Commands

```bash
npm install
npm run build
npm run lint
npm run test
npm run test:e2e
npx prisma generate
npx prisma migrate dev
```

Run `npm run build` and relevant tests before completing changes. Do not use destructive Prisma reset commands unless the user explicitly requests a database reset.

## Implementation conventions

- Keep controllers thin: validate/authorize input, construct request metadata, and delegate.
- Put business rules in services and persistence in Prisma-backed operations.
- Use interfaces and `unknown` with narrowing; do not introduce `any` or new lint suppressions.
- Use Prisma transactions when multiple writes must succeed together.
- Use idempotency keys for retryable creation and AI-job endpoints.
- Add unit tests for business rules and e2e tests for authentication, ownership, validation, and response contracts.
- Update `.env.example` and README documentation when configuration or routes change, without copying real secrets.

## Target makeup domain

The target aggregate is:

```text
authUser
└── MakeupSession
    ├── ImageAsset
    ├── MakeupPreferences
    ├── FaceAnalysis
    ├── Recommendation -> GeneratedPreview
    └── Guide -> GuideStep -> StepAttempt -> VisualEvaluation
                              └── Question
```

Introduce this domain through reviewed Prisma migrations. Remove the dormant starter job/subscription tables in a deliberate migration rather than editing historical migrations.
