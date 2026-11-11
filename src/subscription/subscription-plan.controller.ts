import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  type IAccessTokenPayload,
  UserRole,
} from '../auth/interfaces/auth.interface';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { UpdateSubscriptionPlanDto } from './dto/update-subscription-plan.dto';
import { requestMetadata } from './request-metadata';
import { SubscriptionPlanService } from './subscription-plan.service';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

/** Administration of the single Pro subscription plan. */
@ApiTags('admin')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('v1/admin/subscription-plan')
export class SubscriptionPlanController {
  constructor(private readonly plans: SubscriptionPlanService) {}

  @Get()
  getPlan() {
    return this.plans.getProPlan();
  }

  @Patch()
  updatePlan(
    @Req() req: AuthenticatedRequest,
    @Body() dto: UpdateSubscriptionPlanDto,
  ) {
    return this.plans.updateProPlan(dto, {
      ...requestMetadata(req),
      actionedBy: req.user.userId,
    });
  }
}
