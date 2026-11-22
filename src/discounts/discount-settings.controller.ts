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
import { DiscountSettingsService } from './discount-settings.service';
import { UpdateDiscountSettingsDto } from './dto/update-discount-settings.dto';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

/** Administration of the discount and referral configuration. */
@ApiTags('admin')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('v1/admin/discount-settings')
export class DiscountSettingsController {
  constructor(private readonly discountSettings: DiscountSettingsService) {}

  @Get()
  getSettings() {
    return this.discountSettings.getSettings();
  }

  @Patch()
  updateSettings(
    @Req() req: AuthenticatedRequest,
    @Body() dto: UpdateDiscountSettingsDto,
  ) {
    return this.discountSettings.updateSettings(dto, {
      ...requestMetadata(req),
      actionedBy: req.user.userId,
    });
  }
}
