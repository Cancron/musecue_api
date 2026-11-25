import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  Validate,
  ValidateIf,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';

/** The current code from the authenticator app, exactly 6 digits. */
export class ConfirmMfaEnrollmentDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit authenticator code' })
  code!: string;
}

@ValidatorConstraint({ name: 'exactlyOneMfaFactor' })
class ExactlyOneMfaFactor implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as VerifyMfaDto;
    return (dto.code === undefined) !== (dto.recoveryCode === undefined);
  }

  defaultMessage(): string {
    return 'send exactly one of code or recoveryCode';
  }
}

/**
 * A second factor: the authenticator's current 6-digit `code`, or one of the
 * account's `recoveryCode`s (XXXX-XXXX-XXXX; hyphens, spaces and case do not
 * matter). Exactly one of the two. Messages never repeat the submitted value.
 */
export class VerifyMfaDto {
  // Checked when present, and when both are missing (to report that).
  @ValidateIf(
    (dto: VerifyMfaDto) =>
      dto.code !== undefined || dto.recoveryCode === undefined,
  )
  @Validate(ExactlyOneMfaFactor)
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit authenticator code' })
  code?: string;

  @IsOptional()
  @IsString()
  @Matches(/^ *[0-9A-Za-z]{4}[- ]?[0-9A-Za-z]{4}[- ]?[0-9A-Za-z]{4} *$/, {
    message: 'recoveryCode must look like XXXX-XXXX-XXXX',
  })
  recoveryCode?: string;
}

/**
 * Completes a sign-in of an MFA-enabled account: the `challengeToken` from
 * the sign-in response and exactly one of `code` / `recoveryCode`. With
 * `trustDevice: true` the response includes a trusted-device token that
 * skips the challenge on this device for 30 days.
 */
export class CompleteMfaChallengeDto extends VerifyMfaDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/, { message: 'challengeToken is malformed' })
  challengeToken!: string;

  @IsOptional()
  @IsBoolean()
  trustDevice?: boolean;

  /** A name for the trusted device (default: the device header or user agent). */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  deviceName?: string;
}

/** The factor of a verified DTO. */
export function factorOf(
  dto: VerifyMfaDto,
): { code: string } | { recoveryCode: string } {
  return dto.recoveryCode !== undefined
    ? { recoveryCode: dto.recoveryCode }
    : { code: dto.code as string };
}
