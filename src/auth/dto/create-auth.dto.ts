import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class CreateAuthDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(20)
  @Matches(/^[a-zA-Z0-9_]+$/)
  username: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  password: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @IsNotEmpty()
  email: string;

  /**
   * Optional: another user's referral code (case-insensitive). Referrals
   * are registered only at signup; an invalid, own or duplicate referral
   * refuses the registration (nothing is created).
   */
  @ValidateIf((_: object, value: unknown) => value !== undefined)
  @IsString()
  @Length(1, 32)
  referralCode?: string;
}
