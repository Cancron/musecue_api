import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  type IAccessTokenPayload,
  UserRole,
} from '../auth/interfaces/auth.interface';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { requestMetadata } from '../subscription/request-metadata';
import {
  CreateReferralMilestoneDto,
  ListReferralReviewsQueryDto,
  UpdateReferralMilestoneDto,
} from './dto/referral-admin.dto';
import { ReferralMilestoneService } from './referral-milestone.service';
import { ReferralReviewService } from './referral-review.service';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

const actorOf = (req: AuthenticatedRequest) => ({
  ...requestMetadata(req),
  actionedBy: req.user.userId,
});

/** Administration of referral milestones. */
@ApiTags('admin')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('v1/admin/referral-milestones')
export class ReferralMilestoneAdminController {
  constructor(private readonly milestones: ReferralMilestoneService) {}

  @Post()
  create(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateReferralMilestoneDto,
  ) {
    return this.milestones.create(dto, actorOf(req));
  }

  @Get()
  list() {
    return this.milestones.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.milestones.get(id);
  }

  @Patch(':id')
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateReferralMilestoneDto,
  ) {
    return this.milestones.update(id, dto, actorOf(req));
  }
}

/** Review of suspicious referrals whose rewards are on hold. */
@ApiTags('admin')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('v1/admin/referrals')
export class ReferralReviewAdminController {
  constructor(private readonly reviews: ReferralReviewService) {}

  @Get()
  list(@Query() query: ListReferralReviewsQueryDto) {
    return this.reviews.list(query.status);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.reviews.approve(id, actorOf(req));
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.reviews.reject(id, actorOf(req));
  }
}
