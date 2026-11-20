/**
 * Security notifications: emails telling an account owner that a security
 * setting changed. Their text is fixed per event. They never contain a
 * secret, code, token, key or device detail: only what changed and when,
 * and what to do if it was not the owner.
 */
export type SecurityNotificationEvent =
  | 'MFA_DISABLED'
  | 'MFA_AUTHENTICATOR_REPLACED'
  | 'MFA_RECOVERY_CODES_REGENERATED';

export interface SecurityNotificationText {
  subject: string;
  title: string;
  description: string;
}

export const SECURITY_NOTIFICATIONS: Record<
  SecurityNotificationEvent,
  SecurityNotificationText
> = {
  MFA_DISABLED: {
    subject: 'Security alert: two-step verification was turned off',
    title: 'Two-step verification was turned off',
    description:
      'Two-step verification (MFA) was turned off for your MuseCue account. Your recovery codes no longer work and every trusted device was signed out of two-step verification.',
  },
  MFA_AUTHENTICATOR_REPLACED: {
    subject: 'Security alert: your authenticator app was replaced',
    title: 'Your authenticator app was replaced',
    description:
      'A new authenticator app now protects your MuseCue account. Codes from the previous app no longer work, and every trusted device has to verify again.',
  },
  MFA_RECOVERY_CODES_REGENERATED: {
    subject: 'Security alert: new recovery codes were created',
    title: 'New recovery codes were created',
    description:
      'New two-step verification recovery codes were created for your MuseCue account. Your previous recovery codes no longer work.',
  },
};
