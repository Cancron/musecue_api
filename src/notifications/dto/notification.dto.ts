import { Type } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  Length,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

const isPresent = (_: object, value: unknown) => value !== undefined;

/** GET /v1/notifications: one page, newest first. */
export class ListNotificationsQueryDto {
  /** 1-50 entries (default 20). */
  @ValidateIf(isPresent)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  /** `nextCursor` of the previous page. */
  @ValidateIf(isPresent)
  @IsString()
  @Length(1, 200)
  cursor?: string;

  /** `unread`, `read` or `all` (default). */
  @ValidateIf(isPresent)
  @IsIn(['all', 'unread', 'read'])
  status?: 'all' | 'unread' | 'read';
}

/** PATCH /v1/notifications/:id */
export class UpdateNotificationDto {
  @IsBoolean()
  read!: boolean;
}

/** PATCH /v1/notifications/preferences: any subset. */
export class UpdateNotificationPreferencesDto {
  @ValidateIf(isPresent)
  @IsBoolean()
  referralRewards?: boolean;

  @ValidateIf(isPresent)
  @IsBoolean()
  referralMilestones?: boolean;

  /** Security emails are mandatory: only `true` is accepted. */
  @ValidateIf(isPresent)
  @Equals(true, { message: 'Security emails cannot be turned off' })
  security?: boolean;
}
