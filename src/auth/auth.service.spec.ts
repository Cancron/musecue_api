import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { AuthUtilsService } from './services/auth-utils.service';
import { PrismaService } from '../common/services/prisma.service';
import { ActivityLogService } from '../common/services/activity-log.service';
import { RedisService } from '../common/services/redis.service';
import { EmailQueueService } from '../common/queues/email/email.queue';
import { CustomLoggerService } from '../common/services/custom-logger.service';
import AppError from '../common/errors/app.error';
import * as bcrypt from 'bcryptjs';

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
    SESSION: {
      MAX_DEVICES_PER_USER: 5,
    },
    ROLE_HIERARCHY: {
      CUSTOMER: 1,
      MODERATOR: 2,
      ADMIN: 3,
      SUPER_ADMIN: 4,
    },
    CACHE_PREFIXES: {
      VERIFICATION_TOKEN: 'verification',
      PASSWORD_RESET_TOKEN: 'password_reset',
      REFRESH_TOKEN: 'refresh_token',
      USER_SESSIONS: 'user_sessions',
    },
  },
}));

describe('AuthService', () => {
  let service: AuthService;
  let prismaService: jest.Mocked<PrismaService>;
  let authUtilsService: jest.Mocked<AuthUtilsService>;
  let activityLogService: jest.Mocked<ActivityLogService>;
  let redisService: jest.Mocked<RedisService>;
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

    const mockRedisService = {
      set: jest.fn(),
      get: jest.fn(),
      del: jest.fn(),
    };

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
          provide: RedisService,
          useValue: mockRedisService,
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
    redisService = module.get(RedisService);
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

      mockTransaction.mockImplementation(async (callback) => {
        return callback({
          authUser: {
            create: jest.fn().mockResolvedValue(mockUser),
          },
          authSecurity: {
            create: jest.fn().mockResolvedValue({}),
          },
          emailHistory: {
            create: jest.fn().mockResolvedValue({}),
          },
        });
      });

      redisService.set.mockResolvedValue(undefined);
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
      expect(redisService.set).toHaveBeenCalled();
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

    it('should verify email successfully', async () => {
      const mockVerificationData = {
        code: '123456',
        userId: 'user-123',
        email,
        expiresAt: new Date(Date.now() + 10000).toISOString(),
      };

      const mockUser = {
        id: 'user-123',
        email,
        username: 'testuser',
        verified: false,
      };

      redisService.get.mockResolvedValue(mockVerificationData);
      prismaService.authUser.findUnique.mockResolvedValue(mockUser as any);

      mockTransaction.mockImplementation(async (callback) => {
        return callback({
          authUser: {
            update: jest
              .fn()
              .mockResolvedValue({ ...mockUser, verified: true }),
          },
        });
      });

      redisService.del.mockResolvedValue(1);
      emailQueueService.sendWelcomeEmail.mockResolvedValue(undefined);

      const result = await service.verifyEmail(email, code, meta);

      expect(result).toEqual({ message: 'Email verified successfully' });
      expect(redisService.get).toHaveBeenCalled();
      expect(prismaService.authUser.findUnique).toHaveBeenCalledWith({
        where: { email },
      });
      expect(mockTransaction).toHaveBeenCalled();
      expect(redisService.del).toHaveBeenCalled();
      expect(emailQueueService.sendWelcomeEmail).toHaveBeenCalledWith(
        email,
        mockUser.username,
        mockUser.id,
      );
    });

    it('should throw error if verification code is expired or not found', async () => {
      redisService.get.mockResolvedValue(null);

      await expect(service.verifyEmail(email, code, meta)).rejects.toThrow(
        'Verification code expired or invalid',
      );
    });

    it('should throw error if verification code is invalid', async () => {
      const mockVerificationData = {
        code: '654321', // Different code
        userId: 'user-123',
        email,
        expiresAt: new Date(Date.now() + 10000).toISOString(),
      };

      redisService.get.mockResolvedValue(mockVerificationData);

      await expect(service.verifyEmail(email, code, meta)).rejects.toThrow(
        'Invalid verification code',
      );
    });

    it('should throw error if user not found', async () => {
      const mockVerificationData = {
        code: '123456',
        userId: 'user-123',
        email,
        expiresAt: new Date(Date.now() + 10000).toISOString(),
      };

      redisService.get.mockResolvedValue(mockVerificationData);
      prismaService.authUser.findUnique.mockResolvedValue(null);

      await expect(service.verifyEmail(email, code, meta)).rejects.toThrow(
        'User not found',
      );
    });

    it('should throw error if email is already verified', async () => {
      const mockVerificationData = {
        code: '123456',
        userId: 'user-123',
        email,
        expiresAt: new Date(Date.now() + 10000).toISOString(),
      };

      const mockUser = {
        id: 'user-123',
        email,
        username: 'testuser',
        verified: true, // Already verified
      };

      redisService.get.mockResolvedValue(mockVerificationData);
      prismaService.authUser.findUnique.mockResolvedValue(mockUser as any);

      await expect(service.verifyEmail(email, code, meta)).rejects.toThrow(
        'Email already verified',
      );
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
      redisService.set.mockResolvedValue(undefined);
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
      expect(redisService.set).toHaveBeenCalled();
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
      redisService.set.mockResolvedValue(undefined);
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
