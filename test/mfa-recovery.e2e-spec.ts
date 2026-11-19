// Must be first: fixes the environment (REDIS_ENABLED=false, secrets) before
// any application module reads it. MFA state is PostgreSQL-only.
import './support/env-postgres-mode';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { createHash } from 'node:crypto';
import type { Logger } from 'winston';
import { hashRecoveryCode } from '../src/auth/mfa/mfa-recovery-codes';
import { totpCode, totpStep } from '../src/auth/mfa/mfa-totp';
import type {
  MfaRecoveryCodesView,
  MfaVerificationView,
} from '../src/auth/mfa/mfa-verification.service';
import type {
  MfaEnabledView,
  MfaStatusView,
} from '../src/auth/mfa/mfa.service';
import { CustomLoggerService } from '../src/common/services/custom-logger.service';
import { freezeTime } from './support/freeze-time';
import {
  bootApplication,
  type TestApplication,
} from './support/infrastructure-flows';
import {
  dataOf,
  messageOf,
  MfaTestKit,
  MIN,
  SECOND,
  type TestUser,
} from './support/mfa-e2e';
import { describeWithDatabase } from './support/migrated-schema';

jest.setTimeout(120_000);

const DISPLAY_FORM =
  /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;

/**
 * MFA recovery codes through the real endpoints of the whole application on
 * a temporary, freshly migrated PostgreSQL schema: generation when MFA is
 * enabled, storage as keyed hashes, one-time display, verification with a
 * recovery code instead of the authenticator code, consumption recorded in
 * PostgreSQL (including concurrent use), regeneration, and ownership.
 */
describeWithDatabase('MFA recovery codes (e2e, PostgreSQL)', () => {
  let ctx: TestApplication;
  let kit: MfaTestKit;
  /** Every code shown by the API during this suite. */
  const shownCodes = new Set<string>();
  /** Everything the application logged during this suite. */
  const logged: unknown[][] = [];

  beforeAll(async () => {
    ctx = await bootApplication();
    kit = new MfaTestKit(ctx, '198.19');
    freezeTime(kit.clock);
    kit.nextStepStart();

    // Capture every log call of the application, whatever its level.
    const capture = (...args: unknown[]) => {
      logged.push(args);
    };
    const winston = ctx.get<Logger>(WINSTON_MODULE_PROVIDER);
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      const original = winston[level].bind(winston) as (
        ...a: unknown[]
      ) => unknown;
      jest.spyOn(winston, level).mockImplementation(((...args: unknown[]) => {
        capture(...args);
        return original(...args);
      }) as never);
    }
    const custom = ctx.get<CustomLoggerService>(CustomLoggerService);
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(custom, level).mockImplementation(capture as never);
    }
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(console, level).mockImplementation(capture);
    }
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    await ctx?.close();
  });

  beforeEach(() => kit.nextStepStart(60 * MIN));

  /** Enables MFA over HTTP and remembers the codes it showed. */
  async function enable(user: TestUser) {
    const enabled = await kit.enableMfa(user);
    enabled.recoveryCodes.forEach((code) => shownCodes.add(code));
    return enabled;
  }

  const codesOf = (user: TestUser) =>
    ctx.client.mfaRecoveryCode.findMany({
      where: { authId: user.id },
      orderBy: { codeHash: 'asc' },
    });
  const hashOf = (user: TestUser, code: string) =>
    hashRecoveryCode(user.id, code);
  const useRecovery = (user: TestUser, recoveryCode: string) =>
    kit.verify(user, { recoveryCode });

  describe('generation and secure storage', () => {
    it('issues ten unique codes when MFA is enabled, stored only as keyed hashes', async () => {
      const user = await kit.createUser();
      expect(await codesOf(user)).toEqual([]);

      const { recoveryCodes, response } = await enable(user);

      // Shown in the enrollment confirmation, uncacheable.
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['pragma']).toBe('no-cache');
      expect(dataOf<MfaEnabledView>(response)).toMatchObject({
        enabled: true,
        method: 'totp',
        recoveryCodesRemaining: 10,
      });
      expect(recoveryCodes).toHaveLength(10);
      expect(new Set(recoveryCodes).size).toBe(10);
      for (const code of recoveryCodes) expect(code).toMatch(DISPLAY_FORM);

      // PostgreSQL holds exactly ten unused rows: the keyed hash of each code.
      const stored = await codesOf(user);
      expect(stored).toHaveLength(10);
      expect(stored.every((row) => row.usedAt === null)).toBe(true);
      expect(stored.map((row) => row.codeHash).sort()).toEqual(
        recoveryCodes.map((code) => hashOf(user, code)).sort(),
      );
      for (const { codeHash } of stored) {
        expect(codeHash).toMatch(/^[0-9a-f]{64}$/);
      }
      // Not an unkeyed hash either: without the server key nothing can be
      // matched offline.
      for (const code of recoveryCodes) {
        for (const form of [code, code.replace('-', '')]) {
          expect(stored.map((row) => row.codeHash)).not.toContain(
            createHash('sha256').update(form).digest('hex'),
          );
        }
      }
      // No plaintext in any MFA table or audit entry of the user (SQL level).
      const { rows } = {
        rows: await ctx.client.$queryRaw<{ row: string }[]>`
          SELECT row_to_json(c)::text AS row FROM "MfaRecoveryCode" c WHERE c."authId" = ${user.id}
          UNION ALL
          SELECT row_to_json(s)::text FROM "authSecurity" s WHERE s."authId" = ${user.id}
          UNION ALL
          SELECT row_to_json(d)::text FROM "ActivityLogEventDetail" d
            JOIN "ActivityLogEvent" e ON e."id" = d."eventId"
            WHERE e."recordId" = ${user.id}`,
      };
      const everything = rows.map((r) => r.row).join('\n');
      for (const code of recoveryCodes) {
        expect(everything).not.toContain(code);
        expect(everything).not.toContain(code.replace('-', ''));
        expect(everything.toUpperCase()).not.toContain(code.replace('-', ''));
      }
    });

    it('shows the codes only once: no later response contains them', async () => {
      const user = await kit.createUser();
      const { recoveryCodes, secret } = await enable(user);
      kit.advance(30 * SECOND);

      const later = [
        await kit.getStatus(user).expect(200),
        await useRecovery(user, recoveryCodes[0]).expect(200),
        await kit
          .verify(user, { code: totpCode(secret, kit.clock) })
          .expect(200),
        await useRecovery(user, recoveryCodes[0]).expect(400),
        // Confirming again cannot show them again.
        await kit.confirm(user, totpCode(secret, kit.clock)).expect(409),
        await kit.start(user).expect(409),
      ];

      for (const response of later) {
        const body = JSON.stringify(response.body);
        for (const code of recoveryCodes) {
          expect(body).not.toContain(code);
          expect(body).not.toContain(code.replace('-', ''));
        }
      }
      expect(dataOf<MfaStatusView>(later[0]).recoveryCodesRemaining).toBe(10);
      expect(dataOf<MfaVerificationView>(later[1])).toEqual({
        verified: true,
        method: 'recovery_code',
        recoveryCodesRemaining: 9,
      });
    });
  });

  describe('verification with a recovery code', () => {
    it('verifies instead of the authenticator code and records the consumption', async () => {
      const user = await kit.createUser();
      const { recoveryCodes } = await enable(user);
      kit.advance(MIN);
      const usedAt = kit.clock;

      const response = await useRecovery(user, recoveryCodes[4]).expect(200);

      expect(dataOf<MfaVerificationView>(response)).toEqual({
        verified: true,
        method: 'recovery_code',
        recoveryCodesRemaining: 9,
      });
      // PostgreSQL records exactly this code as used, at this time.
      const stored = await codesOf(user);
      expect(stored.filter((row) => row.usedAt)).toEqual([
        expect.objectContaining({
          codeHash: hashOf(user, recoveryCodes[4]),
          usedAt,
        }),
      ]);
      // Audited as a count, never the code.
      const audit = await ctx.client.activityLogEventDetail.findFirstOrThrow({
        where: {
          fieldName: 'mfaRecoveryCodesRemaining',
          event: { recordId: user.id },
        },
      });
      expect(audit).toMatchObject({ oldValue: '10', newValue: '9' });
      expect(
        dataOf<MfaStatusView>(await kit.getStatus(user)).recoveryCodesRemaining,
      ).toBe(9);
    });

    it('accepts the code in lower case or without the hyphen', async () => {
      const user = await kit.createUser();
      const { recoveryCodes } = await enable(user);

      await useRecovery(user, recoveryCodes[0].toLowerCase()).expect(200);
      await useRecovery(user, recoveryCodes[1].replace('-', '')).expect(200);
      expect((await codesOf(user)).filter((row) => row.usedAt)).toHaveLength(2);
    });

    it('leaves the other codes usable: each of the ten works exactly once', async () => {
      const user = await kit.createUser();
      const { recoveryCodes } = await enable(user);

      for (const [i, code] of recoveryCodes.entries()) {
        kit.advance(SECOND);
        const response = await useRecovery(user, code).expect(200);
        expect(
          dataOf<MfaVerificationView>(response).recoveryCodesRemaining,
        ).toBe(9 - i);
      }

      const stored = await codesOf(user);
      expect(stored.every((row) => row.usedAt !== null)).toBe(true);
      // Consumption times are distinct: one row per use.
      expect(new Set(stored.map((row) => row.usedAt!.getTime())).size).toBe(10);
    });

    it('rejects a reused code and keeps its recorded consumption', async () => {
      const user = await kit.createUser();
      const { recoveryCodes } = await enable(user);
      await useRecovery(user, recoveryCodes[0]).expect(200);
      const [before] = (await codesOf(user)).filter((row) => row.usedAt);

      kit.advance(5 * MIN);
      const response = await useRecovery(user, recoveryCodes[0]).expect(400);

      expect(messageOf(response)).toBe(
        'Invalid MFA code. 4 attempt(s) remaining.',
      );
      const [after] = (await codesOf(user)).filter((row) => row.usedAt);
      expect(after).toEqual(before);
      expect((await codesOf(user)).filter((row) => !row.usedAt)).toHaveLength(
        9,
      );
    });

    it('accepts exactly one of concurrent requests with the same code', async () => {
      const user = await kit.createUser();
      const { recoveryCodes } = await enable(user);

      // Five at once: one wins; the other four find the code used. (Each
      // decline counts toward the 5-in-15-minutes lockout, so a sixth would
      // be answered 429.)
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => useRecovery(user, recoveryCodes[0])),
      );

      expect(responses.map((r) => r.status).sort()).toEqual([
        200, 400, 400, 400, 400,
      ]);
      expect(
        responses
          .filter((r) => r.status === 400)
          .map(messageOf)
          .sort(),
      ).toEqual([
        'Invalid MFA code. 1 attempt(s) remaining.',
        'Invalid MFA code. 2 attempt(s) remaining.',
        'Invalid MFA code. 3 attempt(s) remaining.',
        'Invalid MFA code. 4 attempt(s) remaining.',
      ]);
      const used = (await codesOf(user)).filter((row) => row.usedAt);
      expect(used).toHaveLength(1);
      expect(used[0].codeHash).toBe(hashOf(user, recoveryCodes[0]));
      expect(
        await ctx.client.activityLogEventDetail.count({
          where: {
            fieldName: 'mfaRecoveryCodesRemaining',
            event: { recordId: user.id },
          },
        }),
      ).toBe(1);
    });

    it('accepts concurrent requests with different codes', async () => {
      const user = await kit.createUser();
      const { recoveryCodes } = await enable(user);

      const responses = await Promise.all(
        recoveryCodes.slice(0, 5).map((code) => useRecovery(user, code)),
      );

      expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      expect((await codesOf(user)).filter((row) => !row.usedAt)).toHaveLength(
        5,
      );
    });

    it('rejects codes that were never issued, without consuming any', async () => {
      const user = await kit.createUser();
      const { recoveryCodes } = await enable(user);
      // A valid-looking code that is not one of the user's.
      const unknown = 'ABCDE-FGHJK';
      expect(recoveryCodes).not.toContain(unknown);

      await useRecovery(user, unknown).expect(400);
      // Malformed codes fail validation and are not even counted.
      await useRecovery(user, 'ABCD-EFGHJK').expect(400);
      await useRecovery(user, `${recoveryCodes[0]}X`).expect(400);

      expect((await codesOf(user)).every((row) => !row.usedAt)).toBe(true);
      expect(
        (
          await ctx.client.authSecurity.findUniqueOrThrow({
            where: { authId: user.id },
          })
        ).mfaFailedAttemptsAt,
      ).toHaveLength(1);
    });

    it('still verifies with the authenticator app, each code once', async () => {
      const user = await kit.createUser();
      const { secret } = await enable(user);
      kit.advance(30 * SECOND);
      const code = totpCode(secret, kit.clock);

      const response = await kit.verify(user, { code }).expect(200);

      expect(dataOf<MfaVerificationView>(response)).toEqual({
        verified: true,
        method: 'totp',
        recoveryCodesRemaining: 10,
      });
      expect(
        (
          await ctx.client.authSecurity.findUniqueOrThrow({
            where: { authId: user.id },
          })
        ).mfaLastUsedStep,
      ).toBe(totpStep(kit.clock));
      // Used codes and expired codes are declined; recovery codes untouched.
      await kit.verify(user, { code }).expect(400);
      kit.advance(30 * SECOND);
      await kit.verify(user, { code }).expect(400);
      expect((await codesOf(user)).every((row) => !row.usedAt)).toBe(true);
    });

    it('blocks verification after 5 incorrect codes in 15 minutes, without consuming codes', async () => {
      const user = await kit.createUser();
      const { recoveryCodes } = await enable(user);

      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        statuses.push((await useRecovery(user, 'ABCDE-FGHJK')).status);
      }
      expect(statuses).toEqual([400, 400, 400, 400, 429]);

      // A valid code is refused while blocked and stays unused.
      const blocked = await useRecovery(user, recoveryCodes[0]).expect(429);
      expect(messageOf(blocked)).toContain('MFA verification is blocked until');
      expect((await codesOf(user)).every((row) => !row.usedAt)).toBe(true);

      kit.advance(15 * MIN);
      await kit.signIn(user);
      await useRecovery(user, recoveryCodes[0]).expect(200);
    });

    it('is refused while MFA is not enabled', async () => {
      const user = await kit.createUser();
      const response = await useRecovery(user, 'ABCDE-FGHJK').expect(409);
      expect(messageOf(response)).toBe('MFA is not enabled for this account');
    });
  });

  describe('regeneration', () => {
    it('replaces every previous code with ten new ones, shown once', async () => {
      const user = await kit.createUser();
      const { recoveryCodes: old, secret } = await enable(user);
      await useRecovery(user, old[0]).expect(200);
      const oldRows = await codesOf(user);
      kit.advance(30 * SECOND);

      const response = await kit
        .regenerate(user, { code: totpCode(secret, kit.clock) })
        .expect(201);

      expect(response.headers['cache-control']).toBe('no-store');
      const view = dataOf<MfaRecoveryCodesView>(response);
      view.recoveryCodes.forEach((code) => shownCodes.add(code));
      expect(view.recoveryCodesRemaining).toBe(10);
      expect(view.recoveryCodes).toHaveLength(10);
      expect(new Set(view.recoveryCodes).size).toBe(10);
      expect(view.recoveryCodes.some((code) => old.includes(code))).toBe(false);

      // PostgreSQL holds exactly the ten new hashes; every old row is gone,
      // used or not.
      const stored = await codesOf(user);
      expect(stored.map((row) => row.codeHash).sort()).toEqual(
        view.recoveryCodes.map((code) => hashOf(user, code)).sort(),
      );
      expect(stored.every((row) => row.usedAt === null)).toBe(true);
      const oldIds = new Set(oldRows.map((row) => row.id));
      expect(stored.some((row) => oldIds.has(row.id))).toBe(false);

      // All previous codes are declined (used and unused alike).
      for (const code of old.slice(0, 4)) {
        await useRecovery(user, code).expect(400);
      }
      expect((await codesOf(user)).every((row) => !row.usedAt)).toBe(true);
      // The new ones work.
      await useRecovery(user, view.recoveryCodes[0]).expect(200);
      // And they are never shown again.
      const status = await kit.getStatus(user).expect(200);
      for (const code of view.recoveryCodes) {
        expect(JSON.stringify(status.body)).not.toContain(code);
      }
    });

    it('can be proven with a recovery code, which is consumed by it', async () => {
      const user = await kit.createUser();
      const { recoveryCodes: old } = await enable(user);

      const view = dataOf<MfaRecoveryCodesView>(
        await kit.regenerate(user, { recoveryCode: old[0] }).expect(201),
      );
      view.recoveryCodes.forEach((code) => shownCodes.add(code));

      await useRecovery(user, old[0]).expect(400);
      await useRecovery(user, old[1]).expect(400);
      expect(await codesOf(user)).toHaveLength(10);
    });

    it('changes nothing without a valid second factor', async () => {
      const user = await kit.createUser();
      const { recoveryCodes } = await enable(user);
      const before = await codesOf(user);

      await kit.regenerate(user, {}).expect(400);
      await kit.regenerate(user, { recoveryCode: 'ABCDE-FGHJK' }).expect(400);
      await kit.regenerate(user, { code: '000000' }).expect(400);

      expect(await codesOf(user)).toEqual(before);
      await useRecovery(user, recoveryCodes[0]).expect(200);
    });
  });

  describe('ownership', () => {
    it('requires a valid access token', async () => {
      for (const path of ['/auth/mfa/verify', '/auth/mfa/recovery-codes']) {
        await kit
          .http()
          .post(path)
          .send({ recoveryCode: 'ABCDE-FGHJK' })
          .expect(401);
        await kit
          .http()
          .post(path)
          .set('Authorization', 'Bearer not-a-token')
          .send({ recoveryCode: 'ABCDE-FGHJK' })
          .expect(401);
      }
    });

    it("declines another user's code and leaves it usable for its owner", async () => {
      const alice = await kit.createUser();
      const bob = await kit.createUser();
      const aliceCodes = (await enable(alice)).recoveryCodes;
      await enable(bob);

      await useRecovery(bob, aliceCodes[0]).expect(400);
      // A user ID in the body is rejected, never used.
      await kit
        .verify(bob, { recoveryCode: aliceCodes[1], userId: alice.id })
        .expect(400);

      expect((await codesOf(alice)).every((row) => !row.usedAt)).toBe(true);
      expect((await codesOf(bob)).every((row) => !row.usedAt)).toBe(true);
      // The hash of a code is bound to its owner.
      expect(hashOf(alice, aliceCodes[0])).not.toBe(hashOf(bob, aliceCodes[0]));
      await useRecovery(alice, aliceCodes[0]).expect(200);
    });

    it("cannot regenerate or invalidate another user's codes", async () => {
      const alice = await kit.createUser();
      const bob = await kit.createUser();
      const aliceCodes = (await enable(alice)).recoveryCodes;
      const bobCodes = (await enable(bob)).recoveryCodes;
      const aliceBefore = await codesOf(alice);

      // Bob cannot prove anything with Alice's code...
      await kit.regenerate(bob, { recoveryCode: aliceCodes[0] }).expect(400);
      await kit
        .regenerate(bob, { recoveryCode: bobCodes[0], userId: alice.id })
        .expect(400);
      // ...and regenerating his own codes leaves Alice's alone.
      const bobView = dataOf<MfaRecoveryCodesView>(
        await kit.regenerate(bob, { recoveryCode: bobCodes[0] }).expect(201),
      );
      bobView.recoveryCodes.forEach((code) => shownCodes.add(code));

      expect(await codesOf(alice)).toEqual(aliceBefore);
      await useRecovery(alice, aliceCodes[0]).expect(200);
    });
  });

  describe('database rules', () => {
    it('never lets a used code become usable again, or change owner', async () => {
      const alice = await kit.createUser();
      const bob = await kit.createUser();
      const { recoveryCodes } = await enable(alice);
      await useRecovery(alice, recoveryCodes[0]).expect(200);
      const hash = hashOf(alice, recoveryCodes[0]);

      await expect(
        ctx.client.mfaRecoveryCode.update({
          where: { codeHash: hash },
          data: { usedAt: null },
        }),
      ).rejects.toThrow(/A used MfaRecoveryCode cannot change/);
      await expect(
        ctx.client.mfaRecoveryCode.update({
          where: { codeHash: hashOf(alice, recoveryCodes[1]) },
          data: { authId: bob.id },
        }),
      ).rejects.toThrow(/owner, hash and creation time cannot change/);
      await useRecovery(alice, recoveryCodes[0]).expect(400);
    });

    it('stores only hex digests, issued unused, each once', async () => {
      const user = await kit.createUser();
      await expect(
        ctx.client.mfaRecoveryCode.create({
          data: { authId: user.id, codeHash: 'ABCDE-FGHJK'.padEnd(64, 'x') },
        }),
      ).rejects.toThrow();
      const codeHash = 'a'.repeat(64);
      await expect(
        ctx.client.mfaRecoveryCode.create({
          data: { authId: user.id, codeHash, usedAt: kit.clock },
        }),
      ).rejects.toThrow(/must be issued unused/);
      await ctx.client.mfaRecoveryCode.create({
        data: { authId: user.id, codeHash },
      });
      await expect(
        ctx.client.mfaRecoveryCode.create({
          data: { authId: user.id, codeHash },
        }),
      ).rejects.toThrow();
    });

    it('deletes the codes with the account', async () => {
      const user = await kit.createUser();
      await enable(user);

      await ctx.client.authUser.delete({ where: { id: user.id } });

      expect(await codesOf(user)).toEqual([]);
    });
  });

  it('never logged any recovery code shown during this suite', () => {
    expect(shownCodes.size).toBeGreaterThanOrEqual(100);
    expect(logged.length).toBeGreaterThan(0);
    const text = logged
      .map((args) =>
        args
          .map((arg) =>
            arg instanceof Error
              ? `${arg.message} ${arg.stack}`
              : typeof arg === 'string'
                ? arg
                : JSON.stringify(arg),
          )
          .join(' '),
      )
      .join('\n')
      .toUpperCase();
    for (const code of shownCodes) {
      expect(text).not.toContain(code);
      expect(text).not.toContain(code.replace('-', ''));
    }
  });
});
