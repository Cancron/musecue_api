import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AuthUtilsService } from './services/auth-utils.service';
import { GoogleOAuthService } from './services/google-oauth.service';
import { PrismaService } from '../common/services/prisma.service';
import { ActivityLogService } from '../common/services/activity-log.service';
import { EmailService } from '../common/services/email.service';
import { RedisService } from '../common/services/redis.service';
import { QueueModule } from '../common/modules';
import { AuthGuard } from '../common/guards/auth.guard';

@Module({
  imports: [QueueModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthUtilsService,
    GoogleOAuthService,
    PrismaService,
    ActivityLogService,
    EmailService,
    RedisService,
    AuthGuard,
  ],
  exports: [AuthUtilsService, GoogleOAuthService],
})
export class AuthModule {}
