import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { PrismaService } from '../../common/services/prisma.service';
import { SecurityActivityQueryDto } from './security-activity.controller';
import { SecurityEventLog } from './security-event.log';

const AT = new Date('2026-11-27T12:00:00.000Z');

/**
 * The security activity history (MFA changes, failed MFA verifications,
 * trusted devices, sessions): recording, paging and the query; PostgreSQL
 * and the route are covered by test/mfa-audit.e2e-spec.ts.
 */
describe('Security activity history (MFA and sessions)', () => {
  const row = (id: string) => ({
    id,
    type: 'MFA_VERIFICATION_FAILED',
    createdAt: AT,
    ipAddress: '203.0.113.7',
    userAgent: 'jest',
    sessionId: id === 'e2' ? 'current' : 'other',
    details: { context: 'verification', method: 'totp' },
  });
  const prisma = {
    securityEvent: {
      count: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
  };
  const log = new SecurityEventLog(prisma as unknown as PrismaService);

  beforeEach(() => jest.resetAllMocks());

  it('records an event with where it happened', async () => {
    await log.record(prisma as unknown as PrismaService, {
      authId: 'alice',
      type: 'SESSION_REVOKED',
      context: { ip: '203.0.113.7', userAgent: 'jest', sessionId: 's1' },
      details: { scope: 'one', count: 1 },
      now: AT,
    });

    expect(prisma.securityEvent.create).toHaveBeenCalledWith({
      data: {
        authId: 'alice',
        type: 'SESSION_REVOKED',
        sessionId: 's1',
        ipAddress: '203.0.113.7',
        userAgent: 'jest',
        details: { scope: 'one', count: 1 },
        createdAt: AT,
      },
    });
  });

  it('lists only the owner’s events, newest first then by ID, one page at a time', async () => {
    prisma.securityEvent.count.mockResolvedValue(45);
    prisma.securityEvent.findMany.mockResolvedValue([row('e2'), row('e1')]);

    const page = await log.list('alice', 2, 20, 'current');

    expect(prisma.securityEvent.count).toHaveBeenCalledWith({
      where: { authId: 'alice' },
    });
    expect(prisma.securityEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { authId: 'alice' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 20,
        take: 20,
      }),
    );
    expect(page.meta).toEqual({
      page: 2,
      limit: 20,
      total: 45,
      totalPages: 3,
      hasPreviousPage: true,
      hasNextPage: true,
    });
    expect(page.items.map((i) => [i.id, i.currentSession])).toEqual([
      ['e2', true],
      ['e1', false],
    ]);
  });

  it('an empty history has no pages', async () => {
    prisma.securityEvent.count.mockResolvedValue(0);
    prisma.securityEvent.findMany.mockResolvedValue([]);

    const page = await log.list('alice', 1, 20);

    expect(page).toEqual({
      items: [],
      meta: {
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
        hasPreviousPage: false,
        hasNextPage: false,
      },
    });
  });

  describe('the query', () => {
    const errorsOf = (query: Record<string, unknown>) =>
      validateSync(plainToInstance(SecurityActivityQueryDto, query), {
        whitelist: true,
        forbidNonWhitelisted: true,
      }).map((e) => e.property);

    it.each([
      [{}],
      [{ page: '1' }],
      [{ page: '3', limit: '100' }],
      [{ limit: '1' }],
    ])('accepts %p', (query) => {
      expect(errorsOf(query)).toEqual([]);
    });

    it.each([
      [{ page: '0' }, 'page'],
      [{ page: '1.5' }, 'page'],
      [{ page: 'x' }, 'page'],
      [{ limit: '0' }, 'limit'],
      [{ limit: '101' }, 'limit'],
      [{ userId: 'bob' }, 'userId'],
    ])('rejects %p', (query, property) => {
      expect(errorsOf(query)).toEqual([property]);
    });
  });
});
