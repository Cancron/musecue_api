import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
import { CreditPackageSettingsService } from './credit-package-settings.service';
import { UpdateCreditPackageDto } from './dto/update-credit-package.dto';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

/** Administration of the purchasable credit packages. */
@ApiTags('admin')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN)
@Controller('v1/admin/credit-package-settings')
export class CreditPackageSettingsController {
  constructor(private readonly packages: CreditPackageSettingsService) {}

  @Get()
  listPackages() {
    return this.packages.listPackages();
  }

  @Get(':code')
  getPackage(@Param('code') code: string) {
    return this.packages.getPackage(code);
  }

  @Patch(':code')
  updatePackage(
    @Req() req: AuthenticatedRequest,
    @Param('code') code: string,
    @Body() dto: UpdateCreditPackageDto,
  ) {
    return this.packages.updatePackage(code, dto, {
      ...requestMetadata(req),
      actionedBy: req.user.userId,
    });
  }
}
