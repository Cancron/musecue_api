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
import { CreditGiftService } from './credit-gift.service';
import {
  CreateCreditGiftDto,
  ListCreditGiftsQueryDto,
  PayCreditGiftDto,
} from './dto/credit-gift.dto';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

/**
 * Credit package gifts (signed-in users; only gifts the caller sent or
 * received, 404 otherwise).
 */
@ApiTags('credit-packages')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Controller('v1/credit-package-gifts')
export class CreditGiftController {
  constructor(private readonly gifts: CreditGiftService) {}

  /** Sends a gift invitation (Idempotency-Key header required). */
  @Post()
  send(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateCreditGiftDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.gifts.send(req.user.userId, dto, idempotencyKey);
  }

  /** `?box=sent` (default) or `?box=received`. */
  @Get()
  list(
    @Req() req: AuthenticatedRequest,
    @Query() query: ListCreditGiftsQueryDto,
  ) {
    return this.gifts.list(req.user.userId, query);
  }

  @Get(':id')
  get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.gifts.get(req.user.userId, id);
  }

  @Post(':id/accept')
  @HttpCode(200)
  accept(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.gifts.accept(req.user.userId, id);
  }

  @Post(':id/decline')
  @HttpCode(200)
  decline(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.gifts.decline(req.user.userId, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.gifts.cancel(req.user.userId, id);
  }

  /** The sender pays an accepted gift (Idempotency-Key header required). */
  @Post(':id/checkout')
  checkout(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: PayCreditGiftDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.gifts.pay(
      req.user.userId,
      id,
      { discountCode: dto?.discountCode ?? null },
      idempotencyKey,
    );
  }
}
