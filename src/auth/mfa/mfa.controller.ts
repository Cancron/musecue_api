import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { THROTTLER_CONFIG } from '../../common/config/throttler.config';
import { AuthGuard } from '../../common/guards/auth.guard';
import { EmptyBodyPipe } from '../../privacy/dto/privacy-export.dto';
import { requestMetadata } from '../../subscription/request-metadata';
import type { IAccessTokenPayload } from '../interfaces/auth.interface';
import { MfaLoginService } from './mfa-login.service';
import { MfaVerificationService } from './mfa-verification.service';
import { MFA_LOGIN } from './mfa.constants';
import { RequireStepUp } from '../step-up/step-up.decorator';
import {
  ConfirmMfaEnrollmentDto,
  MfaVerificationDto,
  toMfaFactor,
} from './mfa.dto';
import { MfaService, type MfaChangeContext } from './mfa.service';
import type { StepUpContext } from '../step-up/step-up.guard';
import type { SecurityEventContext } from '../security-events/security-event.log';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
  /** Set by StepUpGuard on routes that require a step-up. */
  stepUp?: StepUpContext;
}

/** Request metadata and how the change was approved (never a secret). */
const changeContext = (req: AuthenticatedRequest): MfaChangeContext => ({
  metadata: requestMetadata(req),
  sessionId: req.user.sid,
  approvedWith: req.stepUp?.method,
});

/** Where a security event happened: request and sign-in session. */
const eventContext = (req: AuthenticatedRequest): SecurityEventContext => {
  const meta = requestMetadata(req);
  return { ip: meta.ip, userAgent: meta.userAgent, sessionId: req.user.sid };
};

/**
 * Optional MFA (authenticator app) of the signed-in user's own account. The
 * account is always the token's user: no route accepts a user ID, and
 * request bodies cannot name one.
 */
@ApiTags('auth')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Controller('auth/mfa')
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly verification: MfaVerificationService,
    private readonly login: MfaLoginService,
  ) {}

  /** Whether MFA is enabled, and the state of an enrollment in progress. */
  @Get()
  @Header('Cache-Control', 'no-store')
  getStatus(@Req() req: AuthenticatedRequest) {
    return this.mfa.getStatus(req.user.userId);
  }

  /**
   * Starts (or restarts) an enrollment: returns a new authenticator secret
   * and its otpauth:// URI, confirmable for 10 minutes. Takes no body. The
   * secret is shown only in this response. Needs a step-up approval
   * (MFA_ENROLLMENT).
   */
  @Post('enrollment')
  @RequireStepUp('MFA_ENROLLMENT')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  startEnrollment(
    @Body(EmptyBodyPipe) _body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.mfa.startEnrollment(
      req.user.userId,
      undefined,
      eventContext(req),
    );
  }

  /**
   * Confirms the enrollment with the app's current six-digit code and
   * enables MFA. Needs a step-up approval (MFA_ENROLLMENT, the same as for
   * starting it). The response carries the ten recovery codes: the only time
   * they are ever shown.
   */
  @Post('enrollment/confirm')
  @RequireStepUp('MFA_ENROLLMENT')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  confirmEnrollment(
    @Body() dto: ConfirmMfaEnrollmentDto,
    @Req() req: AuthenticatedRequest,
  ) {
    // This session stays signed in; every other one is ended.
    return this.mfa.confirmEnrollment(
      req.user.userId,
      dto.code,
      requestMetadata(req),
      undefined,
      req.user.sid,
    );
  }

  /**
   * Verifies a second factor: the app's current code or a single-use
   * recovery code (`{ "code": "123456" }` or `{ "recoveryCode": "ABCDE-FGHJK" }`).
   */
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  verify(@Body() dto: MfaVerificationDto, @Req() req: AuthenticatedRequest) {
    // A success also counts as this session's MFA proof (administrators).
    return this.verification.verify(
      req.user.userId,
      toMfaFactor(dto),
      requestMetadata(req),
      undefined,
      req.user.sid,
    );
  }

  /**
   * Replaces all recovery codes with ten new ones. Needs a step-up approval
   * (MFA_RECOVERY_CODES), which is the second-factor proof; takes no body.
   * The new codes are shown only in this response; every previous code
   * stops working.
   */
  @Post('recovery-codes')
  @RequireStepUp('MFA_RECOVERY_CODES')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  regenerateRecoveryCodes(
    @Body(EmptyBodyPipe) _body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.verification.regenerateRecoveryCodes(
      req.user.userId,
      changeContext(req),
    );
  }

  /**
   * Turns MFA off: the authenticator secret and every recovery code stop
   * working, trusted devices are revoked, and a security notification is
   * sent. Needs a step-up approval (MFA_DISABLE); takes no body.
   */
  @Post('disable')
  @RequireStepUp('MFA_DISABLE')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  disable(
    @Body(EmptyBodyPipe) _body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.mfa.disable(req.user.userId, changeContext(req));
  }

  /**
   * Starts replacing the authenticator app: returns a new secret (shown only
   * here) to add to the new app, confirmable for 10 minutes. The current app
   * keeps working until the replacement is confirmed. Needs a step-up
   * approval (MFA_AUTHENTICATOR_REPLACE); takes no body.
   */
  @Post('authenticator/replacement')
  @RequireStepUp('MFA_AUTHENTICATOR_REPLACE')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  startReplacement(
    @Body(EmptyBodyPipe) _body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.mfa.startReplacement(
      req.user.userId,
      undefined,
      eventContext(req),
    );
  }

  /**
   * Confirms the replacement with the new app's current code: the previous
   * app's codes stop working, trusted devices are revoked, and a security
   * notification is sent. Needs a step-up approval
   * (MFA_AUTHENTICATOR_REPLACE).
   */
  @Post('authenticator/replacement/confirm')
  @RequireStepUp('MFA_AUTHENTICATOR_REPLACE')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  confirmReplacement(
    @Body() dto: ConfirmMfaEnrollmentDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.mfa.confirmReplacement(
      req.user.userId,
      dto.code,
      changeContext(req),
    );
  }

  /**
   * The devices trusted to skip MFA at sign-in (never their tokens). The
   * device sending the request (its X-MFA-Trusted-Device header) is marked
   * `current`.
   */
  @Get('trusted-devices')
  @Header('Cache-Control', 'no-store')
  listTrustedDevices(@Req() req: AuthenticatedRequest) {
    const header = req.headers[MFA_LOGIN.TRUSTED_DEVICE_HEADER];
    return this.login.listTrustedDevices(
      req.user.userId,
      typeof header === 'string' ? header : null,
    );
  }

  /** Revokes one of the user's trusted devices (404 for any other). */
  @Delete('trusted-devices/:deviceId')
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  revokeTrustedDevice(
    @Param('deviceId', new ParseUUIDPipe()) deviceId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.login.revokeTrustedDevice(
      req.user.userId,
      deviceId,
      undefined,
      eventContext(req),
    );
  }
}
