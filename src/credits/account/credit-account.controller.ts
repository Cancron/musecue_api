import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { IAccessTokenPayload } from '../../auth/interfaces/auth.interface';
import { THROTTLER_CONFIG } from '../../common/config/throttler.config';
import AppError from '../../common/errors/app.error';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CreditAccountService } from './credit-account.service';
import { ListCreditTransactionsDto } from './dto/list-credit-transactions.dto';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

/**
 * The caller's own credits. A bearer token is required (401 otherwise);
 * the user is always the token's user, never a request parameter, so no
 * route can show another user's credits. Open to every signed-in user,
 * with or without credits, Pro or a trial.
 */
@ApiTags('credits')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Throttle({ default: THROTTLER_CONFIG.RELAXED })
@Controller('v1/credits')
export class CreditAccountController {
  constructor(private readonly credits: CreditAccountService) {}

  /** Balance by source: available, used, expired and upcoming credits, expiry dates. */
  @Get('balance')
  getBalance(
    @Req() req: AuthenticatedRequest,
    @Query() query: Record<string, unknown>,
  ) {
    // Always the caller's balance: parameters (e.g. a user ID) are refused.
    if (Object.keys(query).length > 0) {
      throw AppError.badRequest('This endpoint takes no query parameters');
    }
    return this.credits.getBalance(req.user.userId);
  }

  /** Allocations, deductions (with session overage) and expirations, newest first. */
  @Get('transactions')
  listTransactions(
    @Req() req: AuthenticatedRequest,
    @Query() query: ListCreditTransactionsDto,
  ) {
    return this.credits.listTransactions(req.user.userId, query);
  }
}
