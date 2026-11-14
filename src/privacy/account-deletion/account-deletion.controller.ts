import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { IAccessTokenPayload } from '../../auth/interfaces/auth.interface';
import { THROTTLER_CONFIG } from '../../common/config/throttler.config';
import { AuthGuard } from '../../common/guards/auth.guard';
import { requestMetadata } from '../../subscription/request-metadata';
import { EmptyBodyPipe } from '../dto/privacy-export.dto';
import { RequestAccountDeletionDto } from './account-deletion.dto';
import { AccountDeletionService } from './account-deletion.service';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

/**
 * Permanent deletion of the signed-in user's own account. The account is
 * always the token's user; no request can name another account.
 */
@ApiTags('privacy')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Controller('v1/privacy/account-deletion')
export class AccountDeletionController {
  constructor(private readonly deletions: AccountDeletionService) {}

  /**
   * Emails a one-time code to confirm the deletion of an account without a
   * password (for example Google sign-in). Takes no body.
   */
  @Post('confirmation-code')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  requestConfirmationCode(
    @Body(EmptyBodyPipe) _body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.deletions.requestConfirmationCode(req.user.userId);
  }

  /**
   * Confirms identity (password, or the emailed code) and accepts the
   * deletion: the account is blocked at once and every session revoked.
   * Repeating the request returns the same deletion.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  requestDeletion(
    @Req() req: AuthenticatedRequest,
    @Body() dto: RequestAccountDeletionDto,
  ) {
    const meta = requestMetadata(req);
    return this.deletions.requestDeletion(req.user.userId, dto, {
      ip: meta.ip ?? 'unknown',
      userAgent: meta.userAgent ?? 'unknown',
      device: meta.device,
    });
  }
}
