import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { pipeline } from 'node:stream/promises';
import type { IAccessTokenPayload } from '../auth/interfaces/auth.interface';
import { THROTTLER_CONFIG } from '../common/config/throttler.config';
import { AuthGuard } from '../common/guards/auth.guard';
import { PrivacyExportDownloadService } from './download/privacy-export-download.service';
import {
  DownloadArchiveQueryDto,
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
  constructor(
    private readonly exports: PrivacyExportService,
    private readonly downloads: PrivacyExportDownloadService,
  ) {}

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

  /**
   * A temporary signed link (at most 15 minutes) to the caller's completed
   * export. Pending or failed exports return 409, expired exports 410.
   */
  @Get(':exportId/download')
  @Header('Cache-Control', 'private, no-store')
  createDownloadLink(
    @Req() req: AuthenticatedRequest,
    @Param('exportId', new ParseUUIDPipe()) exportId: string,
  ) {
    return this.downloads.createLink(req.user.userId, exportId);
  }

  /**
   * Streams the archive for a signed link. The link must be used with the
   * owner's bearer token; invalid or foreign links return 403 and expired
   * links 410.
   */
  @Get(':exportId/archive')
  async downloadArchive(
    @Req() req: AuthenticatedRequest,
    @Param('exportId', new ParseUUIDPipe()) exportId: string,
    @Query() query: DownloadArchiveQueryDto,
    @Res() response: Response,
  ): Promise<void> {
    const download = await this.downloads.openDownload(
      req.user.userId,
      exportId,
      query.expires,
      query.signature,
    );
    response.status(200);
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Content-Length', String(download.archive.sizeBytes));
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${download.fileName}"`,
    );
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      await pipeline(download.archive.stream, response);
    } catch {
      // The client disconnected or the read failed mid-stream; both streams
      // are already destroyed and headers were sent, so nothing else to do.
    }
  }
}
