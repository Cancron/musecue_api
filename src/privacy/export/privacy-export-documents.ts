import { PRIVACY_EXPORT_FORMAT_VERSION } from '../privacy-export.constants';
import type {
  PrivacyExportSnapshot,
  UnavailablePhoto,
} from './privacy-export-collector.service';

export interface ExportDocument {
  path: string;
  data: unknown;
}

export interface ManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}

/**
 * Builds the structured JSON documents of an archive from a snapshot.
 * `writtenPhotoPaths` holds the archive paths of photos that were actually
 * copied, so documents only reference files that exist in the archive.
 */
export function renderExportDocuments(
  snapshot: PrivacyExportSnapshot,
  writtenPhotoPaths: ReadonlySet<string>,
): ExportDocument[] {
  const fileForImage = new Map<string, string>();
  let avatarFile: string | null = null;
  for (const photo of snapshot.photos) {
    if (!writtenPhotoPaths.has(photo.archivePath)) continue;
    if (photo.kind === 'AVATAR') avatarFile = photo.archivePath;
    else if (photo.imageId) fileForImage.set(photo.imageId, photo.archivePath);
  }

  const { payments, events, ...subscriptionRecord } = snapshot.subscription ?? {
    payments: [],
    events: [],
  };

  return [
    {
      path: 'data/account.json',
      data: { account: snapshot.account, security: snapshot.security },
    },
    {
      path: 'data/profile.json',
      data: {
        profile: snapshot.profile,
        avatar: {
          file: avatarFile,
          externalUrl: snapshot.externalAvatarUrl,
        },
      },
    },
    {
      path: 'data/makeup-history.json',
      data: {
        sessions: snapshot.sessions.map((session) => ({
          ...session,
          images: session.images.map((image) => ({
            ...image,
            file: fileForImage.get(image.id) ?? null,
          })),
        })),
        aiProcessing: snapshot.aiRuns,
      },
    },
    {
      path: 'data/subscription.json',
      data: {
        currentStatus: snapshot.subscriptionStatus,
        record: snapshot.subscription ? subscriptionRecord : null,
        payments,
        events,
      },
    },
    {
      path: 'data/credits.json',
      data: {
        allocations: snapshot.credits.allocations,
        transactions: snapshot.credits.transactions,
        sessionOverage: snapshot.credits.sessions,
        aiUsage: snapshot.credits.aiUsage,
      },
    },
    {
      path: 'data/sign-in-history.json',
      data: {
        entries: snapshot.loginHistory.map((entry) => ({
          createdAt: entry.createdAt,
          action: entry.action,
          success: entry.success,
          failureReason: entry.failureReason,
          ipAddress: entry.ipAddress,
          userAgent: entry.userAgent,
          deviceId: entry.device_id,
          country: entry.geo_country,
          city: entry.geo_city,
        })),
      },
    },
    {
      path: 'data/email-history.json',
      data: { entries: snapshot.emailHistory },
    },
  ];
}

export function renderManifest(
  snapshot: PrivacyExportSnapshot,
  entries: ManifestEntry[],
  unavailablePhotos: UnavailablePhoto[],
): unknown {
  return {
    formatVersion: PRIVACY_EXPORT_FORMAT_VERSION,
    exportId: snapshot.exportId,
    accountId: snapshot.account.id,
    generatedAt: snapshot.generatedAt,
    files: entries,
    photos: {
      included: entries.filter((entry) => entry.path.startsWith('photos/'))
        .length,
      unavailable: unavailablePhotos,
    },
  };
}

export function renderReadme(snapshot: PrivacyExportSnapshot): string {
  return [
    'MuseCue personal data export',
    '============================',
    '',
    `Account: ${snapshot.account.id}`,
    `Generated: ${snapshot.generatedAt.toISOString()}`,
    `Format version: ${PRIVACY_EXPORT_FORMAT_VERSION}`,
    '',
    'Contents',
    '--------',
    'data/account.json          Account details and security settings',
    'data/profile.json          Profile details and avatar reference',
    'data/makeup-history.json   Makeup sessions, preferences, face analyses,',
    '                           recommendations, guides, step checks,',
    '                           questions and AI processing records',
    'data/subscription.json     Subscription status, trial, payments and events',
    'data/credits.json          AI credit allocations, transaction history,',
    '                           session overage and AI usage',
    'data/sign-in-history.json  Sign-in and sign-out activity',
    'data/email-history.json    Account emails sent to you',
    'photos/profile/            Your profile avatar',
    'photos/sessions/<id>/      Photos you uploaded to each makeup session',
    'manifest.json              Every file with its size and SHA-256 checksum,',
    '                           plus photos that could not be included',
    '',
    'Passwords, security codes and sign-in tokens are never included.',
    'Times are UTC (ISO 8601).',
    '',
  ].join('\n');
}
