import { IsString, Matches } from 'class-validator';

/**
 * Confirms the signed-in user's MFA enrollment with the six-digit code the
 * authenticator app currently shows. The account is always the access
 * token's user; any other field (for example a user ID) is rejected.
 */
export class ConfirmMfaEnrollmentDto {
  /** The authenticator app's current code, exactly six digits. */
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be exactly 6 digits' })
  code!: string;
}
