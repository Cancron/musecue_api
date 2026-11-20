import { IsString, Matches, MaxLength } from 'class-validator';
import { MFA_LOGIN } from '../mfa.constants';

/**
 * A phone number to verify for SMS codes, in international format
 * (`+14155550123`; spaces, hyphens, dots and parentheses are ignored).
 */
export class SmsPhoneNumberDto {
  @IsString()
  @MaxLength(32)
  @Matches(/^\+[0-9 ().-]{7,31}$/, {
    message: 'phoneNumber must be an international number such as +14155550123',
  })
  phoneNumber!: string;
}

/** The six-digit code sent by SMS to the number being verified. */
export class SmsVerificationCodeDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be exactly 6 digits' })
  code!: string;
}

/** Sends an SMS code for the MFA step of a sign-in. */
export class SendSmsSignInCodeDto {
  @IsString()
  @Matches(MFA_LOGIN.CHALLENGE_TOKEN_PATTERN, {
    message: 'challengeToken is not a valid MFA challenge token',
  })
  challengeToken!: string;
}
