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
import { THROTTLER_CONFIG } from '../../../common/config/throttler.config';
import { AuthGuard } from '../../../common/guards/auth.guard';
import { EmptyBodyPipe } from '../../../privacy/dto/privacy-export.dto';
import { requestMetadata } from '../../../subscription/request-metadata';
import type { IAccessTokenPayload } from '../../interfaces/auth.interface';
import type { SecurityEventContext } from '../../security-events/security-event.log';
import { RequireStepUp } from '../../step-up/step-up.decorator';
import type { StepUpContext } from '../../step-up/step-up.guard';
import type { MfaChangeContext } from '../mfa.service';
import {
  SendSmsSignInCodeDto,
  SmsPhoneNumberDto,
  SmsVerificationCodeDto,
} from './mfa-sms.dto';
import { MfaSmsService } from './mfa-sms.service';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
  stepUp?: StepUpContext;
}

const changeContext = (req: AuthenticatedRequest): MfaChangeContext => ({
  metadata: requestMetadata(req),
  sessionId: req.user.sid,
  approvedWith: req.stepUp?.method,
});

const eventContext = (req: AuthenticatedRequest): SecurityEventContext => {
  const meta = requestMetadata(req);
  return { ip: meta.ip, userAgent: meta.userAgent, sessionId: req.user.sid };
};

/**
 * The signed-in user's phone number for SMS sign-in codes (users with
 * authenticator MFA only). Adding, replacing and removing it need a step-up
 * approval, which for these users is the authenticator or a recovery code
 * (never SMS); without one: 403 and nothing changes. The account is always
 * the token's user.
 */
@ApiTags('auth')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Controller('auth/mfa/sms')
export class MfaSmsController {
  constructor(private readonly sms: MfaSmsService) {}

  /** The masked verified number and any verification in progress. */
  @Get()
  @Header('Cache-Control', 'no-store')
  status(@Req() req: AuthenticatedRequest) {
    return this.sms.status(req.user.userId);
  }

  /** Sends a verification code to the number to add (202). */
  @Post('enrollment')
  @RequireStepUp('MFA_SMS_ENROLLMENT')
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  startEnrollment(
    @Body() dto: SmsPhoneNumberDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.sms.startPhoneVerification(
      req.user.userId,
      'enrollment',
      dto.phoneNumber,
      eventContext(req),
    );
  }

  /** Confirms the number with the code sent to it: SMS is enabled. */
  @Post('enrollment/confirm')
  @RequireStepUp('MFA_SMS_ENROLLMENT')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  confirmEnrollment(
    @Body() dto: SmsVerificationCodeDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.sms.confirmPhoneVerification(
      req.user.userId,
      'enrollment',
      dto.code,
      changeContext(req),
    );
  }

  /**
   * Sends a verification code to a new number (202); the current number
   * keeps working until the replacement is confirmed.
   */
  @Post('replacement')
  @RequireStepUp('MFA_SMS_REPLACE')
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  startReplacement(
    @Body() dto: SmsPhoneNumberDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.sms.startPhoneVerification(
      req.user.userId,
      'replacement',
      dto.phoneNumber,
      eventContext(req),
    );
  }

  /**
   * Confirms the new number: it replaces the previous one, and every SMS
   * code sent before stops working at once.
   */
  @Post('replacement/confirm')
  @RequireStepUp('MFA_SMS_REPLACE')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  confirmReplacement(
    @Body() dto: SmsVerificationCodeDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.sms.confirmPhoneVerification(
      req.user.userId,
      'replacement',
      dto.code,
      changeContext(req),
    );
  }

  /** Removes the number: SMS codes stop working at once. Takes no body. */
  @Post('disable')
  @RequireStepUp('MFA_SMS_DISABLE')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  disable(
    @Body(EmptyBodyPipe) _body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.sms.removePhone(req.user.userId, changeContext(req));
  }
}

/**
 * Sends the SMS code of a sign-in's MFA step (no access token exists yet:
 * the challenge token from POST /auth/login identifies the sign-in).
 */
@ApiTags('auth')
@Controller('auth/login/mfa')
export class MfaSmsSignInController {
  constructor(private readonly sms: MfaSmsService) {}

  /**
   * Sends a six-digit code to the verified number (202). Complete the
   * sign-in with POST /auth/login/mfa `{ challengeToken, smsCode }`.
   */
  @Post('sms')
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  send(@Body() dto: SendSmsSignInCodeDto, @Req() req: Request) {
    const meta = requestMetadata(req);
    return this.sms.sendSignInCode(dto.challengeToken, {
      ip: meta.ip ?? 'unknown',
      userAgent: meta.userAgent ?? 'unknown',
    });
  }
}
