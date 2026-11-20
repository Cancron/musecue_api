/**
 * Injection token of MfaSmsService where a class reference would create an
 * import cycle (MfaLoginService <-> MfaSmsService).
 */
export const MFA_SMS_SERVICE = Symbol('MFA_SMS_SERVICE');
