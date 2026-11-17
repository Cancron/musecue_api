import { Test, TestingModule } from '@nestjs/testing';
import { AuthUtilsService } from './auth-utils.service';
import { RateLimitStore } from '../../infrastructure/rate-limit/rate-limit.store';

describe('AuthUtilsService', () => {
  let service: AuthUtilsService;

  const mockRateLimits = {
    hit: jest.fn(),
    reset: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthUtilsService,
        {
          provide: RateLimitStore,
          useValue: mockRateLimits,
        },
      ],
    }).compile();

    service = module.get<AuthUtilsService>(AuthUtilsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('validatePassword', () => {
    it('should return false for password shorter than minimum length', () => {
      expect(service.validatePassword('12345')).toBe(false);
    });

    it('should accept a simple six-character password', () => {
      expect(service.validatePassword('123456')).toBe(true);
    });
  });

  describe('checkRateLimit', () => {
    beforeEach(() => jest.resetAllMocks());

    it('counts the hit on the selected store with the window as block duration', async () => {
      mockRateLimits.hit.mockResolvedValue({
        totalHits: 1,
        windowExpiresInMs: 900_000,
        blocked: false,
        blockExpiresInMs: 0,
      });

      await expect(
        service.checkRateLimit('login:email:a@example.com', 5, 900_000),
      ).resolves.toBe(true);
      expect(mockRateLimits.hit).toHaveBeenCalledWith(
        'login:email:a@example.com',
        { limit: 5, windowMs: 900_000, blockMs: 900_000 },
      );
    });

    it('refuses a blocked key with 429 and the existing message', async () => {
      mockRateLimits.hit.mockResolvedValue({
        totalHits: 6,
        windowExpiresInMs: 900_000,
        blocked: true,
        blockExpiresInMs: 900_000,
      });

      await expect(
        service.checkRateLimit('login:ip:203.0.113.1', 5, 900_000),
      ).rejects.toMatchObject({
        status: 429,
        message: 'Rate limit exceeded. Please try again after 900 seconds.',
      });
    });

    it('skips the check when the store is unavailable (account lockout still applies)', async () => {
      mockRateLimits.hit.mockRejectedValue(new Error('offline'));

      await expect(
        service.checkRateLimit('login:ip:203.0.113.1', 5, 900_000),
      ).resolves.toBe(true);
    });

    it('resets a limit through the store', async () => {
      await service.resetRateLimit('login:email:a@example.com');
      expect(mockRateLimits.reset).toHaveBeenCalledWith(
        'login:email:a@example.com',
      );
    });
  });
});
