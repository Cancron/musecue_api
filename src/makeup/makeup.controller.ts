import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { THROTTLER_CONFIG } from '../common/config/throttler.config';
import { AuthGuard } from '../common/guards/auth.guard';
import {
  AskQuestionDto,
  CompleteStepDto,
  ListSessionsDto,
  SavePreferencesDto,
  SaveRecommendationDto,
  UploadInitialImageDto,
} from './dto/makeup.dto';
import type { AuthenticatedUser } from './interfaces/makeup.interface';
import { MakeupService } from './makeup.service';

interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}

/**
 * Private image responses must never be stored by shared caches (proxies,
 * CDNs) or by the client: `no-store` covers HTTP/1.1 caches, `Pragma` and
 * `Expires` cover HTTP/1.0 intermediaries, `Vary` keeps a misbehaving cache
 * from serving one user's response to another, and `nosniff` stops browsers
 * from reinterpreting the bytes.
 */
function setPrivateNoStoreHeaders(response: Response): void {
  response.setHeader('Cache-Control', 'private, no-store, max-age=0');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Expires', '0');
  response.setHeader('Vary', 'Authorization');
  response.setHeader('X-Content-Type-Options', 'nosniff');
}

@ApiTags('makeup')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Controller('v1')
export class MakeupController {
  constructor(private readonly makeup: MakeupService) {}

  @Post('sessions')
  createSession(@Req() req: AuthenticatedRequest) {
    return this.makeup.createSession(req.user.userId);
  }

  @Get('sessions')
  listSessions(
    @Req() req: AuthenticatedRequest,
    @Query() query: ListSessionsDto,
  ) {
    return this.makeup.listSessions(req.user.userId, query);
  }

  @Get('sessions/:sessionId')
  @Throttle({ default: THROTTLER_CONFIG.RELAXED })
  getSession(
    @Req() req: AuthenticatedRequest,
    @Param('sessionId') sessionId: string,
  ) {
    return this.makeup.getSession(req.user.userId, sessionId);
  }

  @Delete('sessions/:sessionId')
  deleteSession(
    @Req() req: AuthenticatedRequest,
    @Param('sessionId') sessionId: string,
  ) {
    return this.makeup.deleteSession(req.user.userId, sessionId);
  }

  /**
   * Streams an owned private image: the original bytes and the content type
   * recorded when it was stored. Authenticated with the same bearer access
   * token as every other route (the mobile app sends `Authorization` on image
   * requests; tokens in URLs are not accepted). Nothing about the storage
   * provider is exposed, and no cache may keep the response.
   */
  @Get('images/:imageId/content')
  @Throttle({ default: THROTTLER_CONFIG.RELAXED })
  async getImageContent(
    @Req() req: AuthenticatedRequest,
    @Param('imageId') imageId: string,
    @Res() response: Response,
  ) {
    // Set first, so error responses for this private route are not cached either.
    setPrivateNoStoreHeaders(response);
    const image = await this.makeup.getImageContent(req.user.userId, imageId);
    response.setHeader('Content-Type', image.mimeType);
    response.setHeader('Content-Length', String(image.bytes.length));
    response.setHeader('Content-Disposition', 'inline');
    response.end(image.bytes);
  }

  /**
   * Short-lived (60 s) direct download URL for an owned private image. A new
   * URL is issued on every call; nothing is stored, and caching is disabled.
   */
  @Get('images/:imageId/signed-url')
  @Header('Cache-Control', 'private, no-store')
  getImageSignedUrl(
    @Req() req: AuthenticatedRequest,
    @Param('imageId') imageId: string,
  ) {
    return this.makeup.getImageSignedUrl(req.user.userId, imageId);
  }

  @Post('sessions/:sessionId/images')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['image', 'purpose'],
      properties: {
        image: { type: 'string', format: 'binary' },
        purpose: { type: 'string', enum: ['INITIAL_ANALYSIS'] },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      limits: { files: 1, fileSize: 10_000_000 },
    }),
  )
  uploadInitialImage(
    @Req() req: AuthenticatedRequest,
    @Param('sessionId') sessionId: string,
    @Body() _dto: UploadInitialImageDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.makeup.uploadInitialImage(req.user.userId, sessionId, file);
  }

  @Patch('sessions/:sessionId/preferences')
  savePreferences(
    @Req() req: AuthenticatedRequest,
    @Param('sessionId') sessionId: string,
    @Body() dto: SavePreferencesDto,
  ) {
    return this.makeup.savePreferences(req.user.userId, sessionId, dto);
  }

  @Post('sessions/:sessionId/analyze')
  startAnalysis(
    @Req() req: AuthenticatedRequest,
    @Param('sessionId') sessionId: string,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.makeup.startAnalysis(
      req.user.userId,
      sessionId,
      key ?? `analysis:${sessionId}:${Date.now()}`,
    );
  }

  @Post('sessions/:sessionId/recommendations/:recommendationId/select')
  selectRecommendation(
    @Req() req: AuthenticatedRequest,
    @Param('sessionId') sessionId: string,
    @Param('recommendationId') recommendationId: string,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.makeup.selectRecommendation(
      req.user.userId,
      sessionId,
      recommendationId,
      key ?? `guide:${sessionId}:${recommendationId}:${Date.now()}`,
    );
  }

  @Post('recommendations/:recommendationId/saved')
  toggleSaved(
    @Req() req: AuthenticatedRequest,
    @Param('recommendationId') recommendationId: string,
    @Body() dto: SaveRecommendationDto,
  ) {
    return this.makeup.toggleSaved(
      req.user.userId,
      recommendationId,
      dto.saved,
    );
  }

  @Get('saved-recommendations')
  listSaved(@Req() req: AuthenticatedRequest) {
    return this.makeup.listSaved(req.user.userId);
  }

  @Post('guide-steps/:stepId/check')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['image'],
      properties: {
        image: { type: 'string', format: 'binary' },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      limits: { files: 1, fileSize: 10_000_000 },
    }),
  )
  checkStep(
    @Req() req: AuthenticatedRequest,
    @Param('stepId') stepId: string,
    @Headers('idempotency-key') key?: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.makeup.checkStep(
      req.user.userId,
      stepId,
      key ?? `check:${stepId}:${Date.now()}`,
      file,
    );
  }

  @Post('guide-steps/:stepId/snapshot')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['image'],
      properties: {
        image: { type: 'string', format: 'binary' },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      limits: { files: 1, fileSize: 10_000_000 },
    }),
  )
  saveStepSnapshot(
    @Req() req: AuthenticatedRequest,
    @Param('stepId') stepId: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.makeup.saveStepSnapshot(req.user.userId, stepId, file);
  }

  @Post('guide-steps/:stepId/questions')
  askQuestion(
    @Req() req: AuthenticatedRequest,
    @Param('stepId') stepId: string,
    @Body() dto: AskQuestionDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.makeup.askQuestion(
      req.user.userId,
      stepId,
      dto,
      key ?? `question:${stepId}:${Date.now()}`,
    );
  }

  @Post('guide-steps/:stepId/complete')
  completeStep(
    @Req() req: AuthenticatedRequest,
    @Param('stepId') stepId: string,
    @Body() dto: CompleteStepDto,
  ) {
    return this.makeup.completeStep(req.user.userId, stepId, dto);
  }

  @Get('jobs/:runId')
  @Throttle({ default: THROTTLER_CONFIG.RELAXED })
  getRun(@Req() req: AuthenticatedRequest, @Param('runId') runId: string) {
    return this.makeup.getRun(req.user.userId, runId);
  }

  @Get('profile/stats')
  getStats(@Req() req: AuthenticatedRequest) {
    return this.makeup.getStats(req.user.userId);
  }
}
