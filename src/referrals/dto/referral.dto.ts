import { ReferralStatus } from '@prisma/client';
import { IsEnum, IsString, Length, ValidateIf } from 'class-validator';

/**
 * GET /v1/referrals and /v1/referrals/rewards take no parameters: any (for
 * example another user's id) is rejected, never silently ignored.
 */
export class NoReferralQueryDto {}

/** GET /v1/referrals/invitees: optional status filter. */
export class ListInviteesQueryDto {
  @ValidateIf((_: object, value: unknown) => value !== undefined)
  @IsEnum(ReferralStatus)
  status?: ReferralStatus;
}

/** A referral code (POST /v1/referrals/apply, always refused). */
export class ApplyReferralCodeDto {
  @IsString()
  @Length(1, 32)
  code!: string;
}
