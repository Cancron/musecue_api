import { mockDeep, type DeepMockProxy } from 'jest-mock-extended';
import type { PrismaService } from '../../src/common/services/prisma.service';
import type { SubscriptionStatusView } from '../../src/subscription/interfaces/subscription-status.interface';

/**
 * Fixtures for personal-data export tests: two users with complete rows,
 * including credentials and internal references that must never be exported,
 * and a fake Prisma client that honors the `where` owner filters and the
 * `select` allowlists the exporter passes, just like the real client would.
 */

export const OWNER_ID = 'a1a1a1a1-0000-4000-8000-000000000001';
export const OTHER_ID = 'b2b2b2b2-0000-4000-8000-000000000002';
export const EXPORT_ID = 'e3e3e3e3-0000-4000-8000-000000000003';
export const SESSION_ID = 'c4c4c4c4-0000-4000-8000-000000000004';
export const OTHER_SESSION_ID = 'd5d5d5d5-0000-4000-8000-000000000005';

export const IMAGE_UPLOADED = 'f0000000-0000-4000-8000-000000000001';
export const IMAGE_MISSING_FILE = 'f0000000-0000-4000-8000-000000000002';
export const IMAGE_MOCK_CAPTURE = 'f0000000-0000-4000-8000-000000000003';
export const IMAGE_FOREIGN_KEY = 'f0000000-0000-4000-8000-000000000004';
export const OTHER_IMAGE = 'f0000000-0000-4000-8000-000000000005';

export const OWNER_AVATAR_KEY = `${OWNER_ID}/profile/avatar-file.png`;
export const OWNER_PHOTO_KEY = `${OWNER_ID}/${SESSION_ID}/uploaded.jpg`;
export const OWNER_MISSING_KEY = `${OWNER_ID}/${SESSION_ID}/deleted.png`;
export const OTHER_PHOTO_KEY = `${OTHER_ID}/${OTHER_SESSION_ID}/other.jpg`;

/** Values that must never appear anywhere in the owner's archive. */
export const FORBIDDEN_VALUES = [
  '$2b$12$OWNER-PASSWORD-HASH',
  'OWNER-MFA-SECRET',
  'google-subject-owner',
  'OWNER-IDEMPOTENCY-KEY',
  'OWNER-AI-RAW-RESULT',
  'sub_OWNER_PROVIDER_ID',
  'pay_OWNER_PROVIDER_ID',
  'OWNER-SMTP-MESSAGE-ID',
  'OWNER-PAYMENT-FAILURE-DETAIL',
  OWNER_AVATAR_KEY,
  OWNER_PHOTO_KEY,
  OWNER_MISSING_KEY,
  // Everything belonging to the other user:
  OTHER_ID,
  OTHER_SESSION_ID,
  OTHER_IMAGE,
  'other@example.com',
  'OTHER-USER-PRIVATE-NOTE',
  'OTHER-PASSWORD-HASH',
];

export const PHOTO_BYTES = {
  avatar: Buffer.from('owner-avatar-png-bytes'),
  uploaded: Buffer.from('owner-uploaded-jpeg-bytes'),
  other: Buffer.from('OTHER-USER-PHOTO-BYTES'),
};

const T = (minute: number) => new Date(Date.UTC(2026, 8, 1, 12, minute, 0, 0));

type Row = Record<string, unknown>;

function user(id: string, email: string, secret: string): Row {
  return {
    id,
    email,
    username: email.split('@')[0],
    password: secret,
    role: 'USER',
    verified: true,
    status: 'ACTIVE',
    tokenVersion: 7,
    deletedAt: null,
    provider: 'google',
    providerId: id === OWNER_ID ? 'google-subject-owner' : 'google-subject-x',
    createdAt: T(0),
    updatedAt: T(1),
  };
}

export const ROWS = {
  authUser: [
    {
      ...user(OWNER_ID, 'owner@example.com', '$2b$12$OWNER-PASSWORD-HASH'),
      authSecurity: {
        authId: OWNER_ID,
        failedAttempts: 2,
        mfaEnabled: true,
        mfaMethod: 'totp',
        mfaSecret: 'OWNER-MFA-SECRET',
        lastPasswordChange: T(2),
      },
      userProfile: {
        authId: OWNER_ID,
        firstName: 'Ada',
        lastName: 'Owner',
        bio: 'Loves soft glam',
        avatarUrl: OWNER_AVATAR_KEY,
        avatarStorageProvider: 'local',
        createdAt: T(0),
        updatedAt: T(3),
      },
    },
    {
      ...user(OTHER_ID, 'other@example.com', 'OTHER-PASSWORD-HASH'),
      authSecurity: null,
      userProfile: null,
    },
  ] as Row[],
  makeupSession: [
    {
      id: SESSION_ID,
      authId: OWNER_ID,
      status: 'COMPLETED',
      completedAt: T(30),
      createdAt: T(10),
      updatedAt: T(30),
      preferences: {
        vibe: 'soft',
        skillLevel: 'beginner',
        occasion: 'work',
        desiredEffect: 'fresh',
        timeMinutes: 15,
        notes: 'Sensitive eyes',
        createdAt: T(11),
        updatedAt: T(11),
      },
      faceAnalysis: {
        faceShape: 'oval',
        skinTone: 'medium',
        undertone: 'warm',
        notableFeatures: ['hooded eyes'],
        confidence: 0.82,
        createdAt: T(12),
      },
      recommendations: [
        {
          id: 'r0000000-0000-4000-8000-000000000001',
          rank: 1,
          name: 'Soft Glow',
          tagline: 'Warm and fresh',
          matchScore: 93,
          imageUrl: 'https://cdn.example.com/looks/soft-glow.jpg',
          palette: ['#c48f7a'],
          rationale: 'Suits warm undertones',
          selectedAt: T(13),
          savedAt: T(14),
          createdAt: T(12),
        },
      ],
      images: [
        {
          id: IMAGE_UPLOADED,
          sessionId: SESSION_ID,
          guideStepId: null,
          purpose: 'INITIAL_ANALYSIS',
          source: 'PRIVATE_UPLOAD',
          storageProvider: 'local',
          storageKey: OWNER_PHOTO_KEY,
          mimeType: 'image/jpeg',
          width: 800,
          height: 1000,
          sizeBytes: PHOTO_BYTES.uploaded.length,
          createdAt: T(10),
        },
        {
          id: IMAGE_MISSING_FILE,
          sessionId: SESSION_ID,
          guideStepId: 'g0000000-0000-4000-8000-000000000001',
          purpose: 'STEP_CHECK',
          source: 'PRIVATE_UPLOAD',
          storageProvider: 'local',
          storageKey: OWNER_MISSING_KEY,
          mimeType: 'image/png',
          width: 800,
          height: 1000,
          sizeBytes: 1234,
          createdAt: T(20),
        },
        {
          id: IMAGE_MOCK_CAPTURE,
          sessionId: SESSION_ID,
          guideStepId: null,
          purpose: 'COMPLETION',
          source: 'MOCK_CAPTURE',
          storageProvider: 'local',
          storageKey: 'mock://capture/1',
          mimeType: 'image/jpeg',
          width: 1,
          height: 1,
          sizeBytes: 1,
          createdAt: T(21),
        },
        {
          // A corrupted reference pointing into another user's scope.
          id: IMAGE_FOREIGN_KEY,
          sessionId: SESSION_ID,
          guideStepId: null,
          purpose: 'COMPLETION',
          source: 'PRIVATE_UPLOAD',
          storageProvider: 'local',
          storageKey: OTHER_PHOTO_KEY,
          mimeType: 'image/jpeg',
          width: 1,
          height: 1,
          sizeBytes: 1,
          createdAt: T(22),
        },
      ],
      guide: {
        id: 'g1000000-0000-4000-8000-000000000001',
        recommendationId: 'r0000000-0000-4000-8000-000000000001',
        status: 'COMPLETED',
        currentStepIndex: 0,
        startedAt: T(15),
        completedAt: T(30),
        createdAt: T(14),
        steps: [
          {
            id: 'g0000000-0000-4000-8000-000000000001',
            position: 0,
            status: 'COMPLETED',
            title: 'Prep skin',
            instruction: 'Moisturize',
            substeps: ['Cleanse', 'Moisturize'],
            spokenIntro: null,
            spokenSubsteps: [],
            area: 'face',
            technique: 'pat',
            estimatedSeconds: 60,
            personalizedTip: 'Go light',
            commonMistake: 'Too much product',
            successCriteria: 'Even finish',
            completedAt: T(25),
            attempts: [
              {
                id: 'at000000-0000-4000-8000-000000000001',
                imageId: IMAGE_MISSING_FILE,
                result: 'PASS',
                feedback: 'Looks even',
                spokenFeedback: null,
                confidence: 0.9,
                createdAt: T(20),
              },
            ],
            questions: [
              {
                id: 'q0000000-0000-4000-8000-000000000001',
                question: 'Which brush?',
                answer: 'A flat foundation brush',
                createdAt: T(19),
              },
            ],
          },
        ],
      },
    },
    {
      id: OTHER_SESSION_ID,
      authId: OTHER_ID,
      status: 'CREATED',
      completedAt: null,
      createdAt: T(5),
      updatedAt: T(5),
      preferences: {
        vibe: 'bold',
        skillLevel: null,
        occasion: null,
        desiredEffect: null,
        timeMinutes: 30,
        notes: 'OTHER-USER-PRIVATE-NOTE',
        createdAt: T(5),
        updatedAt: T(5),
      },
      faceAnalysis: null,
      recommendations: [],
      images: [
        {
          id: OTHER_IMAGE,
          sessionId: OTHER_SESSION_ID,
          guideStepId: null,
          purpose: 'INITIAL_ANALYSIS',
          source: 'PRIVATE_UPLOAD',
          storageProvider: 'local',
          storageKey: OTHER_PHOTO_KEY,
          mimeType: 'image/jpeg',
          width: 1,
          height: 1,
          sizeBytes: PHOTO_BYTES.other.length,
          createdAt: T(5),
        },
      ],
      guide: null,
    },
  ] as Row[],
  aiRun: [
    {
      id: 'ai000000-0000-4000-8000-000000000001',
      authId: OWNER_ID,
      sessionId: SESSION_ID,
      stepId: null,
      operation: 'PERSONALIZATION',
      status: 'COMPLETED',
      provider: 'openrouter',
      model: 'test-model',
      promptVersion: 'v1',
      idempotencyKey: 'OWNER-IDEMPOTENCY-KEY',
      result: { raw: 'OWNER-AI-RAW-RESULT' },
      usage: { tokens: 10 },
      createdAt: T(12),
      startedAt: T(12),
      completedAt: T(13),
    },
    {
      id: 'ai000000-0000-4000-8000-000000000002',
      authId: OTHER_ID,
      sessionId: OTHER_SESSION_ID,
      stepId: null,
      operation: 'PERSONALIZATION',
      status: 'QUEUED',
      provider: 'mock',
      model: 'mock',
      promptVersion: 'v1',
      idempotencyKey: 'other-key',
      result: null,
      usage: null,
      createdAt: T(5),
      startedAt: null,
      completedAt: null,
    },
  ] as Row[],
  userSubscription: [
    {
      authId: OWNER_ID,
      status: 'PRO',
      trialUsed: true,
      trialStartedAt: T(0),
      trialExpiresAt: T(40),
      billingInterval: 'MONTHLY',
      proStartedAt: T(40),
      proExpiresAt: T(59),
      proCanceledAt: null,
      paymentProvider: 'stripe',
      providerSubscriptionId: 'sub_OWNER_PROVIDER_ID',
      createdAt: T(0),
      updatedAt: T(40),
      payments: [
        {
          id: 'pm000000-0000-4000-8000-000000000001',
          provider: 'stripe',
          providerPaymentId: 'pay_OWNER_PROVIDER_ID',
          status: 'SUCCEEDED',
          amountCents: 1900,
          currency: 'USD',
          billingInterval: 'MONTHLY',
          periodStart: T(40),
          periodEnd: T(59),
          paidAt: T(40),
          failedAt: null,
          failureCode: null,
          failureMessage: 'OWNER-PAYMENT-FAILURE-DETAIL',
          refundedAmountCents: 0,
          refundedAt: null,
          createdAt: T(40),
        },
      ],
      events: [
        {
          id: 'ev000000-0000-4000-8000-000000000001',
          type: 'CREATED',
          paymentId: 'pm000000-0000-4000-8000-000000000001',
          occurredAt: T(40),
        },
      ],
    },
  ] as Row[],
  loginHistory: [
    {
      authId: OWNER_ID,
      createdAt: T(1),
      action: 'login',
      success: true,
      failureReason: null,
      ipAddress: '203.0.113.10',
      userAgent: 'MuseCue/1.0',
      device_id: 'device-1',
      geo_country: 'KR',
      geo_city: 'Seoul',
      isSuspicious: false,
      attemptNumber: 1,
    },
    {
      authId: OTHER_ID,
      createdAt: T(1),
      action: 'login',
      success: true,
      failureReason: null,
      ipAddress: '198.51.100.99',
      userAgent: 'Other',
      device_id: null,
      geo_country: null,
      geo_city: null,
      isSuspicious: false,
      attemptNumber: 1,
    },
  ] as Row[],
  emailHistory: [
    {
      authId: OWNER_ID,
      sentAt: T(0),
      emailType: 'verification',
      emailTo: 'owner@example.com',
      subject: 'Verify your email',
      emailStatus: 'sent',
      messageId: 'OWNER-SMTP-MESSAGE-ID',
    },
    {
      authId: OTHER_ID,
      sentAt: T(0),
      emailType: 'verification',
      emailTo: 'other@example.com',
      subject: 'Verify your email',
      emailStatus: 'sent',
      messageId: 'other-message',
    },
  ] as Row[],
};

export const SUBSCRIPTION_STATUS: SubscriptionStatusView = {
  status: 'PRO',
  hasProAccess: true,
  accessSource: 'PRO',
  accessExpiresAt: T(59).toISOString(),
  trial: {
    eligible: false,
    ineligibleReason: 'TRIAL_ALREADY_USED',
    used: true,
    active: false,
    startedAt: T(0).toISOString(),
    expiresAt: T(40).toISOString(),
  },
  pro: {
    active: true,
    billingInterval: 'MONTHLY',
    startedAt: T(40).toISOString(),
    expiresAt: T(59).toISOString(),
    canceledAt: null,
  },
} as SubscriptionStatusView;

/** Applies a Prisma `select` (including nested relation selects) to a row. */
export function project(row: Row, select: Record<string, unknown>): Row {
  const out: Row = {};
  for (const [field, spec] of Object.entries(select)) {
    if (spec === true) {
      if (!(field in row)) throw new Error(`Fixture row lacks "${field}"`);
      out[field] = row[field];
    } else if (typeof spec === 'object' && spec !== null && 'select' in spec) {
      const nested = (spec as { select: Record<string, unknown> }).select;
      const value = row[field];
      out[field] = Array.isArray(value)
        ? (value as Row[]).map((item) => project(item, nested))
        : value === null || value === undefined
          ? null
          : project(value as Row, nested);
    }
  }
  return out;
}

interface FindArgs {
  where?: Record<string, unknown>;
  select?: Record<string, unknown>;
}

/** Matches the owner filters used by the exporter; anything else is an error. */
function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([field, expected]) => {
    if (field === 'session') {
      const authId = (expected as { authId?: unknown }).authId;
      const session = ROWS.makeupSession.find((s) => s.id === row.sessionId);
      return session?.authId === authId;
    }
    if (typeof expected === 'object' && expected !== null) {
      throw new Error(`Unsupported filter on "${field}" in fixture`);
    }
    return row[field] === expected;
  });
}

function select(rows: Row[], args: FindArgs): Row[] {
  const found = rows.filter((row) => matches(row, args.where));
  return args.select ? found.map((row) => project(row, args.select!)) : found;
}

export type PrivacyPrismaFake = DeepMockProxy<PrismaService>;

/** A Prisma mock serving ROWS through the exporter's where/select arguments. */
export function privacyPrismaFake(): PrivacyPrismaFake {
  const prisma = mockDeep<PrismaService>();
  const images = ROWS.makeupSession.flatMap(
    (session) => session.images as Row[],
  );
  const one = (rows: Row[]) => (args: FindArgs) =>
    Promise.resolve(select(rows, args)[0] ?? null) as never;
  const many = (rows: Row[]) => (args: FindArgs) =>
    Promise.resolve(select(rows, args)) as never;

  prisma.authUser.findUnique.mockImplementation(one(ROWS.authUser) as never);
  prisma.makeupSession.findMany.mockImplementation(
    many(ROWS.makeupSession) as never,
  );
  prisma.imageAsset.findMany.mockImplementation(many(images) as never);
  prisma.aiRun.findMany.mockImplementation(many(ROWS.aiRun) as never);
  prisma.userSubscription.findUnique.mockImplementation(
    one(ROWS.userSubscription) as never,
  );
  prisma.loginHistory.findMany.mockImplementation(
    many(ROWS.loginHistory) as never,
  );
  prisma.emailHistory.findMany.mockImplementation(
    many(ROWS.emailHistory) as never,
  );
  return prisma;
}
