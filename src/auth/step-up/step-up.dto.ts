import { StepUpAction } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'atMostOneStepUpFactor' })
class AtMostOneFactor implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as StepUpDto;
    return (
      [dto.code, dto.recoveryCode, dto.password].filter((v) => v !== undefined)
        .length <= 1
    );
  }

  defaultMessage(): string {
    return 'send only one of code, recoveryCode or password';
  }
}

/**
 * Confirms the signed-in user's identity for one sensitive `action`: MFA
 * accounts send `code` (authenticator) or `recoveryCode`; accounts without
 * MFA send their current `password`. Accounts with neither use Google
 * re-authentication (POST /v1/auth/step-up/google). Messages never repeat a
 * submitted value.
 */
export class StepUpDto {
  @Validate(AtMostOneFactor)
  @IsEnum(StepUpAction)
  action!: StepUpAction;

  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit authenticator code' })
  code?: string;

  @IsOptional()
  @IsString()
  @Matches(/^ *[0-9A-Za-z]{4}[- ]?[0-9A-Za-z]{4}[- ]?[0-9A-Za-z]{4} *$/, {
    message: 'recoveryCode must look like XXXX-XXXX-XXXX',
  })
  recoveryCode?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password?: string;
}

/** Starts a Google re-authentication for one sensitive action. */
export class StartGoogleStepUpDto {
  @IsEnum(StepUpAction)
  action!: StepUpAction;

  /** Where Google's redirect is forwarded (with step_up_code and step_up_state). */
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  @MaxLength(2048)
  redirectUrl?: string;
}

/** Completes a Google re-authentication with Google's `code` and the `state`. */
export class CompleteGoogleStepUpDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  code!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/, { message: 'state is malformed' })
  state!: string;
}
