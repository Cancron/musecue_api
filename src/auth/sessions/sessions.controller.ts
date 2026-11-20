import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { THROTTLER_CONFIG } from '../../common/config/throttler.config';
import { AuthGuard } from '../../common/guards/auth.guard';
import { EmptyBodyPipe } from '../../privacy/dto/privacy-export.dto';
import { requestMetadata } from '../../subscription/request-metadata';
import type { IAccessTokenPayload } from '../interfaces/auth.interface';
import type { SecurityEventContext } from '../security-events/security-event.log';
import { SessionsService } from './sessions.service';

interface AuthenticatedRequest extends Request {
  user: IAccessTokenPayload;
}

const eventContext = (req: AuthenticatedRequest): SecurityEventContext => {
  const meta = requestMetadata(req);
  return { ip: meta.ip, userAgent: meta.userAgent, sessionId: req.user.sid };
};

/**
 * The signed-in user's own sign-in sessions. A session is identified by the
 * access tokens' `sid`; tokens are never returned.
 */
@ApiTags('auth')
@ApiBearerAuth('JWT-auth')
@UseGuards(AuthGuard)
@Controller('auth/sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  /** Active sessions, the current one marked `current`. */
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() req: AuthenticatedRequest) {
    return this.sessions.list(req.user);
  }

  /** Ends every session except this one. */
  @Post('revoke-others')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  revokeOthers(
    @Body(EmptyBodyPipe) _body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.sessions.revokeOthers(req.user, eventContext(req));
  }

  /** Ends every session, this one included. */
  @Post('revoke-all')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  revokeAll(
    @Body(EmptyBodyPipe) _body: unknown,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.sessions.revokeAll(req.user, eventContext(req));
  }

  /** Ends one of the user's sessions (404 for any other). */
  @Delete(':sessionId')
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  revokeOne(
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.sessions.revokeOne(req.user, sessionId, eventContext(req));
  }
}
