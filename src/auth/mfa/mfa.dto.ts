import { BadRequestException } from '@nestjs/common';
import { IsOptional, IsString, Matches } from 'class-validator';
import type { MfaFactor } from './mfa-verification.service';
import { RECOVERY_CODE_INPUT_PATTERN } from './mfa-recovery-codes';

const TOTP_CODE_PATTERN = /^\d{6}$/;
const TOTP_CODE_MESSAGE = 'code must be exactly 6 digits';

/**
 * Confirms the signed-in user's MFA enrollment with the six-digit code the
 * authenticator app currently shows. The account is always the access
 * token's user; any other field (for example a user ID) is rejected.
 */
export class ConfirmMfaEnrollmentDto {
  /** The authenticator app's current code, exactly six digits. */
  @IsString()
  @Matches(TOTP_CODE_PATTERN, { message: TOTP_CODE_MESSAGE })
  code!: string;
}

/**
 * A second factor of the signed-in user: exactly one of the authenticator
 * app's current `code` or a `recoveryCode` (`ABCDE-FGHJK`; case and the
 * hyphen do not matter). Any other field is rejected.
 */
export class MfaVerificationDto {
  /** The authenticator app's current code, exactly six digits. */
  @IsOptional()
  @IsString()
  @Matches(TOTP_CODE_PATTERN, { message: TOTP_CODE_MESSAGE })
  code?: string;

  /** One of the recovery codes shown when MFA was enabled or regenerated. */
  @IsOptional()
  @IsString()
  @Matches(RECOVERY_CODE_INPUT_PATTERN, {
    message: 'recoveryCode must look like ABCDE-FGHJK',
  })
  recoveryCode?: string;
}

/** The factor of a validated request; exactly one must be given. */
export function toMfaFactor(dto: MfaVerificationDto): MfaFactor {
  const hasCode = dto.code !== undefined && dto.code !== null;
  const hasRecoveryCode =
    dto.recoveryCode !== undefined && dto.recoveryCode !== null;
  if (hasCode === hasRecoveryCode) {
    throw new BadRequestException(
      'Provide exactly one of code or recoveryCode',
    );
  }
  return hasCode
    ? { method: 'totp', code: dto.code as string }
    : { method: 'recovery_code', code: dto.recoveryCode as string };
}
