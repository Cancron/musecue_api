import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthGuard } from '../common/guards/auth.guard';
import { MakeupCreditService } from './makeup-credit.service';

interface AuthenticatedRequest extends Request {
  user: { userId: string };
}

/** AI usage of the caller's own makeup sessions. */
@ApiTags('makeup')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Controller('v1')
export class MakeupUsageController {
  constructor(private readonly credits: MakeupCreditService) {}

  /**
   * Every AI provider request of the session (tokens, cost in USD, credits
   * charged) and exact totals. 404 for another user's session.
   */
  @Get('sessions/:sessionId/ai-usage')
  getSessionUsage(
    @Req() req: AuthenticatedRequest,
    @Param('sessionId') sessionId: string,
  ) {
    return this.credits.getSessionUsage(req.user.userId, sessionId);
  }
}
