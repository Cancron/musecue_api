import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { extname } from 'node:path';
import { PrismaService } from '../../common/services/prisma.service';
import { isOwnedPrivateImageKey } from '../../storage/private-storage-key';
import type { SubscriptionStatusView } from '../../subscription/interfaces/subscription-status.interface';
import { SubscriptionAccessService } from '../../subscription/subscription-access.service';
import { PrivacyExportPermanentError } from './privacy-export.errors';

/*
 * Every select below is an explicit allowlist. Columns that are credentials
 * or internal references are deliberately absent and must stay absent:
 * authUser.password, authUser.tokenVersion, authUser.providerId,
 * authSecurity.mfaSecret, ImageAsset.storageKey (read separately, only to
 * locate photo bytes), AiRun.idempotencyKey/result/usage, payment-provider
 * IDs, email message IDs, and activity-log rows (which can describe other
 * users' records when the requester is an administrator).
 */

const ACCOUNT_SELECT = {
  id: true,
  email: true,
  username: true,
  role: true,
  verified: true,
  status: true,
  provider: true,
  createdAt: true,
  updatedAt: true,
  authSecurity: {
    select: { mfaEnabled: true, mfaMethod: true, lastPasswordChange: true },
  },
  userProfile: {
    select: {
      firstName: true,
      lastName: true,
      bio: true,
      avatarUrl: true,
      createdAt: true,
      updatedAt: true,
    },
  },
} satisfies Prisma.authUserSelect;

const SESSION_SELECT = {
  id: true,
  status: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  preferences: {
    select: {
      vibe: true,
      skillLevel: true,
      occasion: true,
      desiredEffect: true,
      timeMinutes: true,
      notes: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  faceAnalysis: {
    select: {
      faceShape: true,
      skinTone: true,
      undertone: true,
      notableFeatures: true,
      confidence: true,
      createdAt: true,
    },
  },
  recommendations: {
    orderBy: { rank: 'asc' },
    select: {
      id: true,
      rank: true,
      name: true,
      tagline: true,
      matchScore: true,
      imageUrl: true,
      palette: true,
      rationale: true,
      selectedAt: true,
      savedAt: true,
      createdAt: true,
    },
  },
  images: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      guideStepId: true,
      purpose: true,
      source: true,
      mimeType: true,
      width: true,
      height: true,
      sizeBytes: true,
      createdAt: true,
    },
  },
  guide: {
    select: {
      id: true,
      recommendationId: true,
      status: true,
      currentStepIndex: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      steps: {
        orderBy: { position: 'asc' },
        select: {
          id: true,
          position: true,
          status: true,
          title: true,
          instruction: true,
          substeps: true,
          spokenIntro: true,
          spokenSubsteps: true,
          area: true,
          technique: true,
          estimatedSeconds: true,
          personalizedTip: true,
          commonMistake: true,
          successCriteria: true,
          completedAt: true,
          attempts: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              imageId: true,
              result: true,
              feedback: true,
              spokenFeedback: true,
              confidence: true,
              createdAt: true,
            },
          },
          questions: {
            orderBy: { createdAt: 'asc' },
            select: { id: true, question: true, answer: true, createdAt: true },
          },
        },
      },
    },
  },
} satisfies Prisma.MakeupSessionSelect;

const AI_RUN_SELECT = {
  id: true,
  sessionId: true,
  stepId: true,
  operation: true,
  status: true,
  provider: true,
  model: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
} satisfies Prisma.AiRunSelect;

const SUBSCRIPTION_SELECT = {
  status: true,
  trialUsed: true,
  trialStartedAt: true,
  trialExpiresAt: true,
  billingInterval: true,
  proStartedAt: true,
  proExpiresAt: true,
  proCanceledAt: true,
  paymentProvider: true,
  createdAt: true,
  updatedAt: true,
  payments: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      provider: true,
      status: true,
      amountCents: true,
      currency: true,
      billingInterval: true,
      periodStart: true,
      periodEnd: true,
      paidAt: true,
      failedAt: true,
      failureCode: true,
      refundedAmountCents: true,
      refundedAt: true,
      createdAt: true,
    },
  },
  events: {
    orderBy: { occurredAt: 'asc' },
    select: { id: true, type: true, paymentId: true, occurredAt: true },
  },
} satisfies Prisma.UserSubscriptionSelect;

const LOGIN_HISTORY_SELECT = {
  createdAt: true,
  action: true,
  success: true,
  failureReason: true,
  ipAddress: true,
  userAgent: true,
  device_id: true,
  geo_country: true,
  geo_city: true,
} satisfies Prisma.loginHistorySelect;

const EMAIL_HISTORY_SELECT = {
  sentAt: true,
  emailType: true,
  emailTo: true,
  subject: true,
  emailStatus: true,
} satisfies Prisma.emailHistorySelect;

const PHOTO_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};
const AVATAR_EXTENSIONS = new Set(['.jpg', '.png', '.webp']);
/** Scope ProfileService uses when saving avatars. */
const AVATAR_SCOPE = 'profile';

export type ExportAccount = Prisma.authUserGetPayload<{
  select: typeof ACCOUNT_SELECT;
}>;
export type ExportSession = Prisma.MakeupSessionGetPayload<{
  select: typeof SESSION_SELECT;
}>;
export type ExportAiRun = Prisma.AiRunGetPayload<{
  select: typeof AI_RUN_SELECT;
}>;
export type ExportSubscription = Prisma.UserSubscriptionGetPayload<{
  select: typeof SUBSCRIPTION_SELECT;
}>;
export type ExportLogin = Prisma.loginHistoryGetPayload<{
  select: typeof LOGIN_HISTORY_SELECT;
}>;
export type ExportEmail = Prisma.emailHistoryGetPayload<{
  select: typeof EMAIL_HISTORY_SELECT;
}>;

export type PhotoUnavailableReason =
  /** Not a private upload (for example a mock capture or an external URL). */
  | 'NOT_STORED'
  /** The file no longer exists in private storage. */
  | 'FILE_MISSING'
  /** The stored reference is not inside the owner's private scope. */
  | 'UNAVAILABLE';

/** A private photo to copy into the archive. */
export interface ExportPhoto {
  archivePath: string;
  kind: 'AVATAR' | 'SESSION_IMAGE';
  imageId: string | null;
  sessionId: string | null;
  /** Internal; used to read the bytes and never written to the archive. */
  storageKey: string;
}

export interface UnavailablePhoto {
  kind: ExportPhoto['kind'];
  imageId: string | null;
  sessionId: string | null;
  reason: PhotoUnavailableReason;
}

/** Everything an export contains, read for one owner at one point in time. */
export interface PrivacyExportSnapshot {
  exportId: string;
  generatedAt: Date;
  account: Omit<ExportAccount, 'authSecurity' | 'userProfile'>;
  security: ExportAccount['authSecurity'];
  profile: Omit<NonNullable<ExportAccount['userProfile']>, 'avatarUrl'> | null;
  /** An avatar hosted elsewhere (for example by the OAuth provider). */
  externalAvatarUrl: string | null;
  sessions: ExportSession[];
  aiRuns: ExportAiRun[];
  subscriptionStatus: SubscriptionStatusView;
  subscription: ExportSubscription | null;
  loginHistory: ExportLogin[];
  emailHistory: ExportEmail[];
  photos: ExportPhoto[];
  unavailablePhotos: UnavailablePhoto[];
}

/** Reads the data of exactly one owner for a personal-data export. */
@Injectable()
export class PrivacyExportCollectorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionAccessService,
  ) {}

  async collect(
    authId: string,
    exportId: string,
    now: Date = new Date(),
  ): Promise<PrivacyExportSnapshot> {
    const user = await this.prisma.authUser.findUnique({
      where: { id: authId },
      select: ACCOUNT_SELECT,
    });
    if (!user) {
      throw new PrivacyExportPermanentError('The account no longer exists');
    }

    const [
      sessions,
      images,
      aiRuns,
      subscription,
      subscriptionStatus,
      loginHistory,
      emailHistory,
    ] = await Promise.all([
      this.prisma.makeupSession.findMany({
        where: { authId },
        orderBy: { createdAt: 'asc' },
        select: SESSION_SELECT,
      }),
      this.prisma.imageAsset.findMany({
        where: { session: { authId } },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          sessionId: true,
          source: true,
          mimeType: true,
          storageKey: true,
        },
      }),
      this.prisma.aiRun.findMany({
        where: { authId },
        orderBy: { createdAt: 'asc' },
        select: AI_RUN_SELECT,
      }),
      this.prisma.userSubscription.findUnique({
        where: { authId },
        select: SUBSCRIPTION_SELECT,
      }),
      this.subscriptions.getStatus(authId, now),
      this.prisma.loginHistory.findMany({
        where: { authId },
        orderBy: { createdAt: 'asc' },
        select: LOGIN_HISTORY_SELECT,
      }),
      this.prisma.emailHistory.findMany({
        where: { authId },
        orderBy: { sentAt: 'asc' },
        select: EMAIL_HISTORY_SELECT,
      }),
    ]);

    const photos: ExportPhoto[] = [];
    const unavailablePhotos: UnavailablePhoto[] = [];
    const { authSecurity, userProfile, ...account } = user;

    let externalAvatarUrl: string | null = null;
    const avatarKey = userProfile?.avatarUrl ?? null;
    if (avatarKey?.includes('://')) {
      externalAvatarUrl = avatarKey;
    } else if (avatarKey) {
      const extension = extname(avatarKey).toLowerCase();
      const photo = {
        kind: 'AVATAR' as const,
        imageId: null,
        sessionId: null,
      };
      if (
        isOwnedPrivateImageKey(avatarKey, authId, AVATAR_SCOPE) &&
        AVATAR_EXTENSIONS.has(extension)
      ) {
        photos.push({
          ...photo,
          archivePath: `photos/profile/avatar${extension}`,
          storageKey: avatarKey,
        });
      } else {
        unavailablePhotos.push({ ...photo, reason: 'UNAVAILABLE' });
      }
    }

    for (const image of images) {
      const photo = {
        kind: 'SESSION_IMAGE' as const,
        imageId: image.id,
        sessionId: image.sessionId,
      };
      if (
        image.source !== 'PRIVATE_UPLOAD' ||
        image.storageKey.includes('://')
      ) {
        unavailablePhotos.push({ ...photo, reason: 'NOT_STORED' });
      } else if (
        // Session images are saved under <authId>/<sessionId>/; anything
        // else (another owner or session, traversal, backslashes) is refused.
        !isOwnedPrivateImageKey(image.storageKey, authId, image.sessionId)
      ) {
        unavailablePhotos.push({ ...photo, reason: 'UNAVAILABLE' });
      } else {
        const extension = PHOTO_EXTENSIONS[image.mimeType] ?? '.bin';
        photos.push({
          ...photo,
          archivePath: `photos/sessions/${image.sessionId}/${image.id}${extension}`,
          storageKey: image.storageKey,
        });
      }
    }

    const profile: PrivacyExportSnapshot['profile'] = userProfile
      ? {
          firstName: userProfile.firstName,
          lastName: userProfile.lastName,
          bio: userProfile.bio,
          createdAt: userProfile.createdAt,
          updatedAt: userProfile.updatedAt,
        }
      : null;

    return {
      exportId,
      generatedAt: now,
      account,
      security: authSecurity,
      profile,
      externalAvatarUrl,
      sessions,
      aiRuns,
      subscriptionStatus,
      subscription,
      loginHistory,
      emailHistory,
      photos,
      unavailablePhotos,
    };
  }
}
