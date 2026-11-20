import {
  Body,
  Controller,
  Delete,
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
import { THROTTLER_CONFIG } from '../../../common/config/throttler.config';
import { AuthGuard } from '../../../common/guards/auth.guard';
import { requestMetadata } from '../../../subscription/request-metadata';
import type { IAccessTokenPayload } from '../../interfaces/auth.interface';
import { RequireStepUp } from '../../step-up/step-up.decorator';
import type { StepUpContext } from '../../step-up/step-up.guard';
import { ConfirmSmsPhoneDto, StartSmsPhoneDto } from './mfa-sms.dto';
import { MfaSmsService, type SmsChangeContext } from './mfa-sms.service';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
  /** Set by StepUpGuard on routes that require a step-up. */
  stepUp?: StepUpContext;
}

const changeContext = (req: AuthenticatedRequest): SmsChangeContext => ({
  metadata: requestMetadata(req),
  sessionId: req.user.sid,
  approvedWith: req.stepUp?.method,
});

/**
 * The signed-in user's phone number for SMS sign-in codes (users with MFA
 * enabled with an authenticator app). Adding, replacing and removing a
 * number need a step-up approval; the account is always the token's user.
 */
@ApiTags('auth')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Controller('auth/mfa/sms')
export class MfaSmsController {
  constructor(private readonly sms: MfaSmsService) {}

  /** Whether SMS codes are set up; the number masked (last two digits). */
  @Get()
  @Header('Cache-Control', 'no-store')
  status(@Req() req: AuthenticatedRequest) {
    return this.sms.status(req.user.userId);
  }

  /**
   * Adds a number or starts replacing the verified one: a code is sent to
   * it by SMS (5 minutes). Needs a step-up approval (MFA_SMS_PHONE).
   */
  @Post('phone')
  @RequireStepUp('MFA_SMS_PHONE')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  startPhone(@Body() dto: StartSmsPhoneDto, @Req() req: AuthenticatedRequest) {
    return this.sms.startPhone(
      req.user.userId,
      dto.phoneNumber,
      changeContext(req),
    );
  }

  /**
   * Verifies the number with the code sent to it; it then receives sign-in
   * codes (a replaced number stops at once). Needs a step-up approval
   * (MFA_SMS_PHONE).
   */
  @Post('phone/confirm')
  @RequireStepUp('MFA_SMS_PHONE')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  confirmPhone(
    @Body() dto: ConfirmSmsPhoneDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.sms.confirmPhone(req.user.userId, dto.code, changeContext(req));
  }

  /**
   * Removes the number (and any number being verified); every code sent
   * to it stops working. Needs a step-up approval (MFA_SMS_PHONE_REMOVE).
   */
  @Delete('phone')
  @RequireStepUp('MFA_SMS_PHONE_REMOVE')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  removePhone(@Req() req: AuthenticatedRequest) {
    return this.sms.removePhone(req.user.userId, changeContext(req));
  }
}
