import { BadRequestException } from '@nestjs/common';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MFA_LOGIN } from './mfa.constants';
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

/**
 * The MFA step of sign-in: the challenge token from POST /auth/login (or the
 * Google callback), exactly one factor (`code` or `recoveryCode`), and
 * whether to trust this device for 30 days.
 */
export class CompleteMfaLoginDto extends MfaVerificationDto {
  @IsString()
  @Matches(MFA_LOGIN.CHALLENGE_TOKEN_PATTERN, {
    message: 'challengeToken is not a valid MFA challenge token',
  })
  challengeToken!: string;

  /** Skip MFA on this device for 30 days (its token is returned once). */
  @IsOptional()
  @IsBoolean()
  trustDevice?: boolean;

  /** A label for the trusted device (defaults to the device/user agent). */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  deviceName?: string;
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
