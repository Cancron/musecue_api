import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Query,
  Res,
  Logger,
  UseGuards,
  Header,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { GoogleOAuthService } from './services/google-oauth.service';
import { CreateAuthDto } from './dto/create-auth.dto';
// import { UpdateAuthDto } from './dto/update-auth.dto';
import {
  GoogleOAuthInitDto,
  GoogleOAuthCallbackDto,
} from './dto/google-oauth.dto';
import type { Request, Response } from 'express';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import { THROTTLER_CONFIG } from '../common/config/throttler.config';
import { AuthGuard } from '../common/guards/auth.guard';
import { LoginDto } from './dto/login.dto';
import { requestMetadata } from '../subscription/request-metadata';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import {
  ResendVerificationEmailDto,
  VerifyEmailDto,
} from './dto/verify-email.dto';
import { CompleteMfaChallengeDto, factorOf } from './mfa/mfa.dto';
import { trustedDeviceTokenOf } from './mfa/trusted-device-header';

interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
    role: string;
    tokenVersion: number;
  };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly googleOAuthService: GoogleOAuthService,
    private readonly customLogger: CustomLoggerService,
  ) {}

  // Strict rate limit for registration: 5 requests per 15 minutes
  @Throttle({ default: THROTTLER_CONFIG.AUTH })
  @Post()
  create(@Body() payload: CreateAuthDto, @Req() req: Request) {
    this.customLogger.log(
      `Registration attempt for email: ${payload.email}`,
      'AuthController',
    );
    const meta = {
      ip: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      device:
        (Array.isArray(req.headers['x-device'])
          ? req.headers['x-device'][0]
          : req.headers['x-device']) ||
        (Array.isArray(req.headers['x-device-id'])
          ? req.headers['x-device-id'][0]
          : req.headers['x-device-id']) ||
        (Array.isArray(req.headers['sec-ch-ua-platform'])
          ? req.headers['sec-ch-ua-platform'][0]
          : req.headers['sec-ch-ua-platform']),
    };
    return this.authService.create(payload, meta);
  }

  // Strict rate limit for verification: 5 requests per 15 minutes
  @Throttle({ default: THROTTLER_CONFIG.AUTH })
  @Post('verify-email')
  verifyEmail(@Body() payload: VerifyEmailDto, @Req() req: Request) {
    this.customLogger.log(
      `Email verification attempt for: ${payload.email}`,
      'AuthController',
    );
    const meta = {
      ip: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
    };
    return this.authService.verifyEmail(payload.email, payload.code, meta);
  }

  // Strict rate limit: 5 requests per 15 minutes
  @Throttle({ default: THROTTLER_CONFIG.AUTH })
  @Post('resend-verification-email')
  resendVerificationEmail(
    @Body() payload: ResendVerificationEmailDto,
    @Req() req: Request,
  ) {
    const meta = {
      ip: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
    };
    return this.authService.resendVerificationEmail(payload.email, meta);
  }

  // ==========================================
  // Google OAuth Endpoints
  // ==========================================

  /**
   * Initiate Google OAuth flow
   * Returns the Google authorization URL for the client to redirect to
   *
   * @example GET /auth/google
   * @example GET /auth/google?redirectUrl=http://localhost:3000/dashboard
   */
  @Get('google')
  async googleOAuthInit(
    @Query() query: GoogleOAuthInitDto,
    @Req() req: Request,
  ) {
    this.customLogger.log(
      'Google OAuth initialization requested',
      'AuthController',
    );

    const meta = {
      ip: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
    };

    const { url, state } = await this.googleOAuthService.getAuthorizationUrl(
      meta,
      query.redirectUrl,
      trustedDeviceTokenOf(req),
    );

    return {
      url,
      state,
      message: 'Redirect to the provided URL to authenticate with Google',
    };
  }

  /**
   * Google OAuth callback handler
   * This endpoint is called by Google after user authentication
   *
   * For browser-based flows, this redirects to the frontend
   * For API-based flows, returns JSON with tokens
   */
  @Get('google/callback')
  async googleOAuthCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Query('error_description') errorDescription: string,
    @Req() req: Request,

    @Res({ passthrough: true }) res: Response,
  ) {
    // Handle OAuth errors
    if (error) {
      this.customLogger.warn(
        `Google OAuth error: ${error} - ${errorDescription}`,
        'AuthController',
      );
      Logger.warn(
        `Google OAuth error: ${error} - ${errorDescription}`,
        'AuthController',
      );

      // For browser redirect, you might want to redirect to an error page
      return {
        success: false,
        error,
        errorDescription,
        message: 'Google authentication failed',
      };
    }

    if (!code || !state) {
      return {
        success: false,
        error: 'missing_parameters',
        message: 'Missing authorization code or state parameter',
      };
    }

    this.customLogger.log('Google OAuth callback received', 'AuthController');
    Logger.log('Google OAuth callback received', 'AuthController');

    const meta = {
      ip: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      device:
        (Array.isArray(req.headers['x-device'])
          ? req.headers['x-device'][0]
          : req.headers['x-device']) ||
        (Array.isArray(req.headers['x-device-id'])
          ? req.headers['x-device-id'][0]
          : req.headers['x-device-id']) ||
        (Array.isArray(req.headers['sec-ch-ua-platform'])
          ? req.headers['sec-ch-ua-platform'][0]
          : req.headers['sec-ch-ua-platform']),
    };

    const result = await this.googleOAuthService.handleCallback(
      code,
      state,
      meta,
    );

    // MFA-enabled account: only the challenge, never tokens.
    if ('mfaRequired' in result) {
      if (result.redirectUrl) {
        const redirectUrl = new URL(result.redirectUrl);
        redirectUrl.searchParams.set('mfa_required', 'true');
        redirectUrl.searchParams.set(
          'mfa_challenge_token',
          result.challengeToken,
        );
        redirectUrl.searchParams.set(
          'mfa_challenge_expires_at',
          result.challengeExpiresAt.toISOString(),
        );
        return res.redirect(redirectUrl.toString());
      }
      return {
        success: true,
        message: 'MFA verification required',
        data: result,
      };
    }

    // If redirectUrl is provided, redirect to it with tokens as query params
    if (result.redirectUrl) {
      const redirectUrl = new URL(result.redirectUrl);
      redirectUrl.searchParams.set('access_token', result.accessToken);
      redirectUrl.searchParams.set('refresh_token', result.refreshToken);
      redirectUrl.searchParams.set('user_id', result.user.id);
      redirectUrl.searchParams.set('email', result.user.email);
      redirectUrl.searchParams.set('is_new_user', result.isNewUser.toString());

      return res.redirect(redirectUrl.toString());
    }

    // Otherwise return JSON response
    return {
      success: true,
      message: result.isNewUser
        ? 'Account created successfully via Google'
        : 'Signed in successfully via Google',
      data: result,
    };
  }

  /**
   * Alternative POST endpoint for Google OAuth callback
   * Useful for mobile apps or SPAs that handle the callback differently
   */
  @Post('google/callback')
  async googleOAuthCallbackPost(
    @Body() body: GoogleOAuthCallbackDto,
    @Req() req: Request,
  ) {
    this.customLogger.log(
      'Google OAuth callback (POST) received',
      'AuthController',
    );

    const meta = {
      ip: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      device:
        (Array.isArray(req.headers['x-device'])
          ? req.headers['x-device'][0]
          : req.headers['x-device']) ||
        (Array.isArray(req.headers['x-device-id'])
          ? req.headers['x-device-id'][0]
          : req.headers['x-device-id']) ||
        (Array.isArray(req.headers['sec-ch-ua-platform'])
          ? req.headers['sec-ch-ua-platform'][0]
          : req.headers['sec-ch-ua-platform']),
    };

    const result = await this.googleOAuthService.handleCallback(
      body.code,
      body.state,
      meta,
      trustedDeviceTokenOf(req),
    );

    return {
      success: true,
      message:
        'mfaRequired' in result
          ? 'MFA verification required'
          : result.isNewUser
            ? 'Account created successfully via Google'
            : 'Signed in successfully via Google',
      data: result,
    };
  }

  // ==========================================
  // Login/Logout Endpoints
  // ==========================================

  /**
   * Login with email and password
   */
  // Strict rate limit for login: 5 requests per 15 minutes per IP
  @Throttle({ default: THROTTLER_CONFIG.AUTH })
  @Post('login')
  async login(@Body() payload: LoginDto, @Req() req: Request) {
    this.customLogger.log(
      `Login attempt for email: ${payload.email}`,
      'AuthController',
    );

    const meta = {
      ip: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      device:
        (Array.isArray(req.headers['x-device'])
          ? req.headers['x-device'][0]
          : req.headers['x-device']) ||
        (Array.isArray(req.headers['x-device-id'])
          ? req.headers['x-device-id'][0]
          : req.headers['x-device-id']) ||
        (Array.isArray(req.headers['sec-ch-ua-platform'])
          ? req.headers['sec-ch-ua-platform'][0]
          : req.headers['sec-ch-ua-platform']),
    };

    // A trusted device of an MFA-enabled account skips the MFA challenge.
    return this.authService.login(payload, meta, trustedDeviceTokenOf(req));
  }

  /**
   * Second step of a sign-in (password or Google) of an MFA-enabled account:
   * the challenge token with the authenticator's current code or an unused
   * recovery code. Returns the regular tokens (and, with `trustDevice`, a
   * trusted-device token shown once). The challenge token itself never
   * grants access.
   */
  @Throttle({ default: THROTTLER_CONFIG.STRICT })
  @Post('mfa/challenge')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Header('Pragma', 'no-cache')
  async completeMfaChallenge(
    @Body() payload: CompleteMfaChallengeDto,
    @Req() req: Request,
  ) {
    return this.authService.completeMfaLogin(
      {
        challengeToken: payload.challengeToken,
        factor: factorOf(payload),
        trustDevice: payload.trustDevice,
        deviceName: payload.deviceName,
      },
      {
        ip: req.ip || 'unknown',
        userAgent: req.headers['user-agent'] || 'unknown',
        device: requestMetadata(req).device,
      },
    );
  }

  /**
   * Refresh access token using refresh token
   */
  @Post('refresh-token')
  async refreshToken(@Body() payload: RefreshTokenDto, @Req() req: Request) {
    this.customLogger.log('Token refresh requested', 'AuthController');

    const meta = {
      ip: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      device:
        (Array.isArray(req.headers['x-device'])
          ? req.headers['x-device'][0]
          : req.headers['x-device']) ||
        (Array.isArray(req.headers['x-device-id'])
          ? req.headers['x-device-id'][0]
          : req.headers['x-device-id']) ||
        (Array.isArray(req.headers['sec-ch-ua-platform'])
          ? req.headers['sec-ch-ua-platform'][0]
          : req.headers['sec-ch-ua-platform']),
    };

    return this.authService.refreshToken(payload.refreshToken, meta);
  }

  /**
   * Logout current session
   */
  @Post('logout')
  @UseGuards(AuthGuard)
  async logout(
    @Body() payload: RefreshTokenDto,
    @Req() req: AuthenticatedRequest,
  ) {
    this.customLogger.log('Logout requested', 'AuthController');

    return this.authService.logout(payload.refreshToken, req.user.userId);
  }

  /**
   * Logout from all devices
   */
  @Post('logout-all')
  @UseGuards(AuthGuard)
  async logoutAll(@Req() req: AuthenticatedRequest) {
    this.customLogger.log(
      `Logout all devices requested for user: ${req.user.userId}`,
      'AuthController',
    );

    return this.authService.logoutAllDevices(req.user.userId);
  }
}
