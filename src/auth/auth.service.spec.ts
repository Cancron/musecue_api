import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { AuthUtilsService } from './services/auth-utils.service';
import { PrismaService } from '../common/services/prisma.service';
import { ActivityLogService } from '../common/services/activity-log.service';
import { AuthChallengeRepository } from './state/auth-challenge.repository';
import { RefreshSessionRepository } from './state/refresh-session.repository';
import { TokenVersionCache } from '../infrastructure/token-version/token-version.cache';
import { EmailQueueService } from '../common/queues/email/email.queue';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import AppError from '../common/errors/app.error';
import * as bcrypt from 'bcryptjs';
import { mock, mockReset } from 'jest-mock-extended';

// Mock the AUTH_CONFIG to use numeric values for VERIFICATION
jest.mock('./config/auth.config', () => ({
  AUTH_CONFIG: {
    PASSWORD_MIN_LENGTH: 6,
    TOKEN_EXPIRY: {
      ACCESS: '15m',
      REFRESH: '7d',
      VERIFICATION: '1440', // 24 hours in minutes as a string number
      PASSWORD_RESET: '1h',
    },
    RATE_LIMIT: {
      LOGIN_MAX_ATTEMPTS: 5,
      LOGIN_WINDOW_MS: 15 * 60 * 1000,
      PASSWORD_RESET_MAX_ATTEMPTS: 3,
      PASSWORD_RESET_WINDOW_MS: 60 * 60 * 1000,
    },
    ACCOUNT_LOCKOUT: {
      MAX_FAILED_ATTEMPTS: 5,
      LOCKOUT_DURATION_MS: 30 * 60 * 1000,
    },
    VERIFICATION_CODE_MAX_ATTEMPTS: 5,
    SESSION: {
      MAX_DEVICES_PER_USER: 5,
    },
    ROLE_HIERARCHY: {
      USER: 1,
      MODERATOR: 2,
      ADMIN: 3,
      SUPERADMIN: 4,
    },
  },
}));

describe('AuthService', () => {
  let service: AuthService;
  let prismaService: jest.Mocked<PrismaService>;
  let authUtilsService: jest.Mocked<AuthUtilsService>;
  let activityLogService: jest.Mocked<ActivityLogService>;
  const challenges = mock<AuthChallengeRepository>();
  let emailQueueService: jest.Mocked<EmailQueueService>;

  const mockTransaction = jest.fn();

  beforeEach(async () => {
    const mockPrismaService = {
      authUser: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      authSecurity: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      emailHistory: {
        create: jest.fn(),
        updateMany: jest.fn(),
      },
      $transaction: mockTransaction,
    };

    const mockAuthUtilsService = {
      checkRateLimit: jest.fn(),
      validatePassword: jest.fn(),
      generateVerificationCode: jest.fn(),
      hashToken: jest.fn(),
      createAccessToken: jest.fn(),
      createRefreshToken: jest.fn(),
      generateSecureId: jest.fn(),
    };

    const mockActivityLogService = {
      logCreate: jest.fn(),
      logUpdate: jest.fn(),
      logCustomEvent: jest.fn(),
    };

    mockReset(challenges);

    const mockEmailQueueService = {
      sendVerificationEmail: jest.fn(),
      sendWelcomeEmail: jest.fn(),
    };

    const mockCustomLoggerService = {
      log: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
      verbose: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: AuthUtilsService,
          useValue: mockAuthUtilsService,
        },
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: ActivityLogService,
          useValue: mockActivityLogService,
        },
        {
          provide: AuthChallengeRepository,
          useValue: challenges,
        },
        {
          provide: RefreshSessionRepository,
          useValue: {},
        },
        {
          provide: TokenVersionCache,
          useValue: {},
        },
        {
          provide: EmailQueueService,
          useValue: mockEmailQueueService,
        },
        {
          provide: CustomLoggerService,
          useValue: mockCustomLoggerService,
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    prismaService = module.get(PrismaService);
    authUtilsService = module.get(AuthUtilsService);
    activityLogService = module.get(ActivityLogService);
    emailQueueService = module.get(EmailQueueService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    const createAuthDto = {
      email: 'test@example.com',
      username: 'testuser',
      password: 'Test@1234',
    };

    const meta = {
      ip: '127.0.0.1',
      userAgent: 'Jest Test Agent',
      device: 'test-device',
    };

    it('should create a new user successfully', async () => {
      // Mock dependencies
      authUtilsService.checkRateLimit.mockResolvedValue(undefined);
      authUtilsService.validatePassword.mockReturnValue(true);
      authUtilsService.generateVerificationCode.mockReturnValue('123456');
      prismaService.authUser.findFirst.mockResolvedValue(null);

      const mockUser = {
        id: 'user-123',
        email: createAuthDto.email,
        username: createAuthDto.username,
      };

      const tx = {
        authUser: {
          create: jest.fn().mockResolvedValue(mockUser),
        },
        authSecurity: {
          create: jest.fn().mockResolvedValue({}),
        },
        emailHistory: {
          create: jest.fn().mockResolvedValue({}),
        },
      };
      mockTransaction.mockImplementation(async (callback) => callback(tx));

      challenges.issue.mockResolvedValue(undefined);
      emailQueueService.sendVerificationEmail.mockResolvedValue(undefined);

      // Execute
      await service.create(createAuthDto, meta);

      // Assertions
      expect(authUtilsService.checkRateLimit).toHaveBeenCalledTimes(2);
      expect(authUtilsService.validatePassword).toHaveBeenCalledWith(
        createAuthDto.password,
      );
      expect(prismaService.authUser.findFirst).toHaveBeenCalledWith({
        where: {
          OR: [
            { email: createAuthDto.email },
            { username: createAuthDto.username },
          ],
        },
      });
      expect(mockTransaction).toHaveBeenCalled();
      // The code is stored (hashed by the repository) with the new account,
      // in the same transaction.
      expect(challenges.issue.mock.calls).toEqual([
        [
          mockUser.id,
          'EMAIL_VERIFICATION',
          '123456',
          { expiresAt: expect.any(Date) as unknown, maxAttempts: 5 },
          tx,
        ],
      ]);
      expect(emailQueueService.sendVerificationEmail).toHaveBeenCalledWith(
        createAuthDto.email,
        createAuthDto.username,
        '123456',
        mockUser.id,
      );
    });

    it('should throw error if password is weak', async () => {
      authUtilsService.checkRateLimit.mockResolvedValue(undefined);
      authUtilsService.validatePassword.mockReturnValue(false);

      await expect(service.create(createAuthDto, meta)).rejects.toThrow(
        'Password must be at least 6 characters',
      );

      expect(authUtilsService.validatePassword).toHaveBeenCalledWith(
        createAuthDto.password,
      );
    });

    it('should throw error if email already exists', async () => {
      authUtilsService.checkRateLimit.mockResolvedValue(undefined);
      authUtilsService.validatePassword.mockReturnValue(true);
      prismaService.authUser.findFirst.mockResolvedValue({
        id: 'existing-user',
        email: createAuthDto.email,
        username: 'different-username',
      } as any);

      await expect(service.create(createAuthDto, meta)).rejects.toThrow(
        'Email already exists!',
      );
    });

    it('should throw error if username already exists', async () => {
      authUtilsService.checkRateLimit.mockResolvedValue(undefined);
      authUtilsService.validatePassword.mockReturnValue(true);
      prismaService.authUser.findFirst.mockResolvedValue({
        id: 'existing-user',
        email: 'different@example.com',
        username: createAuthDto.username,
      } as any);

      await expect(service.create(createAuthDto, meta)).rejects.toThrow(
        'Username already exists!',
      );
    });

    it('should handle rate limiting', async () => {
      authUtilsService.checkRateLimit.mockRejectedValue(
        AppError.tooManyRequests('Too many attempts'),
      );

      await expect(service.create(createAuthDto, meta)).rejects.toThrow();
      expect(authUtilsService.checkRateLimit).toHaveBeenCalled();
    });
  });

  describe('verifyEmail', () => {
    const email = 'test@example.com';
    const code = '123456';
    const meta = {
      ip: '127.0.0.1',
      userAgent: 'Jest Test Agent',
    };
    const mockUser = {
      id: 'user-123',
      email,
      username: 'testuser',
      verified: false,
    };

    /** Runs the repository's onValid callback, as a matching code would. */
    function validCode(tx: { authUser: { updateMany: jest.Mock } }) {
      challenges.verify.mockImplementation(
        async (_id, _purpose, _code, opts) => {
          await opts?.onValid?.(tx as never);
          return 'VALID';
        },
      );
    }

    it('should verify email successfully', async () => {
      prismaService.authUser.findUnique.mockResolvedValue(mockUser as any);
      const tx = {
        authUser: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };
      validCode(tx);
      emailQueueService.sendWelcomeEmail.mockResolvedValue(undefined);

      const result = await service.verifyEmail(email, code, meta);

      expect(result).toEqual({ message: 'Email verified successfully' });
      expect(prismaService.authUser.findUnique).toHaveBeenCalledWith({
        where: { email },
      });
      // The code is checked (and consumed) for this account only, and the
      // account is marked verified in the same transaction.
      expect(challenges.verify.mock.calls[0]?.slice(0, 3)).toEqual([
        mockUser.id,
        'EMAIL_VERIFICATION',
        code,
      ]);
      expect(typeof challenges.verify.mock.calls[0]?.[3]?.onValid).toBe(
        'function',
      );
      expect(tx.authUser.updateMany).toHaveBeenCalledWith({
        where: { id: mockUser.id, verified: false },
        data: { verified: true },
      });
      expect(emailQueueService.sendWelcomeEmail).toHaveBeenCalledWith(
        email,
        mockUser.username,
        mockUser.id,
      );
    });

    it('should throw error if verification code is expired or not found', async () => {
      prismaService.authUser.findUnique.mockResolvedValue(mockUser as any);
      challenges.verify.mockResolvedValue('EXPIRED');

      await expect(service.verifyEmail(email, code, meta)).rejects.toThrow(
        'Verification code expired or invalid',
      );
    });

    it('should throw error if verification code is invalid', async () => {
      prismaService.authUser.findUnique.mockResolvedValue(mockUser as any);
      challenges.verify.mockResolvedValue('INVALID');

      await expect(service.verifyEmail(email, code, meta)).rejects.toThrow(
        'Invalid verification code',
      );
      expect(emailQueueService.sendWelcomeEmail.mock.calls).toHaveLength(0);
    });

    it('treats an unknown email like an expired code', async () => {
      prismaService.authUser.findUnique.mockResolvedValue(null);

      await expect(service.verifyEmail(email, code, meta)).rejects.toThrow(
        'Verification code expired or invalid',
      );
      expect(challenges.verify.mock.calls).toHaveLength(0);
    });

    it('should throw error if email is already verified', async () => {
      prismaService.authUser.findUnique.mockResolvedValue({
        ...mockUser,
        verified: true,
      } as any);
      validCode({
        authUser: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      });

      await expect(service.verifyEmail(email, code, meta)).rejects.toThrow(
        'Email already verified',
      );
      expect(emailQueueService.sendWelcomeEmail.mock.calls).toHaveLength(0);
    });
  });

  describe('resendVerificationEmail', () => {
    const email = 'test@example.com';
    const meta = {
      ip: '127.0.0.1',
      userAgent: 'Jest Test Agent',
    };

    it('should resend verification email successfully', async () => {
      const mockUser = {
        id: 'user-123',
        email,
        username: 'testuser',
        verified: false,
      };

      authUtilsService.checkRateLimit.mockResolvedValue(undefined);
      prismaService.authUser.findUnique.mockResolvedValue(mockUser as any);
      authUtilsService.generateVerificationCode.mockReturnValue('654321');
      challenges.issue.mockResolvedValue(undefined);
      prismaService.emailHistory.create.mockResolvedValue({} as any);
      emailQueueService.sendVerificationEmail.mockResolvedValue(undefined);

      const result = await service.resendVerificationEmail(email, meta);

      expect(result).toEqual({
        message: 'Verification email sent successfully',
      });
      expect(authUtilsService.checkRateLimit).toHaveBeenCalled();
      expect(prismaService.authUser.findUnique).toHaveBeenCalledWith({
        where: { email },
      });
      // The new code replaces the previous one (fresh expiry and attempts).
      expect(challenges.issue.mock.calls).toEqual([
        [
          mockUser.id,
          'EMAIL_VERIFICATION',
          '654321',
          { expiresAt: expect.any(Date) as unknown, maxAttempts: 5 },
        ],
      ]);
      expect(emailQueueService.sendVerificationEmail).toHaveBeenCalled();
    });

    it('should throw error if user not found', async () => {
      authUtilsService.checkRateLimit.mockResolvedValue(undefined);
      prismaService.authUser.findUnique.mockResolvedValue(null);

      await expect(
        service.resendVerificationEmail(email, meta),
      ).rejects.toThrow('User not found');
    });

    it('should throw error if email is already verified', async () => {
      const mockUser = {
        id: 'user-123',
        email,
        username: 'testuser',
        verified: true, // Already verified
      };

      authUtilsService.checkRateLimit.mockResolvedValue(undefined);
      prismaService.authUser.findUnique.mockResolvedValue(mockUser as any);

      await expect(
        service.resendVerificationEmail(email, meta),
      ).rejects.toThrow('Email already verified');
    });

    it('should handle rate limiting', async () => {
      authUtilsService.checkRateLimit.mockRejectedValue(
        AppError.tooManyRequests('Too many attempts'),
      );

      await expect(
        service.resendVerificationEmail(email, meta),
      ).rejects.toThrow();
    });

    it('should throw error if email queue fails', async () => {
      const mockUser = {
        id: 'user-123',
        email,
        username: 'testuser',
        verified: false,
      };

      authUtilsService.checkRateLimit.mockResolvedValue(undefined);
      prismaService.authUser.findUnique.mockResolvedValue(mockUser as any);
      authUtilsService.generateVerificationCode.mockReturnValue('654321');
      challenges.issue.mockResolvedValue(undefined);
      prismaService.emailHistory.create.mockResolvedValue({} as any);
      prismaService.emailHistory.updateMany.mockResolvedValue({
        count: 1,
      } as any);
      emailQueueService.sendVerificationEmail.mockRejectedValue(
        new Error('Queue error'),
      );

      await expect(
        service.resendVerificationEmail(email, meta),
      ).rejects.toThrow('Failed to send verification email');
      expect(prismaService.emailHistory.updateMany).toHaveBeenCalled();
    });
  });
});
