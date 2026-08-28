# MuseCue API

**AI makeup guidance, made for your face.**

The MuseCue API is the NestJS authority for authentication, authorization, workflow state, persistence, and AI orchestration. Supabase is not used. AI providers may interpret or generate data, but only NestJS validates results and advances application state.

The companion mobile application and detailed product specifications live in `../face_makeup_app`.

## Implemented

- PostgreSQL/Prisma local accounts, SMTP verification through BullMQ, login auditing, account lockout, and Google OAuth foundations
- short-lived JWT access tokens and rotating, revocable Redis-backed refresh tokens
- owner-scoped makeup sessions and the documented workflow state machine
- image metadata, structured preferences, face analysis, ranked recommendations, saved looks, and selection
- generated guides, authoritative step progression, retained visual attempts, contextual questions, completion history, and profile statistics
- BullMQ jobs for personalization, guide generation, visual checks, and guide questions
- `AiRun` audit records containing operation, provider, model, prompt version, latency, progress, result/error, and status
- a deterministic mock AI gateway with normalized, runtime-validated sample output

Migration `20260827174107_add_makeup_workflow` adds the makeup aggregate and removes the dormant job-tracker and subscription starter domains.

Intentionally deferred:

- real camera binary upload and production private object storage; the current app registers mock-capture metadata
- generated preview images
- external AI provider calls
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

| Method  | Route                                                              | Purpose                           |
| ------- | ------------------------------------------------------------------ | --------------------------------- |
| `POST`  | `/v1/sessions`                                                     | Create an owner-scoped session    |
| `GET`   | `/v1/sessions?scope=active\|completed\|all`                        | List the user's sessions          |
| `GET`   | `/v1/sessions/:sessionId`                                          | Read the full session aggregate   |
| `POST`  | `/v1/sessions/:sessionId/images/mock`                              | Register mock-capture metadata    |
| `PATCH` | `/v1/sessions/:sessionId/preferences`                              | Save preferences                  |
| `POST`  | `/v1/sessions/:sessionId/analyze`                                  | Queue mock personalization        |
| `POST`  | `/v1/sessions/:sessionId/recommendations/:recommendationId/select` | Select a look and queue its guide |
| `POST`  | `/v1/recommendations/:recommendationId/saved`                      | Toggle saved state                |
| `GET`   | `/v1/saved-recommendations`                                        | List saved recommendations        |
| `POST`  | `/v1/guide-steps/:stepId/check`                                    | Queue a visual evaluation         |
| `POST`  | `/v1/guide-steps/:stepId/questions`                                | Queue a contextual answer         |
| `POST`  | `/v1/guide-steps/:stepId/complete`                                 | Advance the authoritative guide   |
| `GET`   | `/v1/jobs/:runId`                                                  | Poll an asynchronous AI run       |
| `GET`   | `/v1/profile/stats`                                                | Return persisted statistics       |

Queueing mutations accept an `Idempotency-Key`. Every owned record is scoped with the JWT user ID; clients cannot supply another user's owner ID.

Successful responses use one envelope:

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {}
}
```

## Domain

```text
authUser
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

The mock gateway is behind the same boundary intended for future providers. Workers validate and normalize model-shaped output, services persist it transactionally, and the AI layer never mutates workflow state directly.

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
