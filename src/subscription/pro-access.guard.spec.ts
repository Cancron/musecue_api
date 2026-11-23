import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  BillingInterval,
  SubscriptionStatus,
  type UserSubscription,
} from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { freezeTime } from '../../test/support/freeze-time';
import { PrismaService } from '../common/services/prisma.service';
import {
  CreditEligibilityService,
  type CreditEligibility,
} from './credit-eligibility.service';
import {
  INSUFFICIENT_CREDITS_MESSAGE,
  PRO_ACCESS_REQUIRED_MESSAGE,
  ProAccessGuard,
} from './pro-access.guard';
import { RequireCredits } from './require-credits.decorator';
import { InsufficientCreditsError } from '../credits/credit-wallet.errors';
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
  pastDueSince: null,
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

/** Handlers as a controller would declare them. */
class Handlers {
  proFeature(this: void) {}

  @RequireCredits()
  createSession(this: void) {}
}

/**
 * The guard runs with the real SubscriptionAccessService, policy and
 * Reflector; only the database (and, in credit mode, the credit decision)
 * is mocked, so these tests exercise the actual access decision.
 */
describe('ProAccessGuard', () => {
  const prisma = mockDeep<PrismaService>();
  const credits = mock<CreditEligibilityService>();
  const guard = new ProAccessGuard(
    new SubscriptionAccessService(prisma, mock<SubscriptionPlanService>()),
    credits,
    new Reflector(),
  );
  let stored: Row | null;

  const contextFor = (
    request: Record<string, unknown>,
    handler: () => void = Handlers.prototype.proFeature,
  ) =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => handler,
      getClass: () => Handlers,
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

    it('never consults credits on handlers without @RequireCredits()', async () => {
      stored = row({ status: SubscriptionStatus.TRIAL, ...trial(5, 12) });
      await check(at(10));
      await expect(check(at(40))).rejects.toMatchObject({
        message: PRO_ACCESS_REQUIRED_MESSAGE,
      });
      expect(credits.getEligibility.mock.calls).toHaveLength(0);
    });
  });

  describe('credit mode (@RequireCredits())', () => {
    const decision = (
      eligible: boolean,
      hasProAccess = false,
    ): CreditEligibility => ({
      eligible,
      usableCredits: eligible ? '12.5' : '0',
      usableBySource: {
        TRIAL: '0',
        SUBSCRIPTION: '0',
        PURCHASE: eligible ? '12.5' : '0',
        REFERRAL: '0',
        DAILY_REWARD: '0',
        MISSION_REWARD: '0',
        GIFT: '0',
      },
      proAccess: {
        status: hasProAccess ? 'PRO' : 'EXPIRED',
        hasProAccess,
        accessSource: hasProAccess ? 'PRO' : null,
        accessExpiresAt: null,
      },
    });
    const checkCredits = async (request: Record<string, unknown>) => {
      await guard.canActivate(
        contextFor(request, Handlers.prototype.createSession),
      );
      return request;
    };

    it('lets a user with usable credits through without Pro and attaches both decisions', async () => {
      credits.getEligibility.mockResolvedValue(decision(true, false));

      const request = await checkCredits({ user: { userId: 'user-1' } });

      expect(credits.getEligibility.mock.calls).toEqual([['user-1']]);
      expect(request.creditAccess).toEqual(decision(true, false));
      expect(request.proAccess).toMatchObject({ hasProAccess: false });
      // The Pro-only decision is not what gates this handler.
      expect(prisma.userSubscription.findUnique.mock.calls).toHaveLength(0);
    });

    it('rejects a user without usable credits with 403 "Insufficient credits", even with Pro', async () => {
      credits.getEligibility.mockResolvedValue(decision(false, true));

      const error = await checkCredits({ user: { userId: 'user-1' } }).catch(
        (caught: unknown) => caught,
      );
      // The same error a wallet debit throws beyond the balance and overage.
      expect(error).toBeInstanceOf(InsufficientCreditsError);
      expect(error).toMatchObject({
        status: 403,
        message: INSUFFICIENT_CREDITS_MESSAGE,
      });
    });

    it('rejects a request that did not pass AuthGuard, without a lookup', async () => {
      await expect(checkCredits({})).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(credits.getEligibility.mock.calls).toHaveLength(0);
    });

    it('fails closed when the credit lookup fails', async () => {
      credits.getEligibility.mockRejectedValue(new Error('db down'));
      await expect(
        checkCredits({ user: { userId: 'user-1' } }),
      ).rejects.toThrow('db down');
    });
  });
});
