import { CreditSource } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { ActivityLogService } from '../common/services/activity-log.service';
import { PrismaService } from '../common/services/prisma.service';
import type { CreditSettingsService } from '../credit/credit-settings.service';
import type { CreditWalletService } from '../credit/credit-wallet.service';
import type { CreditSettingsView } from '../credit/interfaces/credit-settings.interface';
import type { AllocateCreditsInput } from '../credit/interfaces/credit-wallet.interface';
import { SubscriptionPlanService } from './subscription-plan.service';
import { SubscriptionTrialService } from './subscription-trial.service';

const DAY_MS = 86_400_000;

/**
 * Trial credits allocated by trial activation (SubscriptionTrialService with
 * a mocked database and credit services). The PostgreSQL behaviour is
 * covered by test/credit-trial.e2e-spec.ts.
 */
describe('SubscriptionTrialService trial credits', () => {
  const prisma = mockDeep<PrismaService>();
  const plans = mock<SubscriptionPlanService>();
  const creditSettings = mock<CreditSettingsService>();
  const wallets = mock<CreditWalletService>();
  const service = new SubscriptionTrialService(
    prisma,
    plans,
    mock<ActivityLogService>(),
    creditSettings,
    wallets,
  );
  const now = new Date('2026-03-01T09:30:00.000Z');
  const meta = { ip: '127.0.0.1' };

  const settings = (trialAllowanceCredits: number): CreditSettingsView => ({
    trialAllowanceCredits,
    proMonthlyAllowanceCredits: 1000,
    openRouterUsdMicrosPerCredit: 5000,
    openRouterUsdPerCredit: '0.005',
    sessionOverageAllowanceCredits: 5,
    updatedAt: now.toISOString(),
  });

  const givenPlan = (trialDays = 7, trialEnabled = true) =>
    plans.getProPlan.mockResolvedValue({
      code: 'PRO',
      currency: 'USD',
      planEnabled: true,
      monthlyPriceUsdCents: 1900,
      yearlyPriceUsdCents: 19000,
      trialEnabled,
      trialDays,
      updatedAt: null,
    });

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(((
      callback: (tx: PrismaService) => Promise<unknown>,
    ) => callback(prisma)) as never);
    prisma.authUser.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      verified: true,
      deletedAt: null,
    } as never);
    givenPlan();
    prisma.userSubscription.findUnique.mockResolvedValue(null);
    prisma.userSubscription.createMany.mockResolvedValue({ count: 1 });
    prisma.userSubscription.updateMany.mockResolvedValue({ count: 1 });
    prisma.userSubscription.findUniqueOrThrow.mockResolvedValue({
      id: 'sub-1',
      trialUsed: true,
      trialStartedAt: now,
      trialExpiresAt: new Date(now.getTime() + 7 * DAY_MS),
      proStartedAt: null,
      proExpiresAt: null,
      proCanceledAt: null,
    } as never);
    creditSettings.getSettings.mockResolvedValue(settings(50));
    wallets.allocateInTransaction.mockImplementation(
      (_tx, input: AllocateCreditsInput) =>
        Promise.resolve({
          created: true,
          allocation: {
            id: 'trial-allocation',
            source: input.source,
            sourceReference: input.sourceReference,
            grantedCredits: String(input.credits),
            remainingCredits: String(input.credits),
            expiresAt: input.expiresAt?.toISOString() ?? null,
            expiredAt: null,
            grantedAt: now.toISOString(),
            subscriptionId: null,
            paymentId: null,
            periodIndex: null,
            periodStartsAt: null,
          },
        }),
    );
  });

  it('allocates the default 50 trial credits, expiring with the trial, in the activation transaction', async () => {
    const result = await service.activateTrial('user-1', meta, now);

    const trialEnd = new Date(now.getTime() + 7 * DAY_MS);
    expect(creditSettings.getSettings.mock.calls).toEqual([[prisma]]);
    expect(wallets.allocateInTransaction.mock.calls).toEqual([
      [
        prisma,
        {
          authId: 'user-1',
          source: CreditSource.TRIAL,
          sourceReference: 'trial:sub-1',
          credits: 50,
          expiresAt: trialEnd,
          now,
        },
      ],
    ]);
    expect(result.trialCredits).toEqual({
      allocationId: 'trial-allocation',
      credits: '50',
      expiresAt: trialEnd.toISOString(),
    });
    expect(result.trialExpiresAt).toBe(trialEnd.toISOString());
  });

  it('allocates the allowance configured by the administrator, expiring after the configured trial length', async () => {
    creditSettings.getSettings.mockResolvedValue(settings(120));
    givenPlan(14);

    await service.activateTrial('user-1', meta, now);

    expect(wallets.allocateInTransaction.mock.calls[0]?.[1]).toMatchObject({
      credits: 120,
      expiresAt: new Date(now.getTime() + 14 * DAY_MS),
    });
  });

  it('starts the trial without credits when the allowance is 0', async () => {
    creditSettings.getSettings.mockResolvedValue(settings(0));

    const result = await service.activateTrial('user-1', meta, now);

    expect(result.trialCredits).toBeNull();
    expect(wallets.allocateInTransaction.mock.calls).toHaveLength(0);
  });

  it.each([
    [
      'the trial was already used',
      () =>
        prisma.userSubscription.findUnique.mockResolvedValue({
          trialUsed: true,
          trialStartedAt: now,
          trialExpiresAt: now,
          proStartedAt: null,
        } as never),
    ],
    [
      'a concurrent request claimed the trial first',
      () => prisma.userSubscription.updateMany.mockResolvedValue({ count: 0 }),
    ],
    ['the trial is disabled', () => givenPlan(7, false)],
  ])('allocates nothing when %s', async (_case, arrange) => {
    arrange();

    await expect(service.activateTrial('user-1', meta, now)).rejects.toThrow();
    expect(wallets.allocateInTransaction.mock.calls).toHaveLength(0);
  });

  it('fails the whole activation when the credits cannot be allocated (rolled back together)', async () => {
    wallets.allocateInTransaction.mockRejectedValue(new Error('ledger down'));

    await expect(service.activateTrial('user-1', meta, now)).rejects.toThrow(
      'ledger down',
    );
  });
});
