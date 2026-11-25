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
import { EmptyBodyPipe } from '../../privacy/dto/privacy-export.dto';
import { requestMetadata } from '../../subscription/request-metadata';
import type { IAccessTokenPayload } from '../interfaces/auth.interface';
import { ConfirmMfaEnrollmentDto } from './mfa.dto';
import { MfaService } from './mfa.service';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

/**
 * Optional authenticator-app MFA of the signed-in user. Every route acts on
 * the access token's own account; none accepts an account ID. Responses are
 * never cached (the enrollment response contains the secret).
 */
@ApiTags('auth')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Controller('v1/auth/mfa')
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

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

  /** Confirms the enrollment with the authenticator's current 6-digit code and enables MFA. */
  @Post('enrollment/confirm')
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
}
