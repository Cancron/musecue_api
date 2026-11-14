import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { IAccessTokenPayload } from '../auth/interfaces/auth.interface';
import { THROTTLER_CONFIG } from '../common/config/throttler.config';
import { AuthGuard } from '../common/guards/auth.guard';
import {
  EmptyBodyPipe,
  IdempotencyKey,
  IdempotencyKeyPipe,
} from './dto/privacy-export.dto';
import { PrivacyExportService } from './privacy-export.service';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

/** The authenticated user's own personal-data exports. */
@ApiTags('privacy')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Controller('v1/privacy/exports')
export class PrivacyExportController {
  constructor(private readonly exports: PrivacyExportService) {}

  /**
   * Queues a ZIP archive of the caller's data and returns its status with
   * 202. Takes no body. While an export is waiting or running, the same
   * export is returned instead of a new one.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Retry-safe request key (1-128 of A-Z a-z 0-9 _ . : -)',
  })
  requestExport(
    @Req() req: AuthenticatedRequest,
    @Body(EmptyBodyPipe) _body: unknown,
    @IdempotencyKey(IdempotencyKeyPipe) idempotencyKey?: string,
  ) {
    return this.exports.requestExport(req.user.userId, idempotencyKey);
  }

  /** The caller's most recent exports, newest first. */
  @Get()
  listExports(@Req() req: AuthenticatedRequest) {
    return this.exports.listExports(req.user.userId);
  }

  /** Status and progress of one of the caller's exports. */
  @Get(':exportId')
  @Throttle({ default: THROTTLER_CONFIG.RELAXED })
  getExport(
    @Req() req: AuthenticatedRequest,
    @Param('exportId', new ParseUUIDPipe()) exportId: string,
  ) {
    return this.exports.getExport(req.user.userId, exportId);
  }
}
