import {
  Controller,
  ExecutionContext,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CreditSource } from '@prisma/client';
import { mock } from 'jest-mock-extended';
import type { CreditWalletService } from '../credit/credit-wallet.service';
import type { CreditBalanceView } from '../credit/interfaces/credit-wallet.interface';
import {
  INSUFFICIENT_CREDITS_MESSAGE,
  PRO_ACCESS_REQUIRED_MESSAGE,
  ProAccessGuard,
  RequireCredits,
} from './pro-access.guard';
import type { SubscriptionAccess } from './subscription-access.policy';
import type { SubscriptionAccessService } from './subscription-access.service';

@Controller()
class RoutesUnderTest {
  @Post('sessions')
  @RequireCredits()
  createSession() {}

  @Post('pro-feature')
  proFeature() {}
}

const balance = (
  available: Partial<Record<CreditSource, string>> = {},
): CreditBalanceView => {
  const bySource = {
    TRIAL: '0',
    SUBSCRIPTION: '0',
    PURCHASE: '0',
    REFERRAL: '0',
    ...available,
  };
  const total = Object.values(bySource).reduce(
    (sum, value) => sum + Number(value),
    0,
  );
  return {
    availableCredits: String(total),
    availableBySource: bySource,
    outstandingOverageCredits: '0',
    nextExpiration: null,
  };
};

const NO_PRO: SubscriptionAccess = {
  status: 'EXPIRED',
  hasProAccess: false,
  accessSource: null,
  accessExpiresAt: null,
} as unknown as SubscriptionAccess;

/**
 * ProAccessGuard on a `@RequireCredits()` route (POST /v1/sessions): the
 * decision is the user's available credits, not the Pro subscription.
 */
describe('ProAccessGuard credit eligibility', () => {
  const access = mock<SubscriptionAccessService>();
  const credits = mock<CreditWalletService>();
  const guard = new ProAccessGuard(access, credits, new Reflector());

  const contextFor = (
    handler: keyof RoutesUnderTest,
    request: Record<string, unknown>,
  ) =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => RoutesUnderTest.prototype[handler],
      getClass: () => RoutesUnderTest,
    }) as unknown as ExecutionContext;

  const run = (
    handler: keyof RoutesUnderTest,
    request: Record<string, unknown> = { user: { userId: 'user-1' } },
  ) => guard.canActivate(contextFor(handler, request));

  beforeEach(() => {
    jest.resetAllMocks();
    access.getAccess.mockResolvedValue(NO_PRO);
  });

  it('refuses a user without credits with 403 "Insufficient credits"', async () => {
    credits.getBalance.mockResolvedValue(balance());

    await expect(run('createSession')).rejects.toMatchObject({
      status: 403,
      message: INSUFFICIENT_CREDITS_MESSAGE,
    });
    expect(credits.getBalance.mock.calls).toEqual([['user-1']]);
  });

  it.each([
    [CreditSource.TRIAL, '50'],
    [CreditSource.SUBSCRIPTION, '1000'],
    [CreditSource.PURCHASE, '12.5'],
    [CreditSource.REFERRAL, '0.000001'],
  ])(
    'admits a user whose only available credits are %s credits',
    async (source, amount) => {
      credits.getBalance.mockResolvedValue(balance({ [source]: amount }));
      const request: Record<string, unknown> = { user: { userId: 'user-1' } };

      await expect(run('createSession', request)).resolves.toBe(true);
      expect(request.creditAccess).toMatchObject({
        availableBySource: { [source]: amount },
      });
    },
  );

  it('does not consult the Pro subscription: purchased credits work after Pro has ended', async () => {
    credits.getBalance.mockResolvedValue(balance({ PURCHASE: '3' }));

    await expect(run('createSession')).resolves.toBe(true);
    expect(access.getAccess.mock.calls).toHaveLength(0);
  });

  it('does not admit an active Pro subscriber without credits', async () => {
    access.getAccess.mockResolvedValue({
      ...NO_PRO,
      hasProAccess: true,
    } as SubscriptionAccess);
    credits.getBalance.mockResolvedValue(balance());

    await expect(run('createSession')).rejects.toMatchObject({
      status: 403,
      message: INSUFFICIENT_CREDITS_MESSAGE,
    });
  });

  it('keeps the Pro decision on routes without @RequireCredits(), without reading credits', async () => {
    credits.getBalance.mockResolvedValue(balance({ PURCHASE: '100' }));

    await expect(run('proFeature')).rejects.toMatchObject({
      status: 403,
      message: PRO_ACCESS_REQUIRED_MESSAGE,
    });
    expect(credits.getBalance.mock.calls).toHaveLength(0);
  });

  it('fails closed when the balance lookup fails', async () => {
    credits.getBalance.mockRejectedValue(new Error('database unavailable'));

    await expect(run('createSession')).rejects.toThrow('database unavailable');
  });

  it('rejects a request that did not pass AuthGuard, without a lookup', async () => {
    await expect(run('createSession', {})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(credits.getBalance.mock.calls).toHaveLength(0);
  });
});
