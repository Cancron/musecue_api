import { IsString, Matches, MaxLength } from 'class-validator';
import { MFA_SMS } from './mfa-sms.constants';

/**
 * A phone number for SMS codes, in international form (`+` and the
 * country code), for example `+14155550123` or `+44 20 7946 0958`.
 */
export class StartSmsPhoneDto {
  @IsString()
  @MaxLength(32)
  @Matches(MFA_SMS.INPUT_PATTERN, {
    message:
      'phoneNumber must be an international number, for example +14155550123',
  })
  phoneNumber!: string;
}

/** The six-digit code sent by SMS to the number being verified. */
export class ConfirmSmsPhoneDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be exactly 6 digits' })
  code!: string;
}
