// Must be first: PostgreSQL-only infrastructure (no Redis), mock AI and local
// storage, set before any application module reads the environment.
import './support/env-postgres-mode';
import { userRole } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
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

const ADMIN = '/v1/admin/discount-codes';
const REDEEM = '/v1/discount-codes/redeem';

interface CodeView {
  id: string;
  kind: string;
  code: string;
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
  createdAt: string;
  updatedAt: string;
}
interface RedemptionView {
  id: string;
  offerId: string;
  kind: string;
  code: string;
  packageCode: string;
  credits: number;
  discountPercent: number;
  originalPriceUsdCents: number;
  discountUsdCents: number;
  finalPriceUsdCents: number;
  finalPriceUsd: string;
  redeemedAt: string;
  replayed: boolean;
}

/**
 * Discount codes through the complete application (AppModule, HTTP, real
 * guards, validation and the database rules) against a migrated PostgreSQL
 * schema: administration, redemption rules, idempotency, concurrency and
 * persistence across a restart.
 */
describeWithDatabase('Discount codes (PostgreSQL, full stack)', () => {
  let schema: string;
  let ctx: TestApplication;
  let admin: TestAccount;
  let superadmin: TestAccount;
  let moderator: TestAccount;
  let customer: TestAccount;

  const uniqueCode = (prefix = 'CODE') =>
    `${prefix}-${randomBytes(4).toString('hex').toUpperCase()}`;
  const codeBody = (overrides: Record<string, unknown> = {}) => ({
    code: uniqueCode(),
    discountPercent: 20,
    startsAt: fromNow(-HOUR),
    endsAt: fromNow(7 * DAY),
    ...overrides,
  });
  const createCode = async (overrides: Record<string, unknown> = {}) =>
    dataOf<CodeView>(
      await as(ctx, admin).post(ADMIN, codeBody(overrides)).expect(201),
    );
  const redeem = (
    account: TestAccount,
    code: string,
    packageCode = 'SMALL',
    key: string | undefined = newKey(),
  ) => as(ctx, account).post(REDEEM, { code, packageCode }, key);

  const offerRow = (id: string) =>
    ctx.client.discountOffer.findUniqueOrThrow({ where: { id } });
  const redemptionRows = (offerId: string) =>
    ctx.client.discountRedemption.findMany({ where: { offerId } });
  /** Everything a rejected redemption must leave untouched. */
  const redemptionState = async (offerId: string) => ({
    count: (await offerRow(offerId)).redemptionCount,
    rows: (await redemptionRows(offerId)).length,
  });
  const auditOf = (offerId: string) =>
    ctx.client.activityLogEvent.findMany({
      where: { tableName: 'DiscountOffer', recordId: offerId },
      orderBy: { createdAt: 'asc' },
      select: {
        action: true,
        actionedBy: true,
        details: {
          select: { fieldName: true, oldValue: true, newValue: true },
          orderBy: { fieldName: 'asc' },
        },
      },
    });

  beforeAll(async () => {
    schema = await createSchema();
    await applyMigrations(schema, migrationNames());
    ctx = await bootApplication({ schema });
    await listen(ctx);
    admin = await createAccount(ctx, userRole.ADMIN);
    superadmin = await createAccount(ctx, userRole.SUPERADMIN);
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
    it('creates a code with its defaults, in upper case, stored in PostgreSQL and audited', async () => {
      const code = `xmas-${randomBytes(3).toString('hex')}`;
      const startsAt = fromNow(-HOUR);
      const endsAt = fromNow(7 * DAY);
      const response = await as(ctx, admin)
        .post(ADMIN, { code, discountPercent: 20, startsAt, endsAt })
        .expect(201);

      const view = dataOf<CodeView>(response);
      expect(view).toEqual({
        id: expect.any(String) as unknown,
        kind: 'CODE',
        code: code.toUpperCase(),
        name: code.toUpperCase(),
        discountPercent: 20,
        active: true,
        status: 'ACTIVE',
        startsAt,
        endsAt,
        audience: 'ALL_USERS',
        targetUserIds: [],
        maxRedemptionsPerUser: 1,
        maxTotalRedemptions: null,
        redemptionCount: 0,
        remainingRedemptions: null,
        createdAt: expect.any(String) as unknown,
        updatedAt: expect.any(String) as unknown,
      });
      await expect(offerRow(view.id)).resolves.toMatchObject({
        kind: 'CODE',
        code: code.toUpperCase(),
        discountPercent: 20,
        active: true,
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
        maxRedemptionsPerUser: 1,
        maxTotalRedemptions: null,
        redemptionCount: 0,
      });
      const [event] = await auditOf(view.id);
      expect(event).toMatchObject({ action: 'create', actionedBy: admin.id });
      expect(event.details).toEqual(
        expect.arrayContaining([
          { fieldName: 'code', oldValue: null, newValue: code.toUpperCase() },
          { fieldName: 'discountPercent', oldValue: null, newValue: '20' },
        ]),
      );
    });

    it('refuses a duplicate code in any letter case and stores nothing', async () => {
      const created = await createCode({ code: uniqueCode('DUP') });
      const before = await ctx.client.discountOffer.count();

      const response = await as(ctx, admin)
        .post(ADMIN, codeBody({ code: created.code.toLowerCase() }))
        .expect(409);

      expect(messageOf(response)).toBe(
        'A discount code with this code already exists',
      );
      await expect(ctx.client.discountOffer.count()).resolves.toBe(before);
    });

    it('lists codes newest first and reads one; campaigns are not reachable through the code routes', async () => {
      const first = await createCode();
      const second = await createCode();
      const campaign = dataOf<{ id: string }>(
        await as(ctx, admin)
          .post('/v1/admin/discount-campaigns', {
            name: 'Not a code',
            discountPercent: 10,
            startsAt: fromNow(-HOUR),
            endsAt: fromNow(DAY),
          })
          .expect(201),
      );

      const list = dataOf<CodeView[]>(
        await as(ctx, admin).get(ADMIN).expect(200),
      );
      const ids = list.map((offer) => offer.id);
      expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
      expect(ids).not.toContain(campaign.id);
      expect(list.every((offer) => offer.kind === 'CODE')).toBe(true);

      await expect(
        as(ctx, admin).get(`${ADMIN}/${first.id}`).expect(200).then(dataOf),
      ).resolves.toEqual(first);
      for (const id of [campaign.id, 'no-such-id']) {
        const missing = await as(ctx, admin).get(`${ADMIN}/${id}`).expect(404);
        expect(messageOf(missing)).toBe('Discount code not found');
        await as(ctx, admin)
          .patch(`${ADMIN}/${id}`, { discountPercent: 50 })
          .expect(404);
        await as(ctx, admin).post(`${ADMIN}/${id}/deactivate`).expect(404);
      }
      await expect(offerRow(campaign.id)).resolves.toMatchObject({
        discountPercent: 10,
        active: true,
      });
    });

    it('changes any subset of fields, never the code, and audits old and new values', async () => {
      const created = await createCode({ discountPercent: 10 });
      const endsAt = fromNow(30 * DAY);

      const response = await as(ctx, admin)
        .patch(`${ADMIN}/${created.id}`, {
          name: 'Winter sale',
          discountPercent: 35,
          endsAt,
          maxRedemptionsPerUser: 2,
          maxTotalRedemptions: 50,
        })
        .expect(200);

      expect(dataOf(response)).toMatchObject({
        code: created.code,
        name: 'Winter sale',
        discountPercent: 35,
        startsAt: created.startsAt,
        endsAt,
        maxRedemptionsPerUser: 2,
        maxTotalRedemptions: 50,
        remainingRedemptions: 50,
        status: 'ACTIVE',
      });
      await as(ctx, admin)
        .patch(`${ADMIN}/${created.id}`, { code: 'RENAMED' })
        .expect(400);
      await expect(offerRow(created.id)).resolves.toMatchObject({
        code: created.code,
        discountPercent: 35,
      });
      const [, update] = await auditOf(created.id);
      expect(update).toEqual({
        action: 'update',
        actionedBy: admin.id,
        details: [
          {
            fieldName: 'discountPercent',
            oldValue: '10',
            newValue: '35',
          },
          {
            fieldName: 'endsAt',
            oldValue: created.endsAt,
            newValue: endsAt,
          },
          {
            fieldName: 'maxRedemptionsPerUser',
            oldValue: '1',
            newValue: '2',
          },
          {
            fieldName: 'maxTotalRedemptions',
            oldValue: null,
            newValue: '50',
          },
          {
            fieldName: 'name',
            oldValue: created.code,
            newValue: 'Winter sale',
          },
        ],
      });
    });

    it('targets selected users (audited as counts) and opens the code to everyone again', async () => {
      const created = await createCode();
      const first = await createAccount(ctx);
      const second = await createAccount(ctx);

      const targeted = dataOf<CodeView>(
        await as(ctx, admin)
          .patch(`${ADMIN}/${created.id}`, {
            targetUserIds: [second.id, first.id],
          })
          .expect(200),
      );
      expect(targeted).toMatchObject({
        audience: 'SELECTED_USERS',
        targetUserIds: [first.id, second.id].sort(),
      });

      const unknown = await as(ctx, admin)
        .patch(`${ADMIN}/${created.id}`, {
          targetUserIds: [first.id, 'no-such-user'],
        })
        .expect(400);
      expect(messageOf(unknown)).toContain('no-such-user');
      await expect(
        ctx.client.discountOfferTarget.count({
          where: { offerId: created.id },
        }),
      ).resolves.toBe(2);

      const open = dataOf<CodeView>(
        await as(ctx, admin)
          .patch(`${ADMIN}/${created.id}`, { targetUserIds: null })
          .expect(200),
      );
      expect(open).toMatchObject({ audience: 'ALL_USERS', targetUserIds: [] });

      const targetChanges = (await auditOf(created.id))
        .flatMap((event) => event.details)
        .filter((detail) => detail.fieldName === 'targetUserIds');
      expect(targetChanges).toEqual([
        {
          fieldName: 'targetUserIds',
          oldValue: '0 user(s)',
          newValue: '2 user(s)',
        },
        {
          fieldName: 'targetUserIds',
          oldValue: '2 user(s)',
          newValue: '0 user(s)',
        },
      ]);
      // The activity log never contains the targeted users' IDs.
      expect(JSON.stringify(await auditOf(created.id))).not.toContain(first.id);
    });

    it('deactivates (idempotently) and reactivates a code; a 0% discount also switches it off', async () => {
      const created = await createCode();

      const off = await as(ctx, admin)
        .post(`${ADMIN}/${created.id}/deactivate`)
        .expect(200);
      expect(dataOf(off)).toMatchObject({ active: false, status: 'INACTIVE' });
      await as(ctx, superadmin)
        .post(`${ADMIN}/${created.id}/deactivate`)
        .expect(200);
      // The second deactivation changed nothing, so it is not audited.
      await expect(auditOf(created.id)).resolves.toHaveLength(2);

      const on = await as(ctx, admin)
        .patch(`${ADMIN}/${created.id}`, { active: true })
        .expect(200);
      expect(dataOf(on)).toMatchObject({ active: true, status: 'ACTIVE' });

      const zero = await as(ctx, admin)
        .patch(`${ADMIN}/${created.id}`, { discountPercent: 0 })
        .expect(200);
      expect(dataOf(zero)).toMatchObject({
        active: true,
        discountPercent: 0,
        status: 'INACTIVE',
      });
      // The row is kept: offers are deactivated, never deleted.
      await expect(offerRow(created.id)).resolves.toMatchObject({
        discountPercent: 0,
      });
    });

    it('reports SCHEDULED, EXPIRED and DEPLETED codes', async () => {
      const scheduled = await createCode({
        startsAt: fromNow(DAY),
        endsAt: fromNow(2 * DAY),
      });
      expect(scheduled.status).toBe('SCHEDULED');

      const limited = await createCode({ maxTotalRedemptions: 1 });
      await redeem(customer, limited.code).expect(201);
      await expect(
        as(ctx, admin).get(`${ADMIN}/${limited.id}`).then(dataOf),
      ).resolves.toMatchObject({
        status: 'DEPLETED',
        redemptionCount: 1,
        remainingRedemptions: 0,
      });

      freezeTime(new Date(scheduled.endsAt));
      await expect(
        as(ctx, admin).get(`${ADMIN}/${scheduled.id}`).then(dataOf),
      ).resolves.toMatchObject({ status: 'EXPIRED' });
    });

    it.each([
      ['a negative discount', { discountPercent: -1 }],
      ['a discount above 100%', { discountPercent: 101 }],
      ['a fractional discount', { discountPercent: 12.5 }],
      ['a discount as a string', { discountPercent: '20' }],
      ['a null discount', { discountPercent: null }],
      ['a missing discount', { discountPercent: undefined }],
      ['a too short code', { code: 'AB' }],
      ['a code with spaces', { code: 'HAPPY HOLIDAYS' }],
      ['a missing code', { code: undefined }],
      ['a missing start', { startsAt: undefined }],
      ['a date-time without a time zone', { startsAt: '2026-12-20T10:00:00' }],
      ['an impossible date', { endsAt: '2027-02-30' }],
      [
        'an end before the start',
        { startsAt: fromNow(2 * DAY), endsAt: fromNow(DAY) },
      ],
      [
        'an end equal to the start',
        { startsAt: fromNow(DAY), endsAt: fromNow(DAY) },
      ],
      [
        'an end in the past',
        { startsAt: fromNow(-2 * DAY), endsAt: fromNow(-DAY) },
      ],
      ['a zero per-user limit', { maxRedemptionsPerUser: 0 }],
      ['a fractional per-user limit', { maxRedemptionsPerUser: 1.5 }],
      ['a zero total limit', { maxTotalRedemptions: 0 }],
      ['a negative total limit', { maxTotalRedemptions: -10 }],
      ['an empty target list', { targetUserIds: [] }],
      ['an unknown targeted user', { targetUserIds: ['no-such-user'] }],
      ['a blank name', { name: '  ' }],
      ['a redemption count', { redemptionCount: 5 }],
      ['a kind', { kind: 'CAMPAIGN' }],
    ])(
      'rejects creating a code with %s and stores nothing',
      async (_case, change) => {
        const before = await ctx.client.discountOffer.count();

        const response = await as(ctx, admin)
          .post(ADMIN, codeBody(change))
          .expect(400);

        expect(response.body).toMatchObject({
          success: false,
          statusCode: 400,
        });
        await expect(ctx.client.discountOffer.count()).resolves.toBe(before);
      },
    );

    it.each([
      ['an empty body', {}, 400],
      ['a null discount', { discountPercent: null }, 400],
      ['a discount above 100%', { discountPercent: 150 }, 400],
      ['an end before the start', { endsAt: fromNow(-2 * DAY) }, 400],
      ['a code', { code: 'OTHER' }, 400],
      [
        'a total limit below the redemptions made',
        { maxTotalRedemptions: 1 },
        409,
      ],
    ])(
      'rejects changing a code with %s and changes nothing',
      async (_case, body, status) => {
        const created = await createCode({ maxRedemptionsPerUser: 2 });
        await redeem(customer, created.code).expect(201);
        await redeem(customer, created.code).expect(201);
        const before = await offerRow(created.id);

        await as(ctx, admin)
          .patch(`${ADMIN}/${created.id}`, body)
          .expect(status);

        await expect(offerRow(created.id)).resolves.toEqual(before);
      },
    );
  });

  describe('permissions', () => {
    it('refuses unauthenticated requests to every route and changes nothing', async () => {
      const created = await createCode();
      const before = await offerRow(created.id);
      const offers = await ctx.client.discountOffer.count();

      await as(ctx).post(ADMIN, codeBody()).expect(401);
      await as(ctx).get(ADMIN).expect(401);
      await as(ctx).get(`${ADMIN}/${created.id}`).expect(401);
      await as(ctx)
        .patch(`${ADMIN}/${created.id}`, { discountPercent: 90 })
        .expect(401);
      await as(ctx).post(`${ADMIN}/${created.id}/deactivate`).expect(401);
      await as(ctx)
        .post(REDEEM, { code: created.code, packageCode: 'SMALL' }, newKey())
        .expect(401);
      await request(ctx.app.getHttpServer())
        .get(ADMIN)
        .set('X-Forwarded-For', nextTestIp())
        .set('Authorization', 'Bearer not-a-jwt')
        .expect(401);

      await expect(offerRow(created.id)).resolves.toEqual(before);
      await expect(ctx.client.discountOffer.count()).resolves.toBe(offers);
      await expect(redemptionState(created.id)).resolves.toEqual({
        count: 0,
        rows: 0,
      });
    });

    it.each([
      ['USER', () => customer],
      ['MODERATOR', () => moderator],
    ])(
      'a %s can neither create, view, change nor deactivate codes',
      async (_role, account) => {
        const created = await createCode();
        const before = await offerRow(created.id);
        const offers = await ctx.client.discountOffer.count();

        await as(ctx, account()).post(ADMIN, codeBody()).expect(403);
        const list = await as(ctx, account()).get(ADMIN).expect(403);
        expect(JSON.stringify(list.body)).not.toContain(created.code);
        await as(ctx, account()).get(`${ADMIN}/${created.id}`).expect(403);
        await as(ctx, account())
          .patch(`${ADMIN}/${created.id}`, {
            discountPercent: 100,
            maxTotalRedemptions: 1_000_000,
          })
          .expect(403);
        await as(ctx, account())
          .post(`${ADMIN}/${created.id}/deactivate`)
          .expect(403);

        await expect(offerRow(created.id)).resolves.toEqual(before);
        await expect(ctx.client.discountOffer.count()).resolves.toBe(offers);
      },
    );

    it('a SUPERADMIN signed in through the login route manages codes', async () => {
      const signedIn = await signInWithRole(
        ctx,
        userRole.SUPERADMIN,
        nextTestIp(),
      );
      const server = () => request(ctx.app.getHttpServer());
      const created = dataOf<CodeView>(
        await server()
          .post(ADMIN)
          .set('X-Forwarded-For', nextTestIp())
          .set('Authorization', `Bearer ${signedIn.accessToken}`)
          .send(codeBody())
          .expect(201),
      );
      await server()
        .post(`${ADMIN}/${created.id}/deactivate`)
        .set('X-Forwarded-For', nextTestIp())
        .set('Authorization', `Bearer ${signedIn.accessToken}`)
        .expect(200);
      const events = await auditOf(created.id);
      expect(events.map((e) => [e.action, e.actionedBy])).toEqual([
        ['create', signedIn.id],
        ['update', signedIn.id],
      ]);
    });
  });

  describe('redemption', () => {
    it('redeems a code for a credit package at the discounted price and counts it once', async () => {
      const created = await createCode({ discountPercent: 20 });

      const response = await redeem(customer, created.code, 'SMALL').expect(
        201,
      );

      const redemption = dataOf<RedemptionView>(response);
      expect(redemption).toEqual({
        id: expect.any(String) as unknown,
        offerId: created.id,
        kind: 'CODE',
        code: created.code,
        name: created.name,
        packageCode: 'SMALL',
        credits: 250,
        currency: 'USD',
        discountPercent: 20,
        originalPriceUsdCents: 500,
        discountUsdCents: 100,
        finalPriceUsdCents: 400,
        finalPriceUsd: '4.00',
        redeemedAt: expect.any(String) as unknown,
        replayed: false,
      });
      await expect(redemptionRows(created.id)).resolves.toEqual([
        expect.objectContaining({
          id: redemption.id,
          authId: customer.id,
          packageCode: 'SMALL',
          credits: 250,
          discountPercent: 20,
          originalPriceUsdCents: 500,
          discountUsdCents: 100,
          finalPriceUsdCents: 400,
        }),
      ]);
      await expect(redemptionState(created.id)).resolves.toEqual({
        count: 1,
        rows: 1,
      });
    });

    it('accepts the code in any letter case and uses the configured package terms', async () => {
      const created = await createCode({ discountPercent: 25 });
      await as(ctx, admin)
        .patch('/v1/admin/credit-package-settings/MEDIUM', {
          priceUsdCents: 1200,
          credits: 650,
        })
        .expect(200);
      try {
        const response = await redeem(
          customer,
          ` ${created.code.toLowerCase()} `,
          'MEDIUM',
        ).expect(201);
        expect(dataOf(response)).toMatchObject({
          credits: 650,
          originalPriceUsdCents: 1200,
          discountUsdCents: 300,
          finalPriceUsdCents: 900,
          finalPriceUsd: '9.00',
        });
      } finally {
        await as(ctx, admin)
          .patch('/v1/admin/credit-package-settings/MEDIUM', {
            priceUsdCents: 1000,
            credits: 500,
          })
          .expect(200);
      }
    });

    const expectRejected = async (
      offerId: string,
      response: request.Response,
      status: number,
      message: string,
      before: { count: number; rows: number },
    ) => {
      expect(response.status).toBe(status);
      expect(response.body).toMatchObject({
        success: false,
        statusCode: status,
        message,
      });
      await expect(redemptionState(offerId)).resolves.toEqual(before);
    };

    it('rejects an unknown code', async () => {
      const response = await redeem(customer, 'NO-SUCH-CODE').expect(404);
      expect(messageOf(response)).toBe('Discount code not found');
    });

    it('rejects a deactivated code and a 0% code, and nothing is counted', async () => {
      const off = await createCode();
      await as(ctx, admin).post(`${ADMIN}/${off.id}/deactivate`).expect(200);
      await expectRejected(
        off.id,
        await redeem(customer, off.code),
        409,
        'This discount is not active',
        { count: 0, rows: 0 },
      );

      const zero = await createCode({ discountPercent: 0 });
      expect(zero.status).toBe('INACTIVE');
      await expectRejected(
        zero.id,
        await redeem(customer, zero.code),
        409,
        'This discount is not active',
        { count: 0, rows: 0 },
      );
    });

    it('rejects a code before its start and from its exact end; it is redeemable in between', async () => {
      const startsAt = new Date(Date.now() + DAY);
      startsAt.setUTCMilliseconds(0);
      const endsAt = new Date(startsAt.getTime() + DAY);
      const created = await createCode({
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        maxRedemptionsPerUser: 5,
      });

      freezeTime(new Date(startsAt.getTime() - 1));
      await expectRejected(
        created.id,
        await redeem(customer, created.code),
        409,
        'This discount has not started yet',
        { count: 0, rows: 0 },
      );
      freezeTime(startsAt);
      await redeem(customer, created.code).expect(201);
      freezeTime(new Date(endsAt.getTime() - 1));
      await redeem(customer, created.code).expect(201);
      freezeTime(endsAt);
      await expectRejected(
        created.id,
        await redeem(customer, created.code),
        409,
        'This discount has expired',
        { count: 2, rows: 2 },
      );
    });

    it('lets only the targeted users redeem a targeted code', async () => {
      const invited = await createAccount(ctx);
      const outsider = await createAccount(ctx);
      const created = await createCode({ targetUserIds: [invited.id] });

      await expectRejected(
        created.id,
        await redeem(outsider, created.code),
        403,
        'This discount is not available for your account',
        { count: 0, rows: 0 },
      );
      await redeem(invited, created.code).expect(201);
      await expect(redemptionState(created.id)).resolves.toEqual({
        count: 1,
        rows: 1,
      });
    });

    it('allows each user up to maxRedemptionsPerUser redemptions', async () => {
      const created = await createCode({ maxRedemptionsPerUser: 2 });
      const other = await createAccount(ctx);

      await redeem(customer, created.code).expect(201);
      await redeem(customer, created.code, 'LARGE').expect(201);
      await expectRejected(
        created.id,
        await redeem(customer, created.code),
        409,
        'You have already redeemed this discount the maximum number of times',
        { count: 2, rows: 2 },
      );
      // Other users have their own allowance.
      await redeem(other, created.code).expect(201);
    });

    it('rejects a depleted code for everyone', async () => {
      const created = await createCode({ maxTotalRedemptions: 2 });
      await redeem(await createAccount(ctx), created.code).expect(201);
      await redeem(await createAccount(ctx), created.code).expect(201);

      await expectRejected(
        created.id,
        await redeem(customer, created.code),
        409,
        'This discount has no redemptions left',
        { count: 2, rows: 2 },
      );
    });

    it('rejects an unavailable package, an unknown package and a missing Idempotency-Key', async () => {
      const created = await createCode();
      await as(ctx, admin)
        .patch('/v1/admin/credit-package-settings/LARGE', { available: false })
        .expect(200);
      try {
        await expectRejected(
          created.id,
          await redeem(customer, created.code, 'LARGE'),
          409,
          'This credit package is not available',
          { count: 0, rows: 0 },
        );
      } finally {
        await as(ctx, admin)
          .patch('/v1/admin/credit-package-settings/LARGE', { available: true })
          .expect(200);
      }
      await redeem(customer, created.code, 'HUGE').expect(400);
      // Without the header at all:
      await expectRejected(
        created.id,
        await as(ctx, customer).post(REDEEM, {
          code: created.code,
          packageCode: 'SMALL',
        }),
        400,
        'An Idempotency-Key header of 1-200 characters is required',
        { count: 0, rows: 0 },
      );
      for (const key of ['', '   ', 'k'.repeat(201)]) {
        await expectRejected(
          created.id,
          await redeem(customer, created.code, 'SMALL', key),
          400,
          'An Idempotency-Key header of 1-200 characters is required',
          { count: 0, rows: 0 },
        );
      }
      await as(ctx, customer)
        .post(REDEEM, { code: created.code }, newKey())
        .expect(400);
    });
  });

  describe('idempotency and concurrency', () => {
    it('returns the original redemption for a repeated Idempotency-Key and counts it once', async () => {
      const created = await createCode({ maxRedemptionsPerUser: 3 });
      const key = newKey();

      const first = dataOf<RedemptionView>(
        await redeem(customer, created.code, 'SMALL', key).expect(201),
      );
      const again = dataOf<RedemptionView>(
        await redeem(customer, created.code, 'SMALL', key).expect(201),
      );
      expect(again).toEqual({ ...first, replayed: true });

      // Even after the code was switched off, the retry gets its result.
      await as(ctx, admin)
        .post(`${ADMIN}/${created.id}/deactivate`)
        .expect(200);
      const late = dataOf<RedemptionView>(
        await redeem(customer, created.code, 'SMALL', key).expect(201),
      );
      expect(late).toEqual({ ...first, replayed: true });

      // The same key for a different request is refused.
      await as(ctx, admin)
        .patch(`${ADMIN}/${created.id}`, { active: true })
        .expect(200);
      const reused = await redeem(customer, created.code, 'LARGE', key).expect(
        409,
      );
      expect(messageOf(reused)).toBe(
        'The idempotency key was already used for another redemption',
      );
      await expect(redemptionState(created.id)).resolves.toEqual({
        count: 1,
        rows: 1,
      });
    });

    it('stores and counts concurrent duplicates of one request once', async () => {
      const created = await createCode({ maxRedemptionsPerUser: 5 });
      const key = newKey();

      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          redeem(customer, created.code, 'SMALL', key),
        ),
      );

      expect(responses.map((r) => r.status)).toEqual(Array(10).fill(201));
      const views = responses.map((r) => dataOf<RedemptionView>(r));
      expect(new Set(views.map((v) => v.id)).size).toBe(1);
      expect(views.filter((v) => !v.replayed)).toHaveLength(1);
      await expect(redemptionState(created.id)).resolves.toEqual({
        count: 1,
        rows: 1,
      });
    });

    it('never exceeds the total limit under concurrent redemptions by many users', async () => {
      const created = await createCode({ maxTotalRedemptions: 5 });
      const users = await Promise.all(
        Array.from({ length: 20 }, () => createAccount(ctx)),
      );

      const responses = await Promise.all(
        users.map((user) => redeem(user, created.code)),
      );

      const statuses = responses.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(5);
      expect(statuses.filter((s) => s === 409)).toHaveLength(15);
      for (const rejected of responses.filter((r) => r.status === 409)) {
        expect(messageOf(rejected)).toBe(
          'This discount has no redemptions left',
        );
      }
      await expect(redemptionState(created.id)).resolves.toEqual({
        count: 5,
        rows: 5,
      });
      const rows = await redemptionRows(created.id);
      expect(new Set(rows.map((r) => r.authId)).size).toBe(5);
    });

    it('never exceeds the per-user limit under concurrent redemptions by one user', async () => {
      const created = await createCode({ maxRedemptionsPerUser: 3 });
      const user = await createAccount(ctx);

      const responses = await Promise.all(
        Array.from({ length: 12 }, () => redeem(user, created.code)),
      );

      const statuses = responses.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(3);
      expect(statuses.filter((s) => s === 409)).toHaveLength(9);
      await expect(redemptionState(created.id)).resolves.toEqual({
        count: 3,
        rows: 3,
      });
    });

    it('keeps the limit consistent when an administrator lowers it during concurrent redemptions', async () => {
      const created = await createCode({ maxTotalRedemptions: 10 });
      const users = await Promise.all(
        Array.from({ length: 10 }, () => createAccount(ctx)),
      );

      const [change, ...redemptions] = await Promise.all([
        as(ctx, admin).patch(`${ADMIN}/${created.id}`, {
          maxTotalRedemptions: 4,
        }),
        ...users.map((user) => redeem(user, created.code)),
      ]);

      const row = await offerRow(created.id);
      const succeeded = redemptions.filter((r) => r.status === 201).length;
      expect(row.redemptionCount).toBe(succeeded);
      await expect(redemptionRows(created.id)).resolves.toHaveLength(succeeded);
      expect(row.redemptionCount).toBeLessThanOrEqual(
        row.maxTotalRedemptions ?? 0,
      );
      if (change.status === 200) {
        expect(row.maxTotalRedemptions).toBe(4);
      } else {
        // Refused because more than 4 were already redeemed.
        expect(change.status).toBe(409);
        expect(row.maxTotalRedemptions).toBe(10);
        expect(succeeded).toBeGreaterThan(4);
      }
      expect(redemptions.every((r) => [201, 409].includes(r.status))).toBe(
        true,
      );
    });

    it('has PostgreSQL refuse redemptions beyond the limits and changes to the count made outside the API', async () => {
      const created = await createCode({ maxTotalRedemptions: 1 });
      await redeem(customer, created.code).expect(201);
      const other = await createAccount(ctx);
      const row = {
        offerId: created.id,
        packageCode: 'SMALL' as const,
        credits: 250,
        discountPercent: 20,
        originalPriceUsdCents: 500,
        discountUsdCents: 100,
        finalPriceUsdCents: 400,
        redeemedAt: new Date(),
      };

      await expect(
        ctx.client.discountRedemption.create({
          data: { ...row, authId: other.id, idempotencyKey: newKey() },
        }),
      ).rejects.toThrow('no redemptions left');
      await expect(
        ctx.client.discountRedemption.create({
          data: { ...row, authId: customer.id, idempotencyKey: newKey() },
        }),
      ).rejects.toThrow('redemption limit');
      await expect(
        ctx.client.discountOffer.update({
          where: { id: created.id },
          data: { redemptionCount: 0 },
        }),
      ).rejects.toThrow('cannot decrease');
      await expect(
        ctx.client.discountOffer.update({
          where: { id: created.id },
          data: { code: 'CHANGED' },
        }),
      ).rejects.toThrow('cannot change');
      await expect(
        ctx.client.discountRedemption.updateMany({
          where: { offerId: created.id },
          data: { finalPriceUsdCents: 1 },
        }),
      ).rejects.toThrow('cannot be changed');

      await expect(redemptionState(created.id)).resolves.toEqual({
        count: 1,
        rows: 1,
      });
    });
  });

  describe('persistence', () => {
    it('keeps codes, redemptions and limits across an application restart', async () => {
      const created = await createCode({
        maxRedemptionsPerUser: 1,
        maxTotalRedemptions: 3,
      });
      const key = newKey();
      const first = dataOf<RedemptionView>(
        await redeem(customer, created.code, 'SMALL', key).expect(201),
      );
      const offerBefore = await offerRow(created.id);

      await ctx.close();
      ctx = await bootApplication({ schema });
      await listen(ctx);

      await expect(offerRow(created.id)).resolves.toEqual(offerBefore);
      await expect(
        as(ctx, admin).get(`${ADMIN}/${created.id}`).then(dataOf),
      ).resolves.toMatchObject({ redemptionCount: 1, remainingRedemptions: 2 });
      // The retry is still recognized, and the per-user limit still holds.
      await expect(
        redeem(customer, created.code, 'SMALL', key).expect(201).then(dataOf),
      ).resolves.toEqual({ ...first, replayed: true });
      await redeem(customer, created.code).expect(409);
      await expect(redemptionState(created.id)).resolves.toEqual({
        count: 1,
        rows: 1,
      });
    });
  });
});
