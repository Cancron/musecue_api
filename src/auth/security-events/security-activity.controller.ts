import { Controller, Get, Header, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import type { Request } from 'express';
import { AuthGuard } from '../../common/guards/auth.guard';
import type { IAccessTokenPayload } from '../interfaces/auth.interface';
import { SecurityEventLog } from './security-event.log';

/** `page` (from 1) and `limit` (1-100, default 20); nothing else. */
export class SecurityActivityQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

/** The signed-in user's own security activity history. */
@ApiTags('security')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Controller('v1/security/activity')
export class SecurityActivityController {
  constructor(private readonly events: SecurityEventLog) {}

  /**
   * Newest first (then by ID, so pages are stable). Only the token user's
   * events; no secret, code or token is ever part of them.
   */
  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @Query() query: SecurityActivityQueryDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.events.list(
      req.user.userId,
      query.page ?? 1,
      query.limit ?? 20,
      req.user.sid,
    );
  }
}
