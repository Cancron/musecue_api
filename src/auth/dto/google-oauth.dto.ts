import {
  IsOptional,
  IsString,
  IsUrl,
  Length,
  ValidateIf,
} from 'class-validator';

/**
 * DTO for initiating Google OAuth flow
 */
export class GoogleOAuthInitDto {
  @IsOptional()
  @IsUrl()
  @IsString()
  redirectUrl?: string;

  /**
   * Optional: another user's referral code, applied only if this Google
   * sign-in creates a new account (never to an existing account).
   */
  @ValidateIf((_: object, value: unknown) => value !== undefined)
  @IsString()
  @Length(1, 32)
  referralCode?: string;
}

/**
 * DTO for Google OAuth callback
 */
export class GoogleOAuthCallbackDto {
  @IsString()
  code: string;

  @IsString()
  state: string;
}
