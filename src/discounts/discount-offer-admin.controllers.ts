import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { DiscountOfferKind } from '@prisma/client';
import type { Request } from 'express';
import {
  type IAccessTokenPayload,
  UserRole,
} from '../auth/interfaces/auth.interface';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { requestMetadata } from '../subscription/request-metadata';
import { DiscountOfferAdminService } from './discount-offer-admin.service';
import {
  CreateDiscountCampaignDto,
  CreateDiscountCodeDto,
  UpdateDiscountCampaignDto,
  UpdateDiscountCodeDto,
} from './dto/discount-offer.dto';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

const actorOf = (req: AuthenticatedRequest) => ({
  ...requestMetadata(req),
  actionedBy: req.user.userId,
});

/** Administration of discount codes. */
@ApiTags('admin')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('v1/admin/discount-codes')
export class DiscountCodesAdminController {
  constructor(private readonly offers: DiscountOfferAdminService) {}

  @Post()
  create(@Req() req: AuthenticatedRequest, @Body() dto: CreateDiscountCodeDto) {
    return this.offers.create(DiscountOfferKind.CODE, dto, actorOf(req));
  }

  @Get()
  list() {
    return this.offers.list(DiscountOfferKind.CODE);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.offers.get(DiscountOfferKind.CODE, id);
  }

  @Patch(':id')
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateDiscountCodeDto,
  ) {
    return this.offers.update(DiscountOfferKind.CODE, id, dto, actorOf(req));
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  deactivate(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.offers.deactivate(DiscountOfferKind.CODE, id, actorOf(req));
  }
}

/** Administration of promotional campaigns (e.g. holiday sales). */
@ApiTags('admin')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('v1/admin/discount-campaigns')
export class DiscountCampaignsAdminController {
  constructor(private readonly offers: DiscountOfferAdminService) {}

  @Post()
  create(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateDiscountCampaignDto,
  ) {
    return this.offers.create(DiscountOfferKind.CAMPAIGN, dto, actorOf(req));
  }

  @Get()
  list() {
    return this.offers.list(DiscountOfferKind.CAMPAIGN);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.offers.get(DiscountOfferKind.CAMPAIGN, id);
  }

  @Patch(':id')
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateDiscountCampaignDto,
  ) {
    return this.offers.update(
      DiscountOfferKind.CAMPAIGN,
      id,
      dto,
      actorOf(req),
    );
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  deactivate(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.offers.deactivate(DiscountOfferKind.CAMPAIGN, id, actorOf(req));
  }
}
