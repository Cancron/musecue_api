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
 * Optional MFA (authenticator app) of the signed-in user's own account. The
 * account is always the token's user: no route accepts a user ID, and
 * request bodies cannot name one.
 */
@ApiTags('auth')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Controller('auth/mfa')
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

  /** Whether MFA is enabled, and the state of an enrollment in progress. */
  @Get()
  @Header('Cache-Control', 'no-store')
  getStatus(@Req() req: AuthenticatedRequest) {
    return this.mfa.getStatus(req.user.userId);
  }

  /**
   * Starts (or restarts) an enrollment: returns a new authenticator secret
   * and its otpauth:// URI, confirmable for 10 minutes. Takes no body. The
   * secret is shown only in this response.
   */
  @Post('enrollment')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  startEnrollment(
    @Body(EmptyBodyPipe) _body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.mfa.startEnrollment(req.user.userId);
  }

  /**
   * Confirms the enrollment with the app's current six-digit code and
   * enables MFA.
   */
  @Post('enrollment/confirm')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
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
