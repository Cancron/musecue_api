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
import AppError from '../common/errors/app.error';
import { AuthGuard } from '../common/guards/auth.guard';
import {
  ApplyReferralCodeDto,
  ListInviteesQueryDto,
  NoReferralQueryDto,
} from './dto/referral.dto';
import { REFERRAL_MESSAGES } from './referral-registration.service';
import { ReferralService } from './referral.service';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

/**
 * The signed-in user's own referral data. The user always comes from the
 * access token; no route accepts another user's id.
 */
@ApiTags('referrals')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Controller('v1/referrals')
export class ReferralController {
  constructor(private readonly referrals: ReferralService) {}

  /** The caller's code, referral counts and earned credits. */
  @Get()
  overview(
    @Req() req: AuthenticatedRequest,
    @Query() _query: NoReferralQueryDto,
  ) {
    return this.referrals.getOverview(req.user.userId);
  }

  /** The people the caller invited (pending, rewarded, qualified). */
  @Get('invitees')
  invitees(
    @Req() req: AuthenticatedRequest,
    @Query() query: ListInviteesQueryDto,
  ) {
    return this.referrals.listInvitees(req.user.userId, query.status);
  }

  /** The referral rewards the caller received. */
  @Get('rewards')
  rewards(
    @Req() req: AuthenticatedRequest,
    @Query() _query: NoReferralQueryDto,
  ) {
    return this.referrals.listRewards(req.user.userId);
  }

  /**
   * Referrals are registered at signup only: applying a code to an existing
   * account (a retrospective referral) is always refused.
   */
  @Post('apply')
  apply(@Body() _dto: ApplyReferralCodeDto): never {
    throw AppError.conflict(REFERRAL_MESSAGES.SIGNUP_ONLY);
  }
}
