import {
  Body,
  Controller,
  Delete,
  Get,
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
  UploadInitialImageDto,
} from './dto/makeup.dto';
import type { AuthenticatedUser } from './interfaces/makeup.interface';
import { MakeupService } from './makeup.service';

interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
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

  @Get('images/:imageId/content')
  @Throttle({ default: THROTTLER_CONFIG.RELAXED })
  async getImageContent(
    @Req() req: AuthenticatedRequest,
    @Param('imageId') imageId: string,
    @Res() response: Response,
  ) {
    const image = await this.makeup.getImageContent(req.user.userId, imageId);
    response.setHeader('Content-Type', image.mimeType);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.send(image.bytes);
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
  ) {
    return this.makeup.toggleSaved(req.user.userId, recommendationId);
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
