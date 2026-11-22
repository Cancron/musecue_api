import { Prisma } from '@prisma/client';
import { mock, mockDeep } from 'jest-mock-extended';
import { PrismaService } from '../common/services/prisma.service';
import { DiscountSettingsService } from './discount-settings.service';
import { REFERRAL_MESSAGES, ReferralService } from './referral.service';

describe('ReferralService', () => {
  const prisma = mockDeep<PrismaService>();
  const settings = mock<DiscountSettingsService>();
  const service = new ReferralService(prisma, settings);

  const discountSettings = (referralDiscountPercent: number) => ({
    firstPurchaseDiscountPercent: 0,
    firstPurchaseDiscountActive: false,
    referralDiscountPercent,
    referralDiscountActive: referralDiscountPercent > 0,
    referrerRewardCredits: 0,
    referrerRewardActive: false,
    updatedAt: new Date().toISOString(),
  });

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(((
      callback: (tx: PrismaService) => Promise<unknown>,
    ) => callback(prisma)) as never);
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.userSubscription.createMany.mockResolvedValue({ count: 0 });
    prisma.referralCode.findUnique.mockImplementation(((args: {
      where: { authId?: string; code?: string };
    }) =>
      Promise.resolve(
        args.where.code === 'FRIEND42'
          ? { authId: 'referrer', code: 'FRIEND42', createdAt: new Date() }
          : args.where.authId
            ? {
                authId: args.where.authId,
                code: 'OWNCODE1',
                createdAt: new Date(),
              }
            : null,
      )) as never);
    prisma.referral.findUnique.mockResolvedValue(null);
    prisma.paymentTransaction.findFirst.mockResolvedValue(null);
    settings.getSettings.mockResolvedValue(discountSettings(15));
  });

  it('applies another user’s code in any letter case', async () => {
    prisma.referral.findUnique.mockResolvedValueOnce(null).mockResolvedValue({
      authId: 'me',
      referrerAuthId: 'referrer',
      createdAt: new Date(),
    });

    await expect(service.applyCode('me', ' friend42 ')).resolves.toMatchObject({
      referred: true,
      referralDiscountPercent: 15,
    });
    expect(prisma.referral.create.mock.calls).toEqual([
      [{ data: { authId: 'me', referrerAuthId: 'referrer' } }],
    ]);
  });

  it.each([
    ['an unknown code', 'NOSUCH', {}, 404, REFERRAL_MESSAGES.CODE_NOT_FOUND],
    [
      'the own code',
      'FRIEND42',
      { me: 'referrer' },
      400,
      REFERRAL_MESSAGES.OWN_CODE,
    ],
    [
      'a second code',
      'FRIEND42',
      { referred: true },
      409,
      REFERRAL_MESSAGES.ALREADY_REFERRED,
    ],
    [
      'a code after a paid purchase',
      'FRIEND42',
      { paid: true },
      409,
      REFERRAL_MESSAGES.ALREADY_PURCHASED,
    ],
  ])(
    'refuses %s and stores nothing',
    async (
      _case,
      code,
      state: { me?: string; referred?: boolean; paid?: boolean },
      status,
      message,
    ) => {
      if (state.referred) {
        prisma.referral.findUnique.mockResolvedValue({
          authId: 'me',
          referrerAuthId: 'x',
          createdAt: new Date(),
        });
      }
      if (state.paid) {
        prisma.paymentTransaction.findFirst.mockResolvedValue({
          id: 'payment',
        } as never);
      }
      await expect(
        service.applyCode(state.me ?? 'me', code),
      ).rejects.toMatchObject({
        status,
        message,
      });
      expect(prisma.referral.create.mock.calls).toHaveLength(0);
    },
  );

  it('answers 409 when a concurrent request applied a code first', async () => {
    prisma.referral.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(service.applyCode('me', 'FRIEND42')).rejects.toMatchObject({
      status: 409,
      message: REFERRAL_MESSAGES.ALREADY_REFERRED,
    });
  });

  it('offers the referral discount only to referred users before their first purchase, while it is on', async () => {
    await expect(service.getReferral('me')).resolves.toEqual({
      code: 'OWNCODE1',
      referred: false,
      referralDiscountPercent: 0,
    });
    prisma.referral.findUnique.mockResolvedValue({
      authId: 'me',
      referrerAuthId: 'referrer',
      createdAt: new Date(),
    });
    await expect(service.getReferral('me')).resolves.toMatchObject({
      referred: true,
      referralDiscountPercent: 15,
    });
    settings.getSettings.mockResolvedValue(discountSettings(0));
    await expect(service.getReferral('me')).resolves.toMatchObject({
      referralDiscountPercent: 0,
    });
    settings.getSettings.mockResolvedValue(discountSettings(15));
    prisma.paymentTransaction.findFirst.mockResolvedValue({
      id: 'payment',
    } as never);
    await expect(service.getReferral('me')).resolves.toMatchObject({
      referralDiscountPercent: 0,
    });
  });

  it('creates the user’s own code on first use', async () => {
    prisma.referralCode.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        authId: 'new',
        code: 'ABCDEFGH',
        createdAt: new Date(),
      });
    prisma.referralCode.createMany.mockResolvedValue({ count: 1 });
    await expect(service.getReferral('new')).resolves.toMatchObject({
      code: 'ABCDEFGH',
    });
    const created = prisma.referralCode.createMany.mock.calls[0]?.[0] as {
      data: Array<{ code: string }>;
    };
    expect(created.data[0].code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });
});
