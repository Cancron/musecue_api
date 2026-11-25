import { IsString, Matches } from 'class-validator';

/** The current code from the authenticator app, exactly 6 digits. */
export class ConfirmMfaEnrollmentDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit authenticator code' })
  code!: string;
}
