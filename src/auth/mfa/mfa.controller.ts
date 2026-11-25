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
import { ConfirmMfaEnrollmentDto, factorOf, VerifyMfaDto } from './mfa.dto';
import { RequireStepUp } from '../step-up/step-up.decorator';
import { MfaService } from './mfa.service';
import { trustedDeviceTokenOf } from './trusted-device-header';
import { MfaLoginService } from './mfa-login.service';
import { MfaVerificationService } from './mfa-verification.service';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

/**
 * Optional authenticator-app MFA of the signed-in user. Every route acts on
 * the access token's own account; none accepts an account ID. Responses are
 * never cached (the enrollment response contains the secret, confirmation
 * and regeneration responses the recovery codes).
 */
@ApiTags('auth')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Controller('v1/auth/mfa')
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly verification: MfaVerificationService,
    private readonly mfaLogin: MfaLoginService,
  ) {}

  /** Whether MFA is enabled, and the progress of an enrollment. */
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  getStatus(@Req() req: AuthenticatedRequest) {
    return this.mfa.getStatus(req.user.userId);
  }

  /**
   * Starts an enrollment: returns a new authenticator secret and its
   * otpauth:// URI, to confirm within 10 minutes. Takes no body.
   */
  @Post('enrollment')
  @RequireStepUp('MFA_SETTINGS')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  startEnrollment(
    @Body(EmptyBodyPipe) _body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.mfa.startEnrollment(req.user.userId);
  }

  /**
   * Confirms the enrollment with the authenticator's current 6-digit code,
   * enables MFA and returns the 10 recovery codes (this one time only).
   */
  @Post('enrollment/confirm')
  @RequireStepUp('MFA_SETTINGS')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  confirmEnrollment(
    @Body() dto: ConfirmMfaEnrollmentDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.mfa.confirmEnrollment(
      req.user.userId,
      dto.code,
      requestMetadata(req),
    );
  }

  /**
   * Verifies the second factor: the authenticator's current code or an
   * unused recovery code (consumed). Each code works once.
   */
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  verify(@Body() dto: VerifyMfaDto, @Req() req: AuthenticatedRequest) {
    return this.verification.verify(
      req.user.userId,
      factorOf(dto),
      requestMetadata(req),
    );
  }

  /**
   * Replaces the recovery codes with 10 new ones (returned this one time
   * only); all earlier codes stop working. Needs a step-up approval (an
   * authenticator or recovery code) and takes no body.
   */
  @Post('recovery-codes')
  @RequireStepUp('MFA_RECOVERY_CODES')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  regenerateRecoveryCodes(
    @Body(EmptyBodyPipe) _body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.verification.regenerateRecoveryCodes(
      req.user.userId,
      requestMetadata(req),
    );
  }

  /**
   * The signed-in user's trusted devices (active, expired and revoked),
   * never their tokens. `current` marks the device whose token this request
   * sends in the X-Trusted-Device-Token header.
   */
  @Get('trusted-devices')
  @Header('Cache-Control', 'no-store')
  listTrustedDevices(@Req() req: AuthenticatedRequest) {
    return this.mfaLogin.listTrustedDevices(
      req.user.userId,
      trustedDeviceTokenOf(req),
    );
  }

  /**
   * Revokes one of the signed-in user's trusted devices: its next sign-in
   * needs MFA again. Another user's device answers 404.
   */
  @Delete('trusted-devices/:deviceId')
  @RequireStepUp('MFA_SETTINGS')
  @Header('Cache-Control', 'no-store')
  revokeTrustedDevice(
    @Param('deviceId', new ParseUUIDPipe()) deviceId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.mfaLogin.revokeTrustedDevice(req.user.userId, deviceId);
  }
}
