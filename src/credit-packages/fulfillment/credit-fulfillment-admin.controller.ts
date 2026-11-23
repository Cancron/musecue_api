import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CreditFulfillmentStatus,
  CreditPackageOrderKind,
} from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, Max, Min, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import {
  type IAccessTokenPayload,
  UserRole,
} from '../../auth/interfaces/auth.interface';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { requestMetadata } from '../../subscription/request-metadata';
import { CreditFulfillmentService } from './credit-fulfillment.service';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

const isPresent = (_: object, value: unknown) => value !== undefined;

export class ListCreditFulfillmentsQueryDto {
  @ValidateIf(isPresent)
  @IsEnum(CreditFulfillmentStatus)
  status?: CreditFulfillmentStatus;

  @ValidateIf(isPresent)
  @IsEnum(CreditPackageOrderKind)
  kind?: CreditPackageOrderKind;

  @ValidateIf(isPresent)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/**
 * Fulfillment of paid credit package orders and gifts (ADMIN, SUPERADMIN):
 * failures, holds for review and their audit records; retry, approve or
 * reject.
 */
@ApiTags('admin')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('v1/admin/credit-fulfillments')
export class CreditFulfillmentAdminController {
  constructor(private readonly fulfillments: CreditFulfillmentService) {}

  @Get()
  list(@Query() query: ListCreditFulfillmentsQueryDto) {
    return this.fulfillments.list(query);
  }

  /** One fulfillment with its audit records (events). */
  @Get(':id')
  get(@Param('id') id: string) {
    return this.fulfillments.get(id);
  }

  @Post(':id/retry')
  @HttpCode(200)
  retry(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.fulfillments.retry(id, this.actor(req));
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.fulfillments.approve(id, this.actor(req));
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.fulfillments.reject(id, this.actor(req));
  }

  private actor(req: AuthenticatedRequest) {
    return { ...requestMetadata(req), actionedBy: req.user.userId };
  }
}
