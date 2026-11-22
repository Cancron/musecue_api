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
import type { IAccessTokenPayload } from '../auth/interfaces/auth.interface';
import { AuthGuard } from '../common/guards/auth.guard';
import {
  ListNotificationsQueryDto,
  UpdateNotificationDto,
  UpdateNotificationPreferencesDto,
} from './dto/notification.dto';
import { NotificationService } from './notification.service';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

/**
 * The signed-in user's notification inbox and email preferences. Every
 * route works on the caller's own notifications only (another user's
 * notification id answers 404).
 */
@ApiTags('notifications')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Controller('v1/notifications')
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  list(
    @Req() req: AuthenticatedRequest,
    @Query() query: ListNotificationsQueryDto,
  ) {
    return this.notifications.list(req.user.userId, query);
  }

  @Get('unread-count')
  async unreadCount(@Req() req: AuthenticatedRequest) {
    return {
      unreadCount: await this.notifications.unreadCount(req.user.userId),
    };
  }

  @Post('read-all')
  @HttpCode(200)
  readAll(@Req() req: AuthenticatedRequest) {
    return this.notifications.markAllRead(req.user.userId);
  }

  @Get('preferences')
  preferences(@Req() req: AuthenticatedRequest) {
    return this.notifications.getPreferences(req.user.userId);
  }

  @Patch('preferences')
  updatePreferences(
    @Req() req: AuthenticatedRequest,
    @Body() dto: UpdateNotificationPreferencesDto,
  ) {
    return this.notifications.updatePreferences(req.user.userId, dto);
  }

  @Patch(':id')
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateNotificationDto,
  ) {
    return this.notifications.setRead(req.user.userId, id, dto.read);
  }
}
