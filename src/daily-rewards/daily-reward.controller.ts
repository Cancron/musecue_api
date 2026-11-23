import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { IAccessTokenPayload } from '../auth/interfaces/auth.interface';
import { AuthGuard } from '../common/guards/auth.guard';
import { DailyRewardClaimService } from './daily-reward-claim.service';
import {
  ClaimDailyRewardDto,
  DailyRewardHistoryQueryDto,
  DailyRewardMonthsQueryDto,
} from './dto/daily-reward-claim.dto';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

/** The signed-in user's daily rewards (always the caller's own). */
@ApiTags('daily-rewards')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Controller('v1/daily-rewards')
export class DailyRewardController {
  constructor(private readonly claims: DailyRewardClaimService) {}

  /** Streak, next claim, this month's credits and cap, credit balance. */
  @Get()
  getStatus(@Req() req: AuthenticatedRequest) {
    return this.claims.getStatus(req.user.userId);
  }

  /** Claims today's (UTC) reward. */
  @Post('claim')
  claim(@Req() req: AuthenticatedRequest, @Body() dto: ClaimDailyRewardDto) {
    return this.claims.claim(req.user.userId, dto?.claimDate);
  }

  /** Claim history, newest first. */
  @Get('history')
  history(
    @Req() req: AuthenticatedRequest,
    @Query() query: DailyRewardHistoryQueryDto,
  ) {
    return this.claims.history(req.user.userId, query);
  }

  /** Daily reward credits earned per UTC month and what is left of the cap. */
  @Get('months')
  months(
    @Req() req: AuthenticatedRequest,
    @Query() query: DailyRewardMonthsQueryDto,
  ) {
    return this.claims.months(req.user.userId, query);
  }
}
