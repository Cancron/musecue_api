import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { mock } from 'jest-mock-extended';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { CustomThrottlerGuard } from './custom-throttler.guard';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';

@Controller('limited')
class LimitedController {
  @Get()
  get() {
    return { ok: true };
  }
}

class TestGuard extends CustomThrottlerGuard {
  skip(context: ExecutionContext) {
    return this.shouldSkip(context);
  }
}

describe('throttler exemptions', () => {
  it.each([
    '/auth/login?format=swagger',
    '/v1/sessions?format=-json',
    '/v1/swagger-look',
    '/docs-other',
    '/metrics-other',
  ])('does not exempt %s', async (url) => {
    const guard = new TestGuard([], mock<ThrottlerStorage>(), new Reflector());
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ url, path: url.split('?')[0] }),
      }),
    } as unknown as ExecutionContext;
    await expect(guard.skip(context)).resolves.toBe(false);
  });
  it.each([
    '/docs',
    '/docs-json',
    '/docs/swagger-ui.css',
    '/metrics',
    '/favicon.ico',
  ])('keeps infrastructure exemption %s', async (path) => {
    const guard = new TestGuard([], mock<ThrottlerStorage>(), new Reflector());
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ path }) }),
    } as unknown as ExecutionContext;
    await expect(guard.skip(context)).resolves.toBe(true);
  });
});

describe('throttler HTTP enforcement', () => {
  let app: INestApplication<App>;
  afterEach(async () => {
    await app?.close();
  });

  it('injects the inherited guard dependencies and rate-limits query-string bypass attempts', async () => {
    const module = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 1 }])],
      controllers: [LimitedController],
      providers: [{ provide: APP_GUARD, useClass: CustomThrottlerGuard }],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    await request(app.getHttpServer())
      .get('/limited?format=swagger')
      .expect(200);
    await request(app.getHttpServer()).get('/limited?format=-json').expect(429);
  });
});
