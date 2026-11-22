import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { IsString, Length } from 'class-validator';
import type { IAccessTokenPayload } from '../auth/interfaces/auth.interface';
import { AuthGuard } from '../common/guards/auth.guard';
import { ReferralService } from './referral.service';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

export class ApplyReferralCodeDto {
  @IsString()
  @Length(1, 32)
  code!: string;
}

/** The signed-in user's referral code and referral. */
@ApiTags('referrals')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Controller('v1/referrals')
export class ReferralController {
  constructor(private readonly referrals: ReferralService) {}

  @Get()
  get(@Req() req: AuthenticatedRequest) {
    return this.referrals.getReferral(req.user.userId);
  }

  @Post('apply')
  apply(@Req() req: AuthenticatedRequest, @Body() dto: ApplyReferralCodeDto) {
    return this.referrals.applyCode(req.user.userId, dto.code);
  }
}
