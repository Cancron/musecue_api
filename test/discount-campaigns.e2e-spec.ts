// Must be first: PostgreSQL-only infrastructure (no Redis), mock AI and local
// storage, set before any application module reads the environment.
import './support/env-postgres-mode';
import { userRole } from '@prisma/client';
import { signInWithRole } from './support/admin-accounts';
import {
  as,
  createAccount,
  DAY,
  dataOf,
  fromNow,
  HOUR,
  listen,
  messageOf,
  newKey,
  nextTestIp,
  type TestAccount,
} from './support/discount-fixtures';
import request from 'supertest';
import { freezeTime } from './support/freeze-time';
import {
  bootApplication,
  type TestApplication,
} from './support/infrastructure-flows';
import {
  applyMigrations,
  createSchema,
  describeWithDatabase,
  dropSchema,
  migrationNames,
} from './support/migrated-schema';

jest.setTimeout(120_000);

const ADMIN = '/v1/admin/discount-campaigns';
const AVAILABLE = '/v1/discount-campaigns';
const redeemPath = (id: string) => `/v1/discount-campaigns/${id}/redeem`;

interface CampaignView {
  id: string;
  kind: string;
  code?: string;
  name: string;
  discountPercent: number;
  active: boolean;
  status: string;
  startsAt: string;
  endsAt: string;
  audience: string;
  targetUserIds: string[];
  maxRedemptionsPerUser: number;
  maxTotalRedemptions: number | null;
  redemptionCount: number;
  remainingRedemptions: number | null;
}
interface AvailableView {
  id: string;
  name: string;
  discountPercent: number;
  startsAt: string;
  endsAt: string;
  remainingRedemptionsForYou: number;
}
interface RedemptionView {
  id: string;
  offerId: string;
  kind: string;
  name: string;
  packageCode: string;
  discountPercent: number;
  originalPriceUsdCents: number;
  discountUsdCents: number;
  finalPriceUsdCents: number;
  replayed: boolean;
}

/** A holiday sale: Christmas week of 2030 (UTC). */
const XMAS_START = new Date('2030-12-20T00:00:00.000Z');
const XMAS_END = new Date('2030-12-27T00:00:00.000Z');

/**
 * Promotional campaigns (e.g. holiday sales) through the complete
 * application against a migrated PostgreSQL schema: administration, the
 * campaigns offered to each user, redemption rules, idempotency,
 * concurrency and persistence across a restart.
 */
describeWithDatabase('Discount campaigns (PostgreSQL, full stack)', () => {
  let schema: string;
  let ctx: TestApplication;
  let admin: TestAccount;
  let moderator: TestAccount;
  let customer: TestAccount;

  let nameCounter = 0;
  const campaignBody = (overrides: Record<string, unknown> = {}) => ({
    name: `Holiday sale ${(nameCounter += 1)}`,
    discountPercent: 30,
    startsAt: fromNow(-HOUR),
    endsAt: fromNow(7 * DAY),
    ...overrides,
  });
  const createCampaign = async (overrides: Record<string, unknown> = {}) =>
    dataOf<CampaignView>(
      await as(ctx, admin).post(ADMIN, campaignBody(overrides)).expect(201),
    );
  const redeem = (
    account: TestAccount,
    id: string,
    packageCode = 'SMALL',
    key = newKey(),
  ) => as(ctx, account).post(redeemPath(id), { packageCode }, key);
  const available = async (account: TestAccount) =>
    dataOf<AvailableView[]>(await as(ctx, account).get(AVAILABLE).expect(200));
  const availableIds = async (account: TestAccount) =>
    (await available(account)).map((campaign) => campaign.id);

  const offerRow = (id: string) =>
    ctx.client.discountOffer.findUniqueOrThrow({ where: { id } });
  const redemptionState = async (offerId: string) => ({
    count: (await offerRow(offerId)).redemptionCount,
    rows: await ctx.client.discountRedemption.count({ where: { offerId } }),
  });

  beforeAll(async () => {
    schema = await createSchema();
    await applyMigrations(schema, migrationNames());
    ctx = await bootApplication({ schema });
    await listen(ctx);
    admin = await createAccount(ctx, userRole.ADMIN);
    moderator = await createAccount(ctx, userRole.MODERATOR);
    customer = await createAccount(ctx);
  });

  afterEach(() => jest.useRealTimers());

  afterAll(async () => {
    jest.useRealTimers();
    await ctx?.close();
    if (schema) await dropSchema(schema);
  });

  describe('administration', () => {
    it('creates a holiday campaign with a discount, period, targeting and limits, stored in PostgreSQL', async () => {
      const invited = await createAccount(ctx);
      const response = await as(ctx, admin)
        .post(ADMIN, {
          name: 'Christmas 2030',
          discountPercent: 40,
          startsAt: '2030-12-20',
          endsAt: '2030-12-27T00:00:00+00:00',
          maxRedemptionsPerUser: 2,
          maxTotalRedemptions: 1000,
          targetUserIds: [invited.id],
        })
        .expect(201);

      const view = dataOf<CampaignView>(response);
      expect(view).toMatchObject({
        kind: 'CAMPAIGN',
        name: 'Christmas 2030',
        discountPercent: 40,
        active: true,
        status: 'SCHEDULED',
        startsAt: XMAS_START.toISOString(),
        endsAt: XMAS_END.toISOString(),
        audience: 'SELECTED_USERS',
        targetUserIds: [invited.id],
        maxRedemptionsPerUser: 2,
        maxTotalRedemptions: 1000,
        redemptionCount: 0,
        remainingRedemptions: 1000,
      });
      expect(view).not.toHaveProperty('code');
      await expect(offerRow(view.id)).resolves.toMatchObject({
        kind: 'CAMPAIGN',
        code: null,
        startsAt: XMAS_START,
        endsAt: XMAS_END,
        audience: 'SELECTED_USERS',
      });
      await expect(
        ctx.client.activityLogEvent.count({
          where: {
            tableName: 'DiscountOffer',
            recordId: view.id,
            action: 'create',
            actionedBy: admin.id,
          },
        }),
      ).resolves.toBe(1);
    });

    it('lists, reads, changes and deactivates campaigns; codes are not reachable through the campaign routes', async () => {
      const campaign = await createCampaign({ discountPercent: 15 });
      const code = dataOf<{ id: string }>(
        await as(ctx, admin)
          .post('/v1/admin/discount-codes', {
            code: `NOTCAMPAIGN${nameCounter}`,
            discountPercent: 10,
            startsAt: fromNow(-HOUR),
            endsAt: fromNow(DAY),
          })
          .expect(201),
      );

      const list = dataOf<CampaignView[]>(
        await as(ctx, admin).get(ADMIN).expect(200),
      );
      expect(list.map((c) => c.id)).toContain(campaign.id);
      expect(list.map((c) => c.id)).not.toContain(code.id);
      await as(ctx, admin).get(`${ADMIN}/${code.id}`).expect(404);
      await as(ctx, admin)
        .patch(`${ADMIN}/${code.id}`, { discountPercent: 90 })
        .expect(404);
      await expect(offerRow(code.id)).resolves.toMatchObject({
        discountPercent: 10,
      });

      const changed = await as(ctx, admin)
        .patch(`${ADMIN}/${campaign.id}`, {
          name: 'Boxing Day',
          discountPercent: 50,
          maxTotalRedemptions: null,
        })
        .expect(200);
      expect(dataOf(changed)).toMatchObject({
        name: 'Boxing Day',
        discountPercent: 50,
        maxTotalRedemptions: null,
      });

      const off = await as(ctx, admin)
        .post(`${ADMIN}/${campaign.id}/deactivate`)
        .expect(200);
      expect(dataOf(off)).toMatchObject({ active: false, status: 'INACTIVE' });
      await expect(
        as(ctx, admin).get(`${ADMIN}/${campaign.id}`).then(dataOf),
      ).resolves.toMatchObject({ name: 'Boxing Day', active: false });
    });

    it.each([
      ['a missing name', { name: undefined }],
      ['a blank name', { name: ' ' }],
      ['a too long name', { name: 'x'.repeat(101) }],
      ['a code', { code: 'XMAS' }],
      ['a discount above 100%', { discountPercent: 101 }],
      ['a negative discount', { discountPercent: -5 }],
      ['a fractional discount', { discountPercent: 0.3 }],
      ['a missing end', { endsAt: undefined }],
      [
        'an end before the start',
        { startsAt: '2030-12-27', endsAt: '2030-12-20' },
      ],
      ['an end in the past', { startsAt: '2020-12-20', endsAt: '2020-12-27' }],
      ['a zero per-user limit', { maxRedemptionsPerUser: 0 }],
      ['a per-user limit above 1000', { maxRedemptionsPerUser: 1001 }],
      ['a total limit above 10000000', { maxTotalRedemptions: 10_000_001 }],
      ['targets that are not a list', { targetUserIds: 'everyone' }],
    ])(
      'rejects a campaign with %s and stores nothing',
      async (_case, change) => {
        const before = await ctx.client.discountOffer.count();
        await as(ctx, admin).post(ADMIN, campaignBody(change)).expect(400);
        await expect(ctx.client.discountOffer.count()).resolves.toBe(before);
      },
    );

    it.each([
      ['USER', () => customer],
      ['MODERATOR', () => moderator],
    ])(
      'a %s can neither create, view, change nor deactivate campaigns',
      async (_role, account) => {
        const campaign = await createCampaign();
        const before = await offerRow(campaign.id);
        const count = await ctx.client.discountOffer.count();

        await as(ctx, account()).post(ADMIN, campaignBody()).expect(403);
        await as(ctx, account()).get(ADMIN).expect(403);
        await as(ctx, account()).get(`${ADMIN}/${campaign.id}`).expect(403);
        await as(ctx, account())
          .patch(`${ADMIN}/${campaign.id}`, { discountPercent: 100 })
          .expect(403);
        await as(ctx, account())
          .post(`${ADMIN}/${campaign.id}/deactivate`)
          .expect(403);
        await as(ctx).post(ADMIN, campaignBody()).expect(401);
        await as(ctx).get(AVAILABLE).expect(401);

        await expect(offerRow(campaign.id)).resolves.toEqual(before);
        await expect(ctx.client.discountOffer.count()).resolves.toBe(count);
      },
    );

    it('an ADMIN signed in through the login route manages campaigns', async () => {
      const signedIn = await signInWithRole(ctx, userRole.ADMIN, nextTestIp());
      const created = await request(ctx.app.getHttpServer())
        .post(ADMIN)
        .set('X-Forwarded-For', nextTestIp())
        .set('Authorization', `Bearer ${signedIn.accessToken}`)
        .send(campaignBody())
        .expect(201);
      expect(dataOf<CampaignView>(created).status).toBe('ACTIVE');
    });
  });

  describe('campaigns offered to users', () => {
    it('offers only the campaigns the user can redeem now', async () => {
      const me = await createAccount(ctx);
      const someoneElse = await createAccount(ctx);
      const open = await createCampaign();
      const forMe = await createCampaign({ targetUserIds: [me.id] });
      const forOthers = await createCampaign({
        targetUserIds: [someoneElse.id],
      });
      const scheduled = await createCampaign({
        startsAt: fromNow(DAY),
        endsAt: fromNow(2 * DAY),
      });
      const zero = await createCampaign({ discountPercent: 0 });
      const deactivated = await createCampaign();
      await as(ctx, admin)
        .post(`${ADMIN}/${deactivated.id}/deactivate`)
        .expect(200);
      const depleted = await createCampaign({ maxTotalRedemptions: 1 });
      await redeem(someoneElse, depleted.id).expect(201);
      const usedUp = await createCampaign({ maxRedemptionsPerUser: 1 });
      await redeem(me, usedUp.id).expect(201);
      const twice = await createCampaign({ maxRedemptionsPerUser: 2 });
      await redeem(me, twice.id).expect(201);
      const expiring = await createCampaign({ endsAt: fromNow(2 * HOUR) });

      const offers = await available(me);
      const ids = offers.map((o) => o.id);
      expect(ids).toEqual(
        expect.arrayContaining([open.id, forMe.id, twice.id, expiring.id]),
      );
      for (const hidden of [
        forOthers,
        scheduled,
        zero,
        deactivated,
        depleted,
        usedUp,
      ]) {
        expect(ids).not.toContain(hidden.id);
      }
      expect(offers.find((o) => o.id === twice.id)).toMatchObject({
        remainingRedemptionsForYou: 1,
      });
      // Ending soonest first.
      expect(ids.indexOf(expiring.id)).toBeLessThan(ids.indexOf(open.id));
      // The list shows no administrative details.
      expect(offers.find((o) => o.id === open.id)).toEqual({
        id: open.id,
        name: open.name,
        discountPercent: 30,
        startsAt: open.startsAt,
        endsAt: open.endsAt,
        remainingRedemptionsForYou: 1,
      });

      const theirs = await availableIds(someoneElse);
      expect(theirs).toContain(forOthers.id);
      expect(theirs).not.toContain(forMe.id);
    });
  });

  describe('redemption', () => {
    it('redeems a running campaign for a credit package at the discounted price', async () => {
      const campaign = await createCampaign({ discountPercent: 30 });

      const response = await redeem(customer, campaign.id, 'LARGE').expect(201);

      expect(dataOf(response)).toMatchObject({
        offerId: campaign.id,
        kind: 'CAMPAIGN',
        name: campaign.name,
        packageCode: 'LARGE',
        credits: 1000,
        discountPercent: 30,
        originalPriceUsdCents: 2000,
        discountUsdCents: 600,
        finalPriceUsdCents: 1400,
        finalPriceUsd: '14.00',
        replayed: false,
      });
      expect(dataOf(response)).not.toHaveProperty('code');
      await expect(redemptionState(campaign.id)).resolves.toEqual({
        count: 1,
        rows: 1,
      });
    });

    it('follows the holiday period: not before it starts, from its first instant, not from its end', async () => {
      const campaign = await createCampaign({
        startsAt: XMAS_START.toISOString(),
        endsAt: XMAS_END.toISOString(),
        maxRedemptionsPerUser: 10,
      });
      const expectState = (count: number) =>
        expect(redemptionState(campaign.id)).resolves.toEqual({
          count,
          rows: count,
        });

      freezeTime(new Date(XMAS_START.getTime() - 1));
      expect(messageOf(await redeem(customer, campaign.id).expect(409))).toBe(
        'This discount has not started yet',
      );
      await expect(availableIds(customer)).resolves.not.toContain(campaign.id);
      await expectState(0);

      freezeTime(XMAS_START);
      await expect(availableIds(customer)).resolves.toContain(campaign.id);
      await redeem(customer, campaign.id).expect(201);

      freezeTime(new Date('2030-12-26T23:59:59.999Z'));
      await redeem(customer, campaign.id).expect(201);

      freezeTime(XMAS_END);
      expect(messageOf(await redeem(customer, campaign.id).expect(409))).toBe(
        'This discount has expired',
      );
      await expect(availableIds(customer)).resolves.not.toContain(campaign.id);
      await expectState(2);
      await expect(
        as(ctx, admin).get(`${ADMIN}/${campaign.id}`).then(dataOf),
      ).resolves.toMatchObject({ status: 'EXPIRED' });
    });

    it.each([
      ['an unknown campaign', 404, 'Discount campaign not found'],
      ['a deactivated campaign', 409, 'This discount is not active'],
      ['a campaign set to 0%', 409, 'This discount is not active'],
      [
        'a campaign for other users',
        403,
        'This discount is not available for your account',
      ],
      ['a depleted campaign', 409, 'This discount has no redemptions left'],
      [
        'a campaign the user has used up',
        409,
        'You have already redeemed this discount the maximum number of times',
      ],
    ])('rejects %s and counts nothing', async (kind, status, message) => {
      const campaign = await createCampaign({ maxTotalRedemptions: 2 });
      let id = campaign.id;
      switch (kind) {
        case 'an unknown campaign':
          id = '00000000-0000-4000-8000-000000000000';
          break;
        case 'a deactivated campaign':
          await as(ctx, admin).post(`${ADMIN}/${id}/deactivate`).expect(200);
          break;
        case 'a campaign set to 0%':
          await as(ctx, admin)
            .patch(`${ADMIN}/${id}`, { discountPercent: 0 })
            .expect(200);
          break;
        case 'a campaign for other users':
          await as(ctx, admin)
            .patch(`${ADMIN}/${id}`, {
              targetUserIds: [(await createAccount(ctx)).id],
            })
            .expect(200);
          break;
        case 'a depleted campaign':
          await redeem(await createAccount(ctx), id).expect(201);
          await redeem(await createAccount(ctx), id).expect(201);
          break;
        case 'a campaign the user has used up':
          await redeem(customer, id).expect(201);
          break;
      }
      const before = await redemptionState(campaign.id);

      const response = await redeem(customer, id);

      expect(response.status).toBe(status);
      expect(response.body).toMatchObject({
        success: false,
        statusCode: status,
        message,
      });
      await expect(redemptionState(campaign.id)).resolves.toEqual(before);
    });

    it('rejects a discount code id on the campaign route', async () => {
      const code = dataOf<{ id: string }>(
        await as(ctx, admin)
          .post('/v1/admin/discount-codes', {
            code: `CODEONLY${nameCounter}`,
            discountPercent: 10,
            startsAt: fromNow(-HOUR),
            endsAt: fromNow(DAY),
          })
          .expect(201),
      );
      expect(messageOf(await redeem(customer, code.id).expect(404))).toBe(
        'Discount campaign not found',
      );
      await expect(redemptionState(code.id)).resolves.toEqual({
        count: 0,
        rows: 0,
      });
    });

    it('keeps the terms of earlier redemptions when the campaign changes', async () => {
      const campaign = await createCampaign({
        discountPercent: 30,
        maxRedemptionsPerUser: 2,
      });
      const first = dataOf<RedemptionView>(
        await redeem(customer, campaign.id).expect(201),
      );

      await as(ctx, admin)
        .patch(`${ADMIN}/${campaign.id}`, { discountPercent: 50 })
        .expect(200);
      const second = dataOf<RedemptionView>(
        await redeem(customer, campaign.id).expect(201),
      );

      expect([first.discountPercent, first.finalPriceUsdCents]).toEqual([
        30, 350,
      ]);
      expect([second.discountPercent, second.finalPriceUsdCents]).toEqual([
        50, 250,
      ]);
      const stored = await ctx.client.discountRedemption.findUniqueOrThrow({
        where: { id: first.id },
      });
      expect(stored).toMatchObject({
        discountPercent: 30,
        finalPriceUsdCents: 350,
      });
    });
  });

  describe('idempotency and concurrency', () => {
    it('counts concurrent duplicates of one request once', async () => {
      const campaign = await createCampaign({ maxRedemptionsPerUser: 3 });
      const key = newKey();

      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          redeem(customer, campaign.id, 'MEDIUM', key),
        ),
      );

      expect(responses.map((r) => r.status)).toEqual(Array(8).fill(201));
      const views = responses.map((r) => dataOf<RedemptionView>(r));
      expect(new Set(views.map((v) => v.id)).size).toBe(1);
      expect(views.filter((v) => !v.replayed)).toHaveLength(1);
      await expect(redemptionState(campaign.id)).resolves.toEqual({
        count: 1,
        rows: 1,
      });
    });

    it('never exceeds the total or per-user limits under a rush of concurrent redemptions', async () => {
      const campaign = await createCampaign({
        maxTotalRedemptions: 7,
        maxRedemptionsPerUser: 2,
      });
      const users = await Promise.all(
        Array.from({ length: 6 }, () => createAccount(ctx)),
      );

      // Every user tries four times at once: 24 requests for 7 redemptions.
      const responses = await Promise.all(
        users.flatMap((user) =>
          Array.from({ length: 4 }, () => redeem(user, campaign.id)),
        ),
      );

      expect(responses.filter((r) => r.status === 201)).toHaveLength(7);
      expect(responses.every((r) => [201, 409].includes(r.status))).toBe(true);
      await expect(redemptionState(campaign.id)).resolves.toEqual({
        count: 7,
        rows: 7,
      });
      const perUser = await ctx.client.discountRedemption.groupBy({
        by: ['authId'],
        where: { offerId: campaign.id },
        _count: true,
      });
      expect(perUser.every((group) => group._count <= 2)).toBe(true);
      await expect(
        as(ctx, admin).get(`${ADMIN}/${campaign.id}`).then(dataOf),
      ).resolves.toMatchObject({ status: 'DEPLETED', remainingRedemptions: 0 });
    });

    it('a concurrent deactivation stops every redemption that is checked after it', async () => {
      const campaign = await createCampaign({ maxRedemptionsPerUser: 50 });
      const user = await createAccount(ctx);

      const [off, ...responses] = await Promise.all([
        as(ctx, admin).post(`${ADMIN}/${campaign.id}/deactivate`),
        ...Array.from({ length: 10 }, () => redeem(user, campaign.id)),
      ]);

      expect(off.status).toBe(200);
      const succeeded = responses.filter((r) => r.status === 201).length;
      for (const rejected of responses.filter((r) => r.status !== 201)) {
        expect(rejected.status).toBe(409);
        expect(messageOf(rejected)).toBe('This discount is not active');
      }
      await expect(redemptionState(campaign.id)).resolves.toEqual({
        count: succeeded,
        rows: succeeded,
      });
      expect(messageOf(await redeem(user, campaign.id).expect(409))).toBe(
        'This discount is not active',
      );
    });
  });

  describe('persistence', () => {
    it('keeps campaigns, targeting, redemptions and limits across an application restart', async () => {
      const invited = await createAccount(ctx);
      const campaign = await createCampaign({
        targetUserIds: [invited.id],
        maxTotalRedemptions: 5,
      });
      await redeem(invited, campaign.id).expect(201);
      const before = await offerRow(campaign.id);

      await ctx.close();
      ctx = await bootApplication({ schema });
      await listen(ctx);

      await expect(offerRow(campaign.id)).resolves.toEqual(before);
      await expect(
        as(ctx, admin).get(`${ADMIN}/${campaign.id}`).then(dataOf),
      ).resolves.toMatchObject({
        audience: 'SELECTED_USERS',
        targetUserIds: [invited.id],
        redemptionCount: 1,
        remainingRedemptions: 4,
      });
      expect(messageOf(await redeem(customer, campaign.id).expect(403))).toBe(
        'This discount is not available for your account',
      );
      expect(messageOf(await redeem(invited, campaign.id).expect(409))).toBe(
        'You have already redeemed this discount the maximum number of times',
      );
    });
  });
});
