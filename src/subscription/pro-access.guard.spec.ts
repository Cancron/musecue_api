import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import {
  BillingInterval,
  SubscriptionStatus,
  type UserSubscription,
} from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { freezeTime } from '../../test/support/freeze-time';
import { PrismaService } from '../common/services/prisma.service';
import {
  PRO_ACCESS_REQUIRED_MESSAGE,
  ProAccessGuard,
} from './pro-access.guard';
import { SubscriptionAccessService } from './subscription-access.service';
import { SubscriptionPlanService } from './subscription-plan.service';

type Row = Omit<UserSubscription, 'id' | 'authId' | 'createdAt' | 'updatedAt'>;

const T0 = new Date('2026-03-01T00:00:00.000Z');
const at = (days: number, ms = 0) =>
  new Date(T0.getTime() + days * 86_400_000 + ms);

const row = (overrides: Partial<Row> = {}): Row => ({
  status: SubscriptionStatus.FREE,
  trialUsed: false,
  trialStartedAt: null,
  trialExpiresAt: null,
  billingInterval: null,
  proStartedAt: null,
  proExpiresAt: null,
  proCanceledAt: null,
  paymentProvider: null,
  providerSubscriptionId: null,
  ...overrides,
});
const trial = (start: number, end: number): Partial<Row> => ({
  trialUsed: true,
  trialStartedAt: at(start),
  trialExpiresAt: at(end),
});
const paid = (
  start: number,
  end: number,
  billingInterval: BillingInterval = BillingInterval.MONTHLY,
): Partial<Row> => ({
  billingInterval,
  proStartedAt: at(start),
  proExpiresAt: at(end),
});

/**
 * The guard runs with the real SubscriptionAccessService and policy; only the
 * database is mocked, so these tests exercise the actual access decision.
 */
describe('ProAccessGuard', () => {
  const prisma = mockDeep<PrismaService>();
  const guard = new ProAccessGuard(
    new SubscriptionAccessService(prisma, mock<SubscriptionPlanService>()),
  );
  let stored: Row | null;

  const contextFor = (request: Record<string, unknown>) =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
    }) as unknown as ExecutionContext;

  /** Runs the guard for `user-1` at `now`; returns the request on success. */
  const check = async (now: Date) => {
    freezeTime(now);
    const request: Record<string, unknown> = { user: { userId: 'user-1' } };
    await guard.canActivate(contextFor(request));
    return request;
  };

  beforeEach(() => {
    jest.resetAllMocks();
    stored = null;
    prisma.userSubscription.findUnique.mockImplementation((() =>
      Promise.resolve(stored)) as never);
  });

  afterEach(() => jest.useRealTimers());

  describe('users without a subscription', () => {
    it('denies a user with no subscription record', async () => {
      await expect(check(at(10))).rejects.toMatchObject({
        status: 403,
        message: PRO_ACCESS_REQUIRED_MESSAGE,
      });
    });

    it('denies a user with an unused (FREE) record', async () => {
      stored = row();
      await expect(check(at(10))).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('active trials', () => {
    beforeEach(() => {
      stored = row({ status: SubscriptionStatus.TRIAL, ...trial(5, 12) });
    });

    it('allows access during the trial and attaches the decision to the request', async () => {
      const request = await check(at(10));
      expect(request.proAccess).toEqual({
        status: 'TRIAL',
        hasProAccess: true,
        accessSource: 'TRIAL',
        accessExpiresAt: at(12),
      });
    });

    it('allows access from the exact start instant', async () => {
      await expect(check(at(5))).resolves.toBeDefined();
    });

    it('allows access 1 ms before the trial expires', async () => {
      await expect(check(at(12, -1))).resolves.toBeDefined();
    });
  });

  describe('expired trials', () => {
    beforeEach(() => {
      stored = row({ status: SubscriptionStatus.TRIAL, ...trial(5, 12) });
    });

    it('denies access at the exact expiry instant', async () => {
      await expect(check(at(12))).rejects.toMatchObject({ status: 403 });
    });

    it('denies access after expiry even though the stored status still says TRIAL', async () => {
      await expect(check(at(40))).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('paid Pro terms', () => {
    it.each([BillingInterval.MONTHLY, BillingInterval.YEARLY])(
      'allows an active %s term',
      async (interval) => {
        stored = row({
          status: SubscriptionStatus.PRO,
          ...paid(5, 35, interval),
        });
        const request = await check(at(10));
        expect(request.proAccess).toMatchObject({ accessSource: 'PRO' });
      },
    );

    it('allows a canceled term until it expires, then denies', async () => {
      stored = row({
        status: SubscriptionStatus.PRO,
        ...paid(5, 35),
        proCanceledAt: at(6),
      });
      await expect(check(at(35, -1))).resolves.toBeDefined();
      await expect(check(at(35))).rejects.toMatchObject({ status: 403 });
    });

    it('denies an expired paid term', async () => {
      stored = row({ status: SubscriptionStatus.EXPIRED, ...paid(-30, 5) });
      await expect(check(at(10))).rejects.toMatchObject({ status: 403 });
    });

    it('denies before a future-dated term starts', async () => {
      stored = row({ status: SubscriptionStatus.PRO, ...paid(20, 50) });
      await expect(check(at(20, -1))).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('access decision', () => {
    it('grants the same access to a trial and a paid term, differing only in source and expiry', async () => {
      stored = row({ status: SubscriptionStatus.TRIAL, ...trial(5, 12) });
      const viaTrial = (await check(at(10))).proAccess;
      stored = row({ status: SubscriptionStatus.PRO, ...paid(5, 35) });
      const viaPaid = (await check(at(10))).proAccess;

      expect(viaTrial).toMatchObject({
        hasProAccess: true,
        accessSource: 'TRIAL',
        accessExpiresAt: at(12),
      });
      expect(viaPaid).toMatchObject({
        hasProAccess: true,
        accessSource: 'PRO',
        accessExpiresAt: at(35),
      });
    });

    it('allows a paid term bought after an expired trial', async () => {
      stored = row({
        status: SubscriptionStatus.PRO,
        ...trial(0, 7),
        ...paid(9, 39),
      });
      const request = await check(at(10));
      expect(request.proAccess).toMatchObject({ accessSource: 'PRO' });
    });

    it('keeps access through the trial-to-paid hand-off', async () => {
      stored = row({
        status: SubscriptionStatus.PRO,
        ...trial(3, 10),
        ...paid(10, 40),
      });
      expect((await check(at(10, -1))).proAccess).toMatchObject({
        accessSource: 'TRIAL',
      });
      expect((await check(at(10))).proAccess).toMatchObject({
        accessSource: 'PRO',
      });
    });

    it('looks up only the authenticated user’s subscription', async () => {
      stored = row({ status: SubscriptionStatus.TRIAL, ...trial(5, 12) });
      await check(at(10));
      expect(
        prisma.userSubscription.findUnique.mock.calls.map(([a]) => a.where),
      ).toEqual([{ authId: 'user-1' }]);
    });

    it('rejects a request that did not pass AuthGuard, without a lookup', async () => {
      await expect(guard.canActivate(contextFor({}))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.userSubscription.findUnique.mock.calls).toHaveLength(0);
    });

    it('fails closed when the subscription lookup fails', async () => {
      prisma.userSubscription.findUnique.mockRejectedValue(
        new Error('db down'),
      );
      await expect(check(at(10))).rejects.toThrow('db down');
    });
  });
});
