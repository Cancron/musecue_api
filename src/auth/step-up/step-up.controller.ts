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
import {
  CompleteGoogleStepUpDto,
  StartGoogleStepUpDto,
  StepUpDto,
} from './step-up.dto';
import { StepUpService } from './step-up.service';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

/**
 * Step-up authentication of the signed-in user's own account, for one
 * sensitive action at a time. The approval is returned once and sent as the
 * X-Step-Up-Token header with the protected request.
 */
@ApiTags('auth')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Controller('v1/auth/step-up')
export class StepUpController {
  constructor(private readonly stepUp: StepUpService) {}

  /** How this account confirms sensitive actions: `mfa`, `password` or `google`. */
  @Get()
  @Header('Cache-Control', 'no-store')
  requirement(@Req() req: AuthenticatedRequest) {
    return this.stepUp.requirement(req.user);
  }

  /** Confirms with an MFA code / recovery code, or the current password. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  approve(@Body() dto: StepUpDto, @Req() req: AuthenticatedRequest) {
    return this.stepUp.approve(
      req.user,
      dto.action,
      {
        code: dto.code,
        recoveryCode: dto.recoveryCode,
        password: dto.password,
      },
      requestMetadata(req),
    );
  }

  /** Starts a Google re-authentication (accounts without password and MFA). */
  @Post('google')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  @Header('Cache-Control', 'no-store')
  startGoogle(
    @Body() dto: StartGoogleStepUpDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.stepUp.startGoogle(req.user, dto.action, dto.redirectUrl);
  }

  /**
   * Completes a Google re-authentication with the `code` and `state` Google
   * returned (forwarded to the app as step_up_code / step_up_state).
   */
  @Post('google/callback')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  completeGoogle(
    @Body() dto: CompleteGoogleStepUpDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.stepUp.completeGoogle(
      req.user,
      dto.code,
      dto.state,
      requestMetadata(req),
    );
  }
}
