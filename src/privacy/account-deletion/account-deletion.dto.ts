import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Confirms that the signed-in user is the account owner, with the `code`
 * emailed by POST /v1/privacy/account-deletion/confirmation-code. Accounts
 * with a password also send their current `password`; accounts without one
 * (for example Google sign-in) send only the code.
 */
export class RequestAccountDeletionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9]{6}$/, { message: 'code must be 6 letters or digits' })
  code?: string;
}
