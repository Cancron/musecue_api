# MuseCue API agent instructions

## Purpose

This NestJS service is the application authority for MuseCue — AI makeup guidance, made for your face. It owns authentication, authorization, workflow state, persistence, private media access, and AI orchestration.

The product specification and architecture are in the sibling `face_makeup_app/Blueprint.md` and `face_makeup_app/Architecture.md` files.

## Architecture rules

- Supabase is not used. NestJS is the only authentication and application backend.
- AI may analyze, recommend, generate, and evaluate. NestJS must validate AI output, persist it, and decide workflow transitions.
- Do not allow AI responses to mutate application state directly.
- Long-running AI and image operations belong in BullMQ workers, not synchronous request handlers.
- Every makeup resource must be scoped to the authenticated owner.
- Store face images in private object storage and expose only short-lived signed URLs.
- Never log image content, signed URLs, passwords, SMTP credentials, access tokens, refresh tokens, or raw AI prompts containing sensitive user data.
- Validate all request DTOs with `class-validator` and all AI outputs against explicit runtime schemas.
- Successful API responses are wrapped once by `TransformInterceptor`; controllers return domain data directly.

## Authentication

- Access tokens are short-lived JWTs accepted through `Authorization: Bearer <token>`.
- Refresh tokens rotate through `POST /auth/refresh-token` and are stored as hashes in Redis.
- Protected handlers must derive the user ID from `req.user`, never from a request body or query parameter.
- Security events must invalidate cached token versions where applicable.
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
