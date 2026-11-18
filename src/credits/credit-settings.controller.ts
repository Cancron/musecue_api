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
import { CreditSettingsService } from './credit-settings.service';
import { UpdateCreditSettingsDto } from './dto/update-credit-settings.dto';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

/** Administration of the AI credit configuration. */
@ApiTags('admin')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('v1/admin/credit-settings')
export class CreditSettingsController {
  constructor(private readonly creditSettings: CreditSettingsService) {}

  @Get()
  getSettings() {
    return this.creditSettings.getSettings();
  }

  @Patch()
  updateSettings(
    @Req() req: AuthenticatedRequest,
    @Body() dto: UpdateCreditSettingsDto,
  ) {
    return this.creditSettings.updateSettings(dto, {
      ...requestMetadata(req),
      actionedBy: req.user.userId,
    });
  }
}
