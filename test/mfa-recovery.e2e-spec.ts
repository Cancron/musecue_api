// Must be first: PostgreSQL-only infrastructure (REDIS_ENABLED=false, Redis
// unreachable) and test secrets, then logging at every level, before any
// application module loads.
import './support/env-postgres-mode';
import './support/env-verbose-logs';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import type { Test } from 'supertest';
import {
  authenticatorCode,
  nextStepStart,
  recoveryCodeHash,
} from './support/authenticator-app';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import { OutputCapture, recordLogEntries } from './support/capture-output';
import { freezeTime } from './support/freeze-time';
import {
  bootApplication,
  eventually,
  type TestApplication,
} from './support/infrastructure-flows';
import { describeWithDatabase } from './support/migrated-schema';

jest.setTimeout(120_000);

const MFA_KEY = 'mfa-recovery-e2e-dedicated-key-0123456789abcdef';
const PASSWORD = 'correct horse battery staple';
const SECOND = 1_000;
/** XXXX-XXXX-XXXX in Crockford base32 (no I, L, O, U). */
const CODE_FORMAT =
  /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
/** Anything that looks like a recovery code in a response body. */
const ANY_CODE = /[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/;
const INVALID = 'Invalid or expired authentication code';

interface Envelope<T> {
  data: T;
  message: string;
}
interface StatusView {
  enabled: boolean;
  recovery: { remainingCodes: number; generatedAt: string | null } | null;
  verification: {
    remainingAttempts: number;
    blockedUntil: string | null;
  } | null;
}
interface User {
  id: string;
  email: string;
  ip: string;
  accessToken: string;
}
interface EnabledUser extends User {
  secret: string;
  codes: string[];
  enabledAt: number;
}

const data = <T>(response: { body: unknown }) =>
  (response.body as Envelope<T>).data;
const message = (response: { body: unknown }) =>
  (response.body as { message: string }).message;
const plain = (code: string) => code.replace(/-/g, '');

/**
 * MFA recovery codes through the real HTTP endpoints of the complete
 * application, on a temporary, freshly migrated PostgreSQL schema (dropped
 * afterwards): 10 unique codes issued once when MFA is enabled and stored
 * only as keyed hashes, verification with a code instead of the
 * authenticator, consumption recorded in PostgreSQL, refusal of invalid,
 * reused (also concurrently), replaced and other users' codes, invalidation
 * of every earlier code on regeneration, and that codes never appear in a
 * later response, in the database or in the logs.
 */
describeWithDatabase('MFA recovery codes (e2e, PostgreSQL)', () => {
  let ctx: TestApplication;
  let ipCounter = 0;
  const output = new OutputCapture();
  let logEntries: ReturnType<typeof recordLogEntries>;
  /** Every code the API ever issued in this suite. */
  const issued: string[] = [];
  /** Every response body after the one that issued each code. */
  const laterBodies: string[] = [];
  const originalKey = process.env.MFA_ENCRYPTION_KEY;

  const http = () => request(ctx.app.getHttpServer());

  beforeAll(async () => {
    process.env.MFA_ENCRYPTION_KEY = MFA_KEY;
    output.start();
    ctx = await bootApplication();
    logEntries = recordLogEntries(ctx.get<Logger>(WINSTON_MODULE_PROVIDER));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(async () => {
    logEntries?.stop();
    output.stop();
    await ctx?.close();
    if (originalKey === undefined) delete process.env.MFA_ENCRYPTION_KEY;
    else process.env.MFA_ENCRYPTION_KEY = originalKey;
  });

  /** Registration, emailed verification code and password login over HTTP. */
  async function signUp(): Promise<User> {
    const tag = randomBytes(5).toString('hex');
    const email = `rc_${tag}@example.com`;
    ipCounter += 1;
    const ip = `198.51.100.${ipCounter}`;
    await http()
      .post('/auth')
      .set('X-Forwarded-For', ip)
      .send({ username: `rc_${tag}`, email, password: PASSWORD })
      .expect(201);
    const sent = await eventually(
      () =>
        Promise.resolve(
          ctx.emails.sent.find(
            (item) => item.kind === 'verification' && item.to === email,
          ),
        ),
      30_000,
      'the verification email',
    );
    await http()
      .post('/auth/verify-email')
      .set('X-Forwarded-For', ip)
      .send({ email, code: sent.code })
      .expect(201);
    await eventually(
      () =>
        Promise.resolve(
          ctx.emails.sent.find(
            (item) => item.kind === 'welcome' && item.to === email,
          ),
        ),
      30_000,
      'the welcome email',
    );
    const login = data<{ accessToken: string; user: { id: string } }>(
      await http()
        .post('/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email, password: PASSWORD })
        .expect(201),
    );
    return { id: login.user.id, email, ip, accessToken: login.accessToken };
  }

  const api = (user: User) => {
    const post = (path: string, body?: object) => {
      const req = http()
        .post(path)
        .set('X-Forwarded-For', user.ip)
        .set('Authorization', `Bearer ${user.accessToken}`);
      return body ? req.send(body) : req;
    };
    /** Records the body of the response for the final leak check. */
    const track = (pending: Test): Test =>
      pending.on('response', (response: { body: unknown }) => {
        laterBodies.push(JSON.stringify(response.body));
      });
    return {
      status: () =>
        track(
          http()
            .get('/v1/auth/mfa')
            .set('X-Forwarded-For', user.ip)
            .set('Authorization', `Bearer ${user.accessToken}`),
        ),
      verify: (body: object) => track(post('/v1/auth/mfa/verify', body)),
      regenerate: (body: object) => post('/v1/auth/mfa/recovery-codes', body),
      start: () => post('/v1/auth/mfa/enrollment'),
      confirm: (body: object) => post('/v1/auth/mfa/enrollment/confirm', body),
    };
  };

  /** Freezes the clock (Date only) at `ms`. */
  let clock = 0;
  const travelTo = (ms: number) => {
    clock = ms;
    freezeTime(new Date(ms));
  };
  const travel = (ms: number) => travelTo(clock + ms);

  /** Signs up and enables MFA; keeps the codes the confirmation returned. */
  async function enabledUser(): Promise<EnabledUser> {
    const user = await signUp();
    travelTo(nextStepStart(Date.now()) + SECOND);
    const { secret } = data<{ secret: string }>(
      await api(user).start().expect(201),
    );
    const confirmed = await api(user)
      .confirm({ code: authenticatorCode(secret, clock) })
      .expect(200);
    expect(confirmed.headers['cache-control']).toBe('no-store');
    const { recoveryCodes } = data<{ recoveryCodes: string[] }>(confirmed);
    issued.push(...recoveryCodes);
    return { ...user, secret, codes: recoveryCodes, enabledAt: clock };
  }

  const codeRows = (authId: string) =>
    ctx.client.mfaRecoveryCode.findMany({
      where: { authId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  const rowOf = async (authId: string, code: string) =>
    ctx.client.mfaRecoveryCode.findUniqueOrThrow({
      where: {
        authId_codeHash: {
          authId,
          codeHash: recoveryCodeHash(MFA_KEY, authId, code),
        },
      },
    });

  it('issues 10 unique codes once when MFA is enabled and stores only keyed hashes', async () => {
    const user = await enabledUser();

    expect(user.codes).toHaveLength(10);
    expect(new Set(user.codes).size).toBe(10);
    for (const code of user.codes) expect(code).toMatch(CODE_FORMAT);

    // PostgreSQL holds 10 hashes of one set: HMAC-SHA-256 under the MFA key,
    // bound to the user, never the code or an unkeyed hash of it.
    const rows = await codeRows(user.id);
    expect(rows).toHaveLength(10);
    expect(new Set(rows.map((row) => row.batchId)).size).toBe(1);
    for (const row of rows) {
      expect(row).toMatchObject({
        usedAt: null,
        invalidatedAt: null,
        createdAt: new Date(user.enabledAt),
      });
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(rows.map((row) => row.codeHash).sort()).toEqual(
      user.codes.map((code) => recoveryCodeHash(MFA_KEY, user.id, code)).sort(),
    );
    const unkeyed = user.codes.map((code) =>
      createHash('sha256').update(plain(code)).digest('hex'),
    );
    expect(rows.some((row) => unkeyed.includes(row.codeHash))).toBe(false);
    // The database refuses anything but a hash.
    await expect(
      ctx.client.mfaRecoveryCode.create({
        data: { authId: user.id, batchId: 'manual', codeHash: user.codes[0] },
      }),
    ).rejects.toThrow();

    // Shown once: the status reports only a count, and enabling again (the
    // only way to repeat the confirmation) is refused without codes.
    const status = await api(user).status().expect(200);
    expect(data<StatusView>(status)).toMatchObject({
      enabled: true,
      recovery: {
        remainingCodes: 10,
        generatedAt: new Date(user.enabledAt).toISOString(),
      },
    });
    expect(JSON.stringify(status.body)).not.toMatch(ANY_CODE);
    const again = await api(user)
      .confirm({ code: authenticatorCode(user.secret, clock) })
      .expect(409);
    expect(JSON.stringify(again.body)).not.toMatch(ANY_CODE);
  });

  it('verifies with a recovery code instead of the authenticator and records the consumption in PostgreSQL', async () => {
    const user = await enabledUser();
    travel(5 * SECOND);
    const usedAt = clock;

    const verified = await api(user)
      .verify({ recoveryCode: user.codes[4] })
      .expect(200);
    expect(verified.headers['cache-control']).toBe('no-store');
    expect(data(verified)).toEqual({
      verified: true,
      method: 'recovery_code',
      remainingRecoveryCodes: 9,
    });

    // Consumed in PostgreSQL: exactly that row, at that time.
    expect(await rowOf(user.id, user.codes[4])).toMatchObject({
      usedAt: new Date(usedAt),
      invalidatedAt: null,
    });
    const rows = await codeRows(user.id);
    expect(rows.filter((row) => row.usedAt !== null)).toHaveLength(1);
    // The consumption is permanent: the database refuses to undo it.
    await expect(
      ctx.client.$executeRawUnsafe(
        `UPDATE "MfaRecoveryCode" SET "usedAt" = NULL WHERE "authId" = $1`,
        user.id,
      ),
    ).rejects.toThrow(/cannot be restored/);
    // Audited as a count change, never with the code.
    const audit = await ctx.client.activityLogEvent.findFirstOrThrow({
      where: {
        recordId: user.id,
        details: {
          some: { fieldName: 'mfaRecoveryCodesRemaining', newValue: '9' },
        },
      },
      include: { details: true },
    });
    expect(audit.details).toEqual([
      expect.objectContaining({
        fieldName: 'mfaRecoveryCodesRemaining',
        oldValue: '10',
        newValue: '9',
      }),
    ]);

    // Typing variants of another code work too (case, spaces, no hyphens).
    await api(user)
      .verify({
        recoveryCode: ` ${user.codes[5].replace(/-/g, ' ').toLowerCase()} `,
      })
      .expect(200);
    // The authenticator still works, in a later time step.
    travel(30 * SECOND);
    expect(
      data(
        await api(user)
          .verify({ code: authenticatorCode(user.secret, clock) })
          .expect(200),
      ),
    ).toEqual({ verified: true, method: 'totp', remainingRecoveryCodes: 8 });
    expect(
      data<StatusView>(await api(user).status().expect(200)),
    ).toMatchObject({
      recovery: { remainingCodes: 8 },
      verification: { remainingAttempts: 5, blockedUntil: null },
    });
  });

  it('declines invalid, already used and malformed codes', async () => {
    const user = await enabledUser();
    await api(user).verify({ recoveryCode: user.codes[0] }).expect(200);

    // Already used.
    expect(
      message(
        await api(user).verify({ recoveryCode: user.codes[0] }).expect(400),
      ),
    ).toBe(INVALID);
    // Never issued (well-formed, but not a code of this account).
    const unknown =
      user.codes[1] === 'ABCD-2345-WXYZ' ? 'ZYXW-5432-DCBA' : 'ABCD-2345-WXYZ';
    expect(
      message(await api(user).verify({ recoveryCode: unknown }).expect(400)),
    ).toBe(INVALID);
    // Malformed: rejected by validation, not counted.
    for (const body of [
      { recoveryCode: 'ABCD-2345' },
      { recoveryCode: user.codes[1], code: '123456' },
      {},
    ]) {
      await api(user).verify(body).expect(400);
    }
    expect(
      data<StatusView>(await api(user).status().expect(200)),
    ).toMatchObject({
      recovery: { remainingCodes: 9 },
      verification: { remainingAttempts: 3 },
    });
    expect(
      await ctx.client.authSecurity.findUniqueOrThrow({
        where: { authId: user.id },
      }),
    ).toMatchObject({ mfaFailedAttempts: 2 });
    // Nothing else was consumed.
    expect(
      (await codeRows(user.id)).filter((row) => row.usedAt !== null),
    ).toHaveLength(1);
  });

  it('lets exactly one of concurrent requests with the same code succeed', async () => {
    const user = await enabledUser();

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        api(user).verify({ recoveryCode: user.codes[2] }),
      ),
    );

    expect(responses.map((r) => r.status).sort()).toEqual([
      200, 400, 400, 400, 400,
    ]);
    expect(
      (await codeRows(user.id)).filter((row) => row.usedAt !== null),
    ).toEqual([
      expect.objectContaining({
        codeHash: recoveryCodeHash(MFA_KEY, user.id, user.codes[2]),
      }),
    ]);

    // The same holds for regeneration authorized by one code: one new set.
    const regenerations = await Promise.all(
      Array.from({ length: 3 }, () =>
        api(user).regenerate({ recoveryCode: user.codes[3] }),
      ),
    );
    expect(regenerations.map((r) => r.status).sort()).toEqual([201, 400, 400]);
    const winner = regenerations.find((r) => r.status === 201)!;
    issued.push(...data<{ recoveryCodes: string[] }>(winner).recoveryCodes);
    const batches = new Set(
      (await codeRows(user.id)).map((row) => row.batchId),
    );
    expect(batches.size).toBe(2);
  });

  it('invalidates every previous code after regeneration', async () => {
    const user = await enabledUser();
    await api(user).verify({ recoveryCode: user.codes[0] }).expect(200);

    // Regeneration needs a valid second factor; a wrong one changes nothing.
    await api(user).regenerate({ recoveryCode: 'ABCD-2345-WXYZ' }).expect(400);
    await api(user).regenerate({}).expect(400);
    expect(await codeRows(user.id)).toHaveLength(10);

    travel(30 * SECOND);
    const regeneratedAt = clock;
    const response = await api(user)
      .regenerate({ code: authenticatorCode(user.secret, clock) })
      .expect(201);
    expect(response.headers['cache-control']).toBe('no-store');
    const fresh = data<{
      recoveryCodes: string[];
      generatedAt: string;
      remainingRecoveryCodes: number;
      verifiedWith: string;
    }>(response);
    issued.push(...fresh.recoveryCodes);
    expect(fresh).toMatchObject({
      generatedAt: new Date(regeneratedAt).toISOString(),
      remainingRecoveryCodes: 10,
      verifiedWith: 'totp',
    });
    expect(fresh.recoveryCodes).toHaveLength(10);
    expect(new Set(fresh.recoveryCodes).size).toBe(10);
    expect(fresh.recoveryCodes.filter((c) => user.codes.includes(c))).toEqual(
      [],
    );

    // PostgreSQL: the old set (used or not) is invalidated at that moment,
    // the new set is a separate, unused batch.
    const rows = await codeRows(user.id);
    const oldHashes = new Set(
      user.codes.map((c) => recoveryCodeHash(MFA_KEY, user.id, c)),
    );
    const oldRows = rows.filter((row) => oldHashes.has(row.codeHash));
    const newRows = rows.filter((row) => !oldHashes.has(row.codeHash));
    expect(oldRows).toHaveLength(10);
    expect(
      oldRows.every((row) => row.invalidatedAt?.getTime() === regeneratedAt),
    ).toBe(true);
    expect(oldRows.filter((row) => row.usedAt !== null)).toHaveLength(1);
    expect(newRows).toHaveLength(10);
    expect(
      newRows.every((row) => row.usedAt === null && row.invalidatedAt === null),
    ).toBe(true);
    expect(new Set(newRows.map((row) => row.batchId)).size).toBe(1);
    expect(newRows[0].batchId).not.toBe(oldRows[0].batchId);

    // Every previous code is refused; the new ones work.
    for (const old of user.codes.slice(1, 4)) {
      expect(
        message(await api(user).verify({ recoveryCode: old }).expect(400)),
      ).toBe(INVALID);
    }
    await api(user)
      .verify({ recoveryCode: fresh.recoveryCodes[0] })
      .expect(200);
    expect(
      data<StatusView>(await api(user).status().expect(200)),
    ).toMatchObject({
      recovery: {
        remainingCodes: 9,
        generatedAt: new Date(regeneratedAt).toISOString(),
      },
    });
  });

  it("keeps codes to their owner: another account's code is declined and left unused", async () => {
    const owner = await enabledUser();
    const intruder = await enabledUser();

    // Not without a token ...
    await http()
      .post('/v1/auth/mfa/verify')
      .send({ recoveryCode: owner.codes[0] })
      .expect(401);
    await http()
      .post('/v1/auth/mfa/recovery-codes')
      .send({ recoveryCode: owner.codes[0] })
      .expect(401);
    // ... not by naming the owner ...
    const named = await api(intruder)
      .verify({ recoveryCode: owner.codes[0], userId: owner.id })
      .expect(400);
    expect(message(named)).toContain('userId should not exist');
    // ... and not as the intruder's own code.
    expect(
      message(
        await api(intruder)
          .verify({ recoveryCode: owner.codes[0] })
          .expect(400),
      ),
    ).toBe(INVALID);
    await api(intruder)
      .regenerate({ recoveryCode: owner.codes[1] })
      .expect(400);

    const ownerRows = await codeRows(owner.id);
    expect(
      ownerRows.every(
        (row) => row.usedAt === null && row.invalidatedAt === null,
      ),
    ).toBe(true);
    expect(await codeRows(intruder.id)).toHaveLength(10);
    // The same code hashes differently per account.
    expect(recoveryCodeHash(MFA_KEY, intruder.id, owner.codes[0])).not.toBe(
      recoveryCodeHash(MFA_KEY, owner.id, owner.codes[0]),
    );

    // The owner can still use it.
    await api(owner).verify({ recoveryCode: owner.codes[0] }).expect(200);
  });

  it('never logs the codes, stores them in plaintext, or returns them again', async () => {
    expect(issued.length).toBeGreaterThanOrEqual(60);

    // Logs at every level - the console output and every structured entry
    // with its metadata: the application did log about recovery codes ...
    const logs = `${output.text()}\n${logEntries.text()}`;
    expect(logEntries.text()).toContain('"userId"');
    expect(logs).toContain('MFA enabled');
    expect(logs).toContain('MFA recovery code used');
    expect(logs).toContain('MFA recovery codes regenerated');
    // ... but never a code, in any form.
    const lowerLogs = logs.toLowerCase();
    for (const code of issued) {
      expect(logs).not.toContain(code);
      expect(lowerLogs).not.toContain(plain(code).toLowerCase());
    }

    // Every response after issuance (status, verification, refusals).
    const bodies = laterBodies.join('\n');
    expect(laterBodies.length).toBeGreaterThan(20);
    for (const code of issued) {
      expect(bodies).not.toContain(code);
      expect(bodies).not.toContain(plain(code));
    }

    // Every column of every table in the temporary PostgreSQL schema.
    const tables = await ctx.client.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
    );
    expect(tables.map((t) => t.table_name)).toContain('MfaRecoveryCode');
    let dump = '';
    for (const { table_name } of tables) {
      const rows = await ctx.client.$queryRawUnsafe<{ row: string }[]>(
        `SELECT row_to_json(t)::text AS row FROM "${table_name.replace(/"/g, '""')}" t`,
      );
      dump += rows.map((r) => r.row).join('\n');
    }
    expect(dump.length).toBeGreaterThan(0);
    const lowerDump = dump.toLowerCase();
    for (const code of issued) {
      expect(lowerDump).not.toContain(plain(code).toLowerCase());
      expect(dump).not.toContain(code);
    }
  });
});
