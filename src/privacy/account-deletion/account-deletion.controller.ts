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
import { RequireStepUp } from '../../auth/step-up/step-up.decorator';

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
   * Emails the one-time code that confirms a deletion (required for every
   * account). Takes no body.
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
   * Confirms identity (password and emailed code; the code alone for
   * accounts without a password) and accepts the deletion: the account is
   * blocked and every token invalidated at once. Repeating the request
   * returns the same deletion. Needs a step-up approval (ACCOUNT_DELETION).
   */
  @Post()
  @RequireStepUp('ACCOUNT_DELETION')
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
