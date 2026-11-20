import { StepUpAction } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { RECOVERY_CODE_INPUT_PATTERN } from '../mfa/mfa-recovery-codes';

/**
 * Approves one sensitive action for the caller's session: MFA users send
 * exactly one of `code` or `recoveryCode`; users without MFA send their
 * `password`. Google-only accounts use POST /auth/step-up/google instead.
 */
export class ApproveStepUpDto {
  @IsEnum(StepUpAction)
  action!: StepUpAction;

  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be exactly 6 digits' })
  code?: string;

  @IsOptional()
  @IsString()
  @Matches(RECOVERY_CODE_INPUT_PATTERN, {
    message: 'recoveryCode must look like ABCDE-FGHJK',
  })
  recoveryCode?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password?: string;
}

/** Starts a Google reauthentication for one action. */
export class StartGoogleStepUpDto {
  @IsEnum(StepUpAction)
  action!: StepUpAction;
}

/** The `code` and `state` Google returned to the step-up redirect URI. */
export class CompleteGoogleStepUpDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  code!: string;

  @IsString()
  @Matches(/^[0-9a-f]{64}$/, { message: 'state is not a step-up state' })
  state!: string;
}
