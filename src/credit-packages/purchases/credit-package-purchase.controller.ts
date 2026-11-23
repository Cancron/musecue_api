import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { IAccessTokenPayload } from '../../auth/interfaces/auth.interface';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CreditPackageCheckoutService } from './credit-package-checkout.service';
import {
  CreateCreditPackageOrderDto,
  ListCreditPackageOrdersQueryDto,
} from './dto/credit-package-order.dto';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

/**
 * Buying credit packages (signed-in users; always the caller's own orders,
 * another user's order answers 404). Credits are granted only by the
 * verified Stripe webhook.
 */
@ApiTags('credit-packages')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Controller('v1')
export class CreditPackagePurchaseController {
  constructor(private readonly purchases: CreditPackageCheckoutService) {}

  /** The packages for sale. */
  @Get('credit-packages')
  listPackages() {
    return this.purchases.listAvailable();
  }

  /** Starts a purchase; requires an Idempotency-Key header. */
  @Post('credit-packages/:code/checkout')
  checkout(
    @Req() req: AuthenticatedRequest,
    @Param('code') code: string,
    @Body() dto: CreateCreditPackageOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.purchases.createOrder(
      req.user.userId,
      code,
      { discountCode: dto?.discountCode ?? null },
      idempotencyKey,
    );
  }

  @Get('credit-package-orders')
  listOrders(
    @Req() req: AuthenticatedRequest,
    @Query() query: ListCreditPackageOrdersQueryDto,
  ) {
    return this.purchases.listOrders(req.user.userId, query);
  }

  @Get('credit-package-orders/:id')
  getOrder(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.purchases.getOrder(req.user.userId, id);
  }

  @Post('credit-package-orders/:id/cancel')
  @HttpCode(200)
  cancel(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.purchases.cancelOrder(req.user.userId, id);
  }
}
