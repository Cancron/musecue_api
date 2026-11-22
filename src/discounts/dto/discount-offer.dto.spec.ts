import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateDiscountCampaignDto,
  CreateDiscountCodeDto,
  RedeemDiscountCodeDto,
  UpdateDiscountCodeDto,
} from './discount-offer.dto';

/** The properties that failed, as the global ValidationPipe would report. */
const invalid = async (cls: new () => object, body: object) =>
  (
    await validate(plainToInstance(cls, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    })
  ).map((error) => error.property);

const CODE = {
  code: 'XMAS-2026',
  discountPercent: 20,
  startsAt: '2026-12-20',
  endsAt: '2026-12-27T00:00:00Z',
};
const CAMPAIGN = {
  name: 'Holiday sale',
  discountPercent: 15,
  startsAt: '2026-12-20T00:00:00.000+01:00',
  endsAt: '2026-12-27',
};

describe('discount offer DTOs', () => {
  it('accepts minimal codes and campaigns', async () => {
    await expect(invalid(CreateDiscountCodeDto, CODE)).resolves.toEqual([]);
    await expect(invalid(CreateDiscountCampaignDto, CAMPAIGN)).resolves.toEqual(
      [],
    );
  });

  it('accepts every option, including null for unlimited and untargeted', async () => {
    await expect(
      invalid(CreateDiscountCodeDto, {
        ...CODE,
        name: 'Christmas',
        active: false,
        maxRedemptionsPerUser: 3,
        maxTotalRedemptions: null,
        targetUserIds: null,
      }),
    ).resolves.toEqual([]);
    await expect(
      invalid(CreateDiscountCampaignDto, {
        ...CAMPAIGN,
        maxTotalRedemptions: 500,
        targetUserIds: ['a', 'b'],
      }),
    ).resolves.toEqual([]);
  });

  it.each(['code', 'discountPercent', 'startsAt', 'endsAt'])(
    'requires %s for a code',
    async (field) => {
      const body: Record<string, unknown> = { ...CODE };
      delete body[field];
      await expect(invalid(CreateDiscountCodeDto, body)).resolves.toEqual([
        field,
      ]);
    },
  );

  it.each(['name', 'discountPercent', 'startsAt', 'endsAt'])(
    'requires %s for a campaign',
    async (field) => {
      const body: Record<string, unknown> = { ...CAMPAIGN };
      delete body[field];
      await expect(invalid(CreateDiscountCampaignDto, body)).resolves.toEqual([
        field,
      ]);
    },
  );

  it.each([
    ['a too short code', { code: 'AB' }, 'code'],
    ['a code with spaces', { code: 'XMAS 2026' }, 'code'],
    ['a code starting with "-"', { code: '-XMAS' }, 'code'],
    ['a too long code', { code: 'A'.repeat(33) }, 'code'],
    ['a negative discount', { discountPercent: -1 }, 'discountPercent'],
    ['a discount above 100%', { discountPercent: 101 }, 'discountPercent'],
    ['a fractional discount', { discountPercent: 12.5 }, 'discountPercent'],
    ['a discount as a string', { discountPercent: '20' }, 'discountPercent'],
    ['a null discount', { discountPercent: null }, 'discountPercent'],
    [
      'a date-time without a time zone',
      { startsAt: '2026-12-20T10:00:00' },
      'startsAt',
    ],
    ['an impossible date', { endsAt: '2026-02-30' }, 'endsAt'],
    ['a timestamp number', { endsAt: 1798761600000 }, 'endsAt'],
    ['a null start', { startsAt: null }, 'startsAt'],
    [
      'a zero per-user limit',
      { maxRedemptionsPerUser: 0 },
      'maxRedemptionsPerUser',
    ],
    [
      'a null per-user limit',
      { maxRedemptionsPerUser: null },
      'maxRedemptionsPerUser',
    ],
    [
      'a fractional total',
      { maxTotalRedemptions: 10.5 },
      'maxTotalRedemptions',
    ],
    ['a zero total', { maxTotalRedemptions: 0 }, 'maxTotalRedemptions'],
    ['a negative total', { maxTotalRedemptions: -5 }, 'maxTotalRedemptions'],
    ['an empty target list', { targetUserIds: [] }, 'targetUserIds'],
    ['duplicate targets', { targetUserIds: ['a', 'a'] }, 'targetUserIds'],
    ['a non-string target', { targetUserIds: [1] }, 'targetUserIds'],
    ['a blank name', { name: '   ' }, 'name'],
    ['a null name', { name: null }, 'name'],
    ['a boolean as a string', { active: 'true' }, 'active'],
    ['an unknown field', { redemptionCount: 0 }, 'redemptionCount'],
  ])('rejects %s', async (_case, change, field) => {
    await expect(
      invalid(CreateDiscountCodeDto, { ...CODE, ...change }),
    ).resolves.toEqual([field]);
  });

  it('accepts any subset on change, but never the code itself', async () => {
    await expect(invalid(UpdateDiscountCodeDto, {})).resolves.toEqual([]);
    await expect(
      invalid(UpdateDiscountCodeDto, { discountPercent: 0 }),
    ).resolves.toEqual([]);
    await expect(
      invalid(UpdateDiscountCodeDto, {
        maxTotalRedemptions: null,
        targetUserIds: null,
      }),
    ).resolves.toEqual([]);
    await expect(
      invalid(UpdateDiscountCodeDto, { code: 'OTHER' }),
    ).resolves.toEqual(['code']);
  });

  it('requires a code and a known package to redeem', async () => {
    await expect(
      invalid(RedeemDiscountCodeDto, { code: 'xmas', packageCode: 'SMALL' }),
    ).resolves.toEqual([]);
    await expect(
      invalid(RedeemDiscountCodeDto, { code: '', packageCode: 'HUGE' }),
    ).resolves.toEqual(['code', 'packageCode']);
  });
});
