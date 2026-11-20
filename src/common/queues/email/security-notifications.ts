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
  | 'MFA_SMS_ENABLED'
  | 'MFA_SMS_PHONE_REPLACED'
  | 'MFA_SMS_DISABLED';

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
  MFA_SMS_ENABLED: {
    subject: 'Security alert: a phone number was added for sign-in codes',
    title: 'A phone number was added for sign-in codes',
    description:
      'A phone number was verified for your MuseCue account and can now receive two-step verification codes by SMS when you sign in.',
  },
  MFA_SMS_PHONE_REPLACED: {
    subject: 'Security alert: your sign-in phone number was changed',
    title: 'Your sign-in phone number was changed',
    description:
      'The phone number that receives your MuseCue sign-in codes by SMS was replaced. Codes sent to the previous number no longer work.',
  },
  MFA_SMS_DISABLED: {
    subject: 'Security alert: SMS sign-in codes were turned off',
    title: 'SMS sign-in codes were turned off',
    description:
      'The phone number was removed from your MuseCue account and sign-in codes are no longer sent by SMS. Codes already sent no longer work.',
  },
};
