import {
  email_status,
  email_type,
  NotificationType,
  type Prisma,
} from '@prisma/client';
import {
  decryptSecret,
  encryptSecret,
  keyedHash,
  SECRET_PURPOSES,
} from '../../security/derived-secrets';

/**
 * The email outbox (emailHistory): rules shared by the code that records
 * emails, the email job and the outbox sweep.
 */

/** Failed SMTP attempts before an email is given up (stays `failed`). */
export const MAX_EMAIL_ATTEMPTS = 8;

/** A claim older than this was interrupted (the worker stopped). */
export const EMAIL_CLAIM_STALE_MS = 10 * 60_000;

/** Statuses of an email that still has to be delivered. */
export const UNSENT_EMAIL_STATUSES: email_status[] = [
  email_status.pending,
  email_status.failed,
];

/**
 * When the outbox dispatches an email again after `failures` failed
 * attempts (the job queue retries within seconds first; this covers longer
 * outages and restarts).
 */
export function emailRetryDelayMs(failures: number): number {
  const steps = [
    60_000,
    5 * 60_000,
    15 * 60_000,
    60 * 60_000,
    3 * 60 * 60_000,
    6 * 60 * 60_000,
    12 * 60 * 60_000,
  ];
  return steps[Math.min(Math.max(failures, 1), steps.length) - 1];
}

export const EMAIL_SUBJECTS = {
  verification: 'Verify your MuseCue email address',
  welcome: 'Welcome to MuseCue!',
  accountDeletion: 'Confirm the deletion of your MuseCue account',
} as const;

/** The email type of a notification's email. */
export function emailTypeOfNotification(type: NotificationType): email_type {
  switch (type) {
    case NotificationType.REFERRAL_REWARD_EARNED:
    case NotificationType.REFERRAL_MILESTONE_REACHED:
      return email_type.referral;
    case NotificationType.SECURITY_SIGNED_OUT_EVERYWHERE:
    case NotificationType.SECURITY_SESSION_REUSE_DETECTED:
      return email_type.security;
    case NotificationType.CREDIT_PURCHASE_COMPLETED:
    case NotificationType.CREDIT_PURCHASE_FAILED:
      return email_type.purchase;
    case NotificationType.GIFT_RECEIVED:
    case NotificationType.GIFT_ACCEPTED:
    case NotificationType.GIFT_DECLINED:
    case NotificationType.GIFT_DELIVERED:
    case NotificationType.GIFT_PAID:
    case NotificationType.GIFT_CANCELED:
    case NotificationType.GIFT_EXPIRED:
    case NotificationType.GIFT_UNDER_REVIEW:
    case NotificationType.GIFT_REJECTED:
      return email_type.gift;
  }
}

/** One email to record in the outbox. */
export interface EmailRecordInput {
  authId: string;
  emailTo: string;
  type: email_type;
  subject: string;
  /** Unique per email: derived from the event, so no event emails twice. */
  messageId: string;
  notificationId?: string;
  /** Template values that must not be stored in clear (e.g. a code). */
  secret?: Record<string, string | number>;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Records an email in the outbox (status `pending`, due now), or finds the
 * one already recorded for the same `messageId`. Returns its id and its
 * current state.
 */
export async function recordEmail(
  client: Prisma.TransactionClient,
  input: EmailRecordInput,
  now: Date = new Date(),
): Promise<RecordedEmail> {
  await client.emailHistory.createMany({
    data: [
      {
        authId: input.authId,
        emailTo: input.emailTo,
        emailType: input.type,
        subject: input.subject,
        messageId: input.messageId,
        notificationId: input.notificationId ?? null,
        emailStatus: email_status.pending,
        payload: input.secret
          ? sealEmailPayload(input.messageId, input.secret)
          : null,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        nextAttemptAt: now,
      },
    ],
    skipDuplicates: true,
  });
  const stored = await client.emailHistory.findUniqueOrThrow({
    where: { messageId: input.messageId },
    select: {
      id: true,
      retry_count: true,
      emailStatus: true,
      nextAttemptAt: true,
    },
  });
  return {
    id: stored.id,
    status: stored.emailStatus,
    dispatchKey: emailDispatchKey(stored),
  };
}

export interface RecordedEmail {
  id: string;
  status: email_status;
  dispatchKey: string;
}

/**
 * Identifies one dispatch round of an email (its failed attempts and next
 * attempt time): the job id, so dispatching the same round twice queues one
 * job, while a retry or a released claim gets a new one.
 */
export const emailDispatchKey = (email: {
  retry_count: number;
  nextAttemptAt: Date | null;
}) => `${email.retry_count}-${email.nextAttemptAt?.getTime() ?? 0}`;

/** A short, stable part of a message id derived from a secret. */
export const secretDigest = (secret: string) =>
  keyedHash(SECRET_PURPOSES.EMAIL_PAYLOAD, secret).slice(0, 24);

export function sealEmailPayload(
  messageId: string,
  secret: Record<string, string | number>,
): string {
  return encryptSecret(
    SECRET_PURPOSES.EMAIL_PAYLOAD,
    JSON.stringify(secret),
    messageId,
  );
}

export function openEmailPayload(
  messageId: string,
  payload: string | null,
): Record<string, string | number> {
  if (!payload) return {};
  return JSON.parse(
    decryptSecret(SECRET_PURPOSES.EMAIL_PAYLOAD, payload, messageId),
  ) as Record<string, string | number>;
}

/**
 * What a failed attempt records: the SMTP response code or the error code,
 * and the (truncated) message. Never a stack trace.
 */
export function emailErrorDetail(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'unknown error';
  const e = error as {
    responseCode?: number;
    code?: string;
    message?: string;
  };
  const code = e.responseCode
    ? `smtp:${e.responseCode}`
    : typeof e.code === 'string'
      ? e.code
      : error instanceof Error
        ? error.name
        : 'error';
  return `${code} ${e.message ?? ''}`.trim().slice(0, 500);
}
