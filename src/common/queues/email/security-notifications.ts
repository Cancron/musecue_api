/**
 * Security notifications: emails telling an account owner that a security
 * setting changed. Their text is fixed per event. They never contain a
 * secret, code, token, key or device detail: only what changed and when,
 * and what to do if it was not the owner.
 */
export type SecurityNotificationEvent =
  | 'MFA_DISABLED'
  | 'MFA_AUTHENTICATOR_REPLACED'
  | 'MFA_RECOVERY_CODES_REGENERATED'
  | 'MFA_SMS_PHONE_ADDED'
  | 'MFA_SMS_PHONE_REPLACED'
  | 'MFA_SMS_PHONE_REMOVED';

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
  MFA_SMS_PHONE_ADDED: {
    subject: 'Security alert: a phone number was added for sign-in codes',
    title: 'A phone number was added for sign-in codes',
    description:
      'A phone number was verified for two-step verification by text message (SMS) on your MuseCue account. Sign-in codes can now be sent to it.',
  },
  MFA_SMS_PHONE_REPLACED: {
    subject: 'Security alert: your phone number for sign-in codes was changed',
    title: 'Your phone number for sign-in codes was changed',
    description:
      'A new phone number now receives the two-step verification text messages (SMS) of your MuseCue account. The previous number no longer receives codes, and codes sent to it no longer work.',
  },
  MFA_SMS_PHONE_REMOVED: {
    subject: 'Security alert: sign-in codes by text message were turned off',
    title: 'Sign-in codes by text message were turned off',
    description:
      'The phone number for two-step verification by text message (SMS) was removed from your MuseCue account. Codes sent to it no longer work.',
  },
};
