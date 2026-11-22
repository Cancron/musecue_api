import { Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { IAccessTokenPayload } from '../auth/interfaces/auth.interface';
import { AuthGuard } from '../common/guards/auth.guard';
import { DailyRewardClaimService } from './daily-reward-claim.service';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

/** The signed-in user's daily rewards. */
@ApiTags('daily-rewards')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Controller('v1/daily-rewards')
export class DailyRewardController {
  constructor(private readonly claims: DailyRewardClaimService) {}

  @Get()
  getStatus(@Req() req: AuthenticatedRequest) {
    return this.claims.getStatus(req.user.userId);
  }

  @Post('claim')
  claim(@Req() req: AuthenticatedRequest) {
    return this.claims.claim(req.user.userId);
  }
}
