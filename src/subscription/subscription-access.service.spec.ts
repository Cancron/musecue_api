import { BillingInterval, SubscriptionStatus } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../common/services/prisma.service';
import { SubscriptionAccessService } from './subscription-access.service';
import { SubscriptionPlanService } from './subscription-plan.service';

describe('SubscriptionAccessService', () => {
  const prisma = mockDeep<PrismaService>();
  const plans = mock<SubscriptionPlanService>();
  const service = new SubscriptionAccessService(prisma, plans);
  const now = new Date('2026-01-10T00:00:00.000Z');

  const activeAccount = { status: 'ACTIVE', verified: true, deletedAt: null };

  const activePro = {
    trialUsed: false,
    trialStartedAt: null,
    trialExpiresAt: null,
    billingInterval: BillingInterval.YEARLY,
    proStartedAt: new Date('2026-01-01T00:00:00.000Z'),
    proExpiresAt: new Date('2027-01-01T00:00:00.000Z'),
    proCanceledAt: null,
  };

  beforeEach(() => {
    jest.resetAllMocks();
    plans.getProPlan.mockResolvedValue({
      code: 'PRO',
      currency: 'USD',
      planEnabled: true,
      monthlyPriceUsdCents: 1900,
      yearlyPriceUsdCents: 19000,
      trialEnabled: true,
      trialDays: 7,
      updatedAt: null,
    });
  });

  it('loads only the caller’s record and resolves access through the policy', async () => {
    prisma.userSubscription.findUnique.mockResolvedValue(activePro as never);

    await expect(service.getAccess('user-1', now)).resolves.toEqual({
      status: SubscriptionStatus.PRO,
      hasProAccess: true,
      accessSource: 'PRO',
      accessExpiresAt: activePro.proExpiresAt,
    });
    expect(prisma.userSubscription.findUnique.mock.calls[0]?.[0]).toEqual({
      where: { authId: 'user-1' },
      select: {
        trialUsed: true,
        trialStartedAt: true,
        trialExpiresAt: true,
        billingInterval: true,
        proStartedAt: true,
        proExpiresAt: true,
        proCanceledAt: true,
      },
    });
  });

  it('treats a user without a record as FREE without access', async () => {
    prisma.userSubscription.findUnique.mockResolvedValue(null);

    await expect(service.hasProAccess('user-1', now)).resolves.toBe(false);
    await expect(service.getAccess('user-1', now)).resolves.toMatchObject({
      status: SubscriptionStatus.FREE,
    });
  });

  it('checks trial eligibility against the current plan settings', async () => {
    prisma.authUser.findUnique.mockResolvedValue(activeAccount as never);
    prisma.userSubscription.findUnique.mockResolvedValue(null);
    await expect(service.canStartTrial('user-1')).resolves.toBe(true);

    plans.getProPlan.mockResolvedValue({
      ...(await plans.getProPlan()),
      trialEnabled: false,
    });
    await expect(service.canStartTrial('user-1')).resolves.toBe(false);
  });

  it.each([
    ['suspended', { ...activeAccount, status: 'SUSPENDED' }],
    ['unverified', { ...activeAccount, verified: false }],
    ['soft-deleted', { ...activeAccount, deletedAt: new Date('2026-01-01') }],
    ['missing', null],
  ])(
    'agrees with trial activation and the status endpoint: a %s account cannot start a trial',
    async (_case, account) => {
      prisma.authUser.findUnique.mockResolvedValue(account as never);
      prisma.userSubscription.findUnique.mockResolvedValue(null);
      await expect(service.canStartTrial('user-1')).resolves.toBe(false);
    },
  );

  it('uses the current time when none is given', async () => {
    prisma.userSubscription.findUnique.mockResolvedValue({
      ...activePro,
      proExpiresAt: new Date(Date.now() - 1000),
    } as never);

    await expect(service.hasProAccess('user-1')).resolves.toBe(false);
  });
});
