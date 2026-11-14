import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Confirms that the signed-in user is the account owner: accounts with a
 * password send `password`; accounts without one (for example Google
 * sign-in) send the `code` emailed by POST
 * /v1/privacy/account-deletion/confirmation-code.
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
