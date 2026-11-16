import {
  Controller,
  Delete,
  Get,
  Header,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { memoryStorage } from 'multer';
import type { IAccessTokenPayload } from '../auth/interfaces/auth.interface';
import { AuthGuard } from '../common/guards/auth.guard';
import { ProfileService } from './profile.service';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

@ApiTags('profile')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Controller('v1/profile')
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get()
  getProfile(@Req() req: AuthenticatedRequest) {
    return this.profile.getProfile(req.user.userId);
  }

  @Post('avatar')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['image'],
      properties: { image: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      limits: { files: 1, fileSize: 5_000_000 },
    }),
  )
  updateAvatar(
    @Req() req: AuthenticatedRequest,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.profile.updateAvatar(req.user.userId, file);
  }

  @Delete('avatar')
  deleteAvatar(@Req() req: AuthenticatedRequest) {
    return this.profile.deleteAvatar(req.user.userId);
  }

  /**
   * Short-lived (60 s) direct download URL for the caller's own uploaded
   * avatar. A new URL is issued on every call; nothing is stored, and caching
   * is disabled. External avatars (e.g. Google) answer 409: use `avatarUrl`.
   */
  @Get('avatar/signed-url')
  @Header('Cache-Control', 'private, no-store')
  getAvatarSignedUrl(@Req() req: AuthenticatedRequest) {
    return this.profile.getAvatarSignedUrl(req.user.userId);
  }

  @Get('avatar/content')
  async getAvatarContent(
    @Req() req: AuthenticatedRequest,
    @Res() response: Response,
  ) {
    const avatar = await this.profile.getAvatarContent(req.user.userId);
    response.setHeader('Content-Type', avatar.mimeType);
    response.setHeader('Cache-Control', 'private, no-cache');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.send(avatar.bytes);
  }
}
