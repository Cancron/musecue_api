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
import { requestMetadata } from '../subscription/request-metadata';
import { DailyRewardSettingsService } from './daily-reward-settings.service';
import { UpdateDailyRewardSettingsDto } from './dto/update-daily-reward-settings.dto';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

/** Administration of the daily reward configuration. */
@ApiTags('admin')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('v1/admin/daily-reward-settings')
export class DailyRewardSettingsController {
  constructor(
    private readonly dailyRewardSettings: DailyRewardSettingsService,
  ) {}

  @Get()
  getSettings() {
    return this.dailyRewardSettings.getSettings();
  }

  @Patch()
  updateSettings(
    @Req() req: AuthenticatedRequest,
    @Body() dto: UpdateDailyRewardSettingsDto,
  ) {
    return this.dailyRewardSettings.updateSettings(dto, {
      ...requestMetadata(req),
      actionedBy: req.user.userId,
    });
  }
}
