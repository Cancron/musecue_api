import { Test, TestingModule } from '@nestjs/testing';
import { GoogleOAuthService } from './google-oauth.service';
import { CustomLoggerService } from '../../common/services/custom-logger.service';
import { PrismaService } from '../../common/services/prisma.service';
import { ActivityLogService } from '../../common/services/activity-log.service';
import { AuthUtilsService } from './auth-utils.service';
import { OAuthStateRepository } from '../state/oauth-state.repository';
import { RefreshSessionRepository } from '../state/refresh-session.repository';
import { ReferralRegistrationService } from '../../referrals/referral-registration.service';

describe('GoogleOAuthService', () => {
  let service: GoogleOAuthService;

  const mockCustomLoggerService = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  const mockOAuthStates = {
    create: jest.fn(),
    consume: jest.fn(),
  };

  const mockSessions = {
    createForLogin: jest.fn(),
  };

  const mockPrismaService = {
    authUser: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    authSecurity: {
      create: jest.fn(),
    },
    userProfile: {
      create: jest.fn(),
    },
    loginHistory: {
      create: jest.fn(),
    },
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
    $transaction: jest.fn((fn) => fn(mockPrismaService)),
  };

  const mockActivityLogService = {
    logCreate: jest.fn(),
    logCustomEvent: jest.fn(),
  };

  const mockAuthUtilsService = {
    generateSecureId: jest.fn().mockReturnValue('test-jti-id'),
    createAccessToken: jest.fn().mockReturnValue('test-access-token'),
    createRefreshToken: jest.fn().mockReturnValue('test-refresh-token'),
    hashToken: jest.fn().mockReturnValue('hashed-token'),
  };

  beforeEach(async () => {
    // Set environment variables for tests
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    process.env.GOOGLE_REDIRECT_URI =
      'http://localhost:5000/auth/google/callback';

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoogleOAuthService,
        {
          provide: CustomLoggerService,
          useValue: mockCustomLoggerService,
        },
        {
          provide: OAuthStateRepository,
          useValue: mockOAuthStates,
        },
        {
          provide: RefreshSessionRepository,
          useValue: mockSessions,
        },
        {
          provide: PrismaService,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          useValue: mockPrismaService,
        },
        {
          provide: ActivityLogService,
          useValue: mockActivityLogService,
        },
        {
          provide: AuthUtilsService,
          useValue: mockAuthUtilsService,
        },
        {
          provide: ReferralRegistrationService,
          useValue: { findReferrer: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<GoogleOAuthService>(GoogleOAuthService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getAuthorizationUrl', () => {
    it('should generate a valid authorization URL with state', async () => {
      mockOAuthStates.create.mockResolvedValue(undefined);

      const meta = { ip: '127.0.0.1', userAgent: 'test-agent' };
      const result = await service.getAuthorizationUrl(meta);

      expect(result).toHaveProperty('url');
      expect(result).toHaveProperty('state');
      expect(result.url).toContain(
        'https://accounts.google.com/o/oauth2/v2/auth',
      );
      expect(result.url).toContain('client_id=test-client-id');
      expect(result.url).toContain('redirect_uri=');
      expect(result.url).toContain('response_type=code');
      expect(result.url).toContain('scope=');
      expect(result.url).toContain('code_challenge=');
      expect(result.url).toContain('code_challenge_method=S256');
      // The state is stored for the Google provider with a 10 minute expiry.
      expect(mockOAuthStates.create).toHaveBeenCalledWith(
        'google',
        result.state,
        expect.objectContaining({
          state: result.state,
          codeVerifier: expect.any(String) as unknown,
        }),
        600,
      );
    });

    it('should include optional redirectUrl if provided', async () => {
      mockOAuthStates.create.mockResolvedValue(undefined);

      const meta = { ip: '127.0.0.1', userAgent: 'test-agent' };
      const redirectUrl = 'http://localhost:3000/dashboard';
      const result = await service.getAuthorizationUrl(meta, redirectUrl);

      expect(result).toHaveProperty('url');
      expect(result).toHaveProperty('state');
      // The redirectUrl is stored with the (encrypted) state data
      expect(mockOAuthStates.create).toHaveBeenCalledWith(
        'google',
        result.state,
        expect.objectContaining({ redirectUrl }),
        expect.any(Number),
      );
    });
  });

  describe('handleCallback', () => {
    it('should throw error for invalid or expired state', async () => {
      mockOAuthStates.consume.mockResolvedValue(null);

      const meta = { ip: '127.0.0.1', userAgent: 'test-agent' };

      await expect(
        service.handleCallback('test-code', 'invalid-state', meta),
      ).rejects.toThrow('Invalid or expired OAuth state');
      expect(mockOAuthStates.consume).toHaveBeenCalledWith(
        'google',
        'invalid-state',
      );
    });

    it('should throw error for state mismatch', async () => {
      mockOAuthStates.consume.mockResolvedValue({
        state: 'different-state',
        codeVerifier: 'test-verifier',
        ip: '127.0.0.1',
        userAgent: 'test-agent',
        createdAt: new Date().toISOString(),
      });

      const meta = { ip: '127.0.0.1', userAgent: 'test-agent' };

      await expect(
        service.handleCallback('test-code', 'test-state', meta),
      ).rejects.toThrow('Invalid OAuth state');
    });
  });
});
