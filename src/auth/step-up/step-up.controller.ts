import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { THROTTLER_CONFIG } from '../../common/config/throttler.config';
import { AuthGuard } from '../../common/guards/auth.guard';
import { requestMetadata } from '../../subscription/request-metadata';
import type { IAccessTokenPayload } from '../interfaces/auth.interface';
import { STEP_UP_ACTIONS } from './step-up.constants';
import {
  ApproveStepUpDto,
  CompleteGoogleStepUpDto,
  StartGoogleStepUpDto,
} from './step-up.dto';
import { StepUpService } from './step-up.service';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

/**
 * Step-up authentication of the signed-in user: a fresh proof of identity
 * that approves one sensitive action in this session for ten minutes. The
 * approval token goes in the X-Step-Up-Token header of the protected
 * request.
 */
@ApiTags('auth')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Controller('auth/step-up')
export class StepUpController {
  constructor(private readonly stepUp: StepUpService) {}

  /** How this account re-verifies (`mfa`, `password` or `google`). */
  @Get()
  async requirement(@Req() req: AuthenticatedRequest) {
    return {
      method: await this.stepUp.requirementFor(req.user.userId),
      actions: STEP_UP_ACTIONS,
    };
  }

  /** Approves an action with an authenticator/recovery code or password. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  approve(@Body() dto: ApproveStepUpDto, @Req() req: AuthenticatedRequest) {
    return this.stepUp.approve(req.user, dto, requestMetadata(req));
  }

  /** Starts a Google reauthentication (Google-only accounts). */
  @Post('google')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  startGoogle(
    @Body() dto: StartGoogleStepUpDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.stepUp.startGoogle(req.user, dto.action);
  }

  /**
   * Completes it with Google's `code` and `state`, from the same session
   * that started it.
   */
  @Post('google/callback')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  completeGoogle(
    @Body() dto: CompleteGoogleStepUpDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.stepUp.completeGoogle(req.user, dto);
  }
}
