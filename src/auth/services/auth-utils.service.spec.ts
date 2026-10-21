import { Test, TestingModule } from '@nestjs/testing';
import { AuthUtilsService } from './auth-utils.service';
import { RedisService } from '../../common/services/redis.service';

describe('AuthUtilsService', () => {
  let service: AuthUtilsService;

  const mockRedisService = {
    set: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthUtilsService,
        {
          provide: RedisService,
          useValue: mockRedisService,
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
});
