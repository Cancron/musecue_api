# Face MakeUp Guide API

The Face MakeUp Guide API is the NestJS application authority for authentication, persistent workflow state, private images, and future AI orchestration. AI providers will analyze or generate content; NestJS will validate their output and control all application state transitions.

The companion mobile application and detailed product architecture live in `../face_makeup_app`.

## Current implementation

Implemented and active:

- local email/password accounts backed by PostgreSQL and Prisma
- SMTP email verification through BullMQ
- login with account lockout and audit history
- short-lived JWT access tokens
- rotating, revocable refresh tokens backed by Redis
- authenticated logout and logout-all-devices operations
- Google OAuth foundation
- request validation, rate limiting, Helmet, CORS, Swagger, structured logging, and Prometheus metrics

Supabase is not used. The API is the single authentication authority.

The old starter user and job-tracker modules remain in the source tree for reference but are not registered in `AppModule` and expose no routes. Their Prisma tables should be removed in a dedicated schema migration when the makeup-session schema is introduced.

Not implemented yet:

- private image uploads or object storage
- makeup sessions and preferences
- face analyses, recommendations, or preview generation
- guides, steps, attempts, evaluations, or contextual questions
- AI provider gateway and AI job workers

## Requirements

- Node.js 22+
- npm
- PostgreSQL 17
- Redis 7+
- working SMTP credentials for verification and welcome emails

## Local setup

```bash
copy .env.example .env
docker compose up -d postgres_db redis-stack
npm install
npx prisma migrate deploy
npm run start:dev
```

The API defaults to `http://localhost:5000`. Swagger is available at `http://localhost:5000/docs` in development.

## Environment

Use `.env.example` as the complete starting point. Important values include:

```env
DATABASE_URL=postgresql://admin:admin@127.0.0.1:5433/face_makeup_guide
NODE_ENV=development
PORT=5000
CORS_ORIGINS=http://localhost:8081,http://localhost:19006

JWT_ACCESS_SECRET=replace-with-a-strong-independent-secret
JWT_REFRESH_SECRET=replace-with-a-different-strong-secret

REDIS_HOST=localhost
REDIS_PORT=6379

EMAIL_HOST=smtp.example.com
EMAIL_PORT=587
EMAIL_USER=your-smtp-user
EMAIL_PASS=your-smtp-password
EMAIL_FROM=noreply@example.com
```

The application also supports `JWT_SECRET` as a development fallback, but separate access and refresh secrets are recommended. Never commit the real `.env` file or include SMTP credentials in logs or documentation.

## Active API routes

### Authentication

| Method     | Route                             | Authentication | Purpose                                               |
| ---------- | --------------------------------- | -------------- | ----------------------------------------------------- |
| `POST`     | `/auth`                           | Public         | Register an account and queue a verification code     |
| `POST`     | `/auth/verify-email`              | Public         | Verify a six-character email code                     |
| `POST`     | `/auth/resend-verification-email` | Public         | Send a replacement verification code                  |
| `POST`     | `/auth/login`                     | Public         | Receive access token, refresh token, and user         |
| `POST`     | `/auth/refresh-token`             | Refresh token  | Rotate the refresh token and receive a new token pair |
| `POST`     | `/auth/logout`                    | Bearer token   | Revoke the current refresh token                      |
| `POST`     | `/auth/logout-all`                | Bearer token   | Revoke all sessions for the authenticated user        |
| `GET`      | `/auth/google`                    | Public         | Initialize Google OAuth                               |
| `GET/POST` | `/auth/google/callback`           | Public         | Complete Google OAuth                                 |

### Infrastructure

| Method | Route           | Purpose                      |
| ------ | --------------- | ---------------------------- |
| `GET`  | `/`             | Basic application response   |
| `GET`  | `/metrics`      | Prometheus exposition format |
| `GET`  | `/metrics/json` | Metrics as JSON              |
| `GET`  | `/docs`         | Swagger UI when enabled      |

Successful JSON responses use one envelope:

```json
{
  "statusCode": 200,
  "message": "Success",
  "data": {}
}
```

Errors use:

```json
{
  "success": false,
  "statusCode": 400,
  "message": "Validation failed",
  "error": "BadRequestException",
  "timestamp": "2026-08-27T00:00:00.000Z",
  "path": "/auth"
}
```

## Commands

```bash
npm run start:dev       # Development server
npm run build           # Production build
npm run start:prod      # Run compiled application
npm run lint            # ESLint with fixes
npm run test            # Unit tests
npm run test:cov        # Coverage
npm run test:e2e        # End-to-end tests
npx prisma generate     # Generate Prisma Client
npx prisma migrate dev  # Create/apply a development migration
npx prisma migrate deploy
```

## Target makeup architecture

The first makeup-domain migration should introduce these concepts:

```text
authUser
└── MakeupSession
    ├── ImageAsset
    ├── MakeupPreferences
    ├── FaceAnalysis
    ├── Recommendation
    │   └── GeneratedPreview
    └── Guide
        └── GuideStep
            ├── StepAttempt
            │   └── VisualEvaluation
            └── Question
```

Long-running analysis and image generation should execute through BullMQ jobs. API mutations should be idempotent, AI outputs must be schema-validated, and each AI result should record provider, model, prompt version, latency, usage, and status.

Face images must use private object storage, short-lived signed URLs, explicit retention/deletion rules, and logs that never include image contents, signed URLs, SMTP credentials, or authentication tokens.
