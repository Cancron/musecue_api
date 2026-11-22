import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { IAccessTokenPayload } from '../auth/interfaces/auth.interface';
import { AuthGuard } from '../common/guards/auth.guard';
import { DiscountRedemptionService } from './discount-redemption.service';
import {
  RedeemDiscountCampaignDto,
  RedeemDiscountCodeDto,
} from './dto/discount-offer.dto';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

/**
 * Discount codes and campaigns for the signed-in user. Redemptions require
 * an `Idempotency-Key` header; repeating a request with the same key returns
 * the original redemption and counts nothing.
 */
@ApiTags('discounts')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Controller('v1')
export class DiscountRedemptionController {
  constructor(private readonly redemptions: DiscountRedemptionService) {}

  @Post('discount-codes/redeem')
  redeemCode(
    @Req() req: AuthenticatedRequest,
    @Body() dto: RedeemDiscountCodeDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.redemptions.redeemCode(
      req.user.userId,
      dto.code,
      dto.packageCode,
      idempotencyKey,
    );
  }

  @Get('discount-campaigns')
  listCampaigns(@Req() req: AuthenticatedRequest) {
    return this.redemptions.listAvailableCampaigns(req.user.userId);
  }

  @Post('discount-campaigns/:id/redeem')
  redeemCampaign(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: RedeemDiscountCampaignDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.redemptions.redeemCampaign(
      req.user.userId,
      id,
      dto.packageCode,
      idempotencyKey,
    );
  }
}
