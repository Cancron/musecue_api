import {
  Body,
  Controller,
  Get,
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
} from '../../auth/interfaces/auth.interface';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { requestMetadata } from '../../subscription/request-metadata';
import {
  CreateLoyaltyMissionDto,
  LoyaltyMissionAwardsQueryDto,
  UpdateLoyaltyMissionDto,
} from './dto/loyalty-mission.dto';
import { LoyaltyMissionService } from './loyalty-mission.service';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

/** Administration of loyalty missions. */
@ApiTags('admin')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('v1/admin/loyalty-missions')
export class LoyaltyMissionAdminController {
  constructor(private readonly missions: LoyaltyMissionService) {}

  @Post()
  create(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateLoyaltyMissionDto,
  ) {
    return this.missions.create(dto, {
      ...requestMetadata(req),
      actionedBy: req.user.userId,
    });
  }

  @Get()
  list() {
    return this.missions.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.missions.get(id);
  }

  @Patch(':id')
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateLoyaltyMissionDto,
  ) {
    return this.missions.update(id, dto, {
      ...requestMetadata(req),
      actionedBy: req.user.userId,
    });
  }
}

/** The signed-in user's loyalty missions and rewards (own data only). */
@ApiTags('daily-rewards')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Controller('v1/loyalty-missions')
export class LoyaltyMissionController {
  constructor(private readonly missions: LoyaltyMissionService) {}

  @Get()
  overview(@Req() req: AuthenticatedRequest) {
    return this.missions.overview(req.user.userId);
  }

  @Get('awards')
  awards(
    @Req() req: AuthenticatedRequest,
    @Query() query: LoyaltyMissionAwardsQueryDto,
  ) {
    return this.missions.awards(req.user.userId, query);
  }
}
