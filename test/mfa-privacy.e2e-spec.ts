// Must be first: fixes the environment (REDIS_ENABLED=false, secrets,
// MFA_ENCRYPTION_KEY) before any application module reads it.
import './support/env-postgres-mode';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type request from 'supertest';
import { totpCode } from '../src/auth/mfa/mfa-totp';
import { AccountDeletionRecoveryService } from '../src/privacy/account-deletion/account-deletion-recovery.service';
import { freezeTime } from './support/freeze-time';
import {
  bootApplication,
  eventually,
  type TestApplication,
} from './support/infrastructure-flows';
import {
  dataOf,
  messageOf,
  MfaTestKit,
  MIN,
  PASSWORD,
  SECOND,
  type TestUser,
  wrongCode,
} from './support/mfa-e2e';
import { describeWithDatabase } from './support/migrated-schema';
import { readZip } from './support/read-zip';

jest.setTimeout(180_000);

const HEADER = 'X-Step-Up-Token';
const EXPORTS = '/v1/privacy/exports';
const DELETION = '/v1/privacy/account-deletion';

interface MfaUser extends TestUser {
  recoveryCodes: string[];
  /** A password approval of every privacy action, given before MFA. */
  preMfaApprovals: Record<string, string>;
}

/**
 * MFA step-up for personal-data export, export download and account
 * deletion, through the real endpoints of the whole application on a
 * temporary, freshly migrated PostgreSQL schema, with the background
 * workers of the PostgreSQL queue and captured (mocked) email delivery: no
 * external service is used.
 *
 * Users have MFA enabled, so each action needs a step-up approval proven
 * with the authenticator or a recovery code. Refused requests answer 403 and
 * create nothing (no export record, job or archive; no deletion) and expose
 * no archive. An approved export answers 202, is built asynchronously and
 * ends COMPLETED with a valid ZIP archive at its storageKey; an approved
 * download returns only the owner's archive; an approved deletion still
 * needs the password and the emailed confirmation code.
 */
describeWithDatabase('MFA step-up for privacy actions (e2e)', () => {
  let ctx: TestApplication;
  let kit: MfaTestKit;
  let exportRoot: string;

  beforeAll(async () => {
    ctx = await bootApplication();
    exportRoot = process.env.PRIVATE_EXPORT_DIR as string;
    kit = new MfaTestKit(ctx, '198.30');
    freezeTime(kit.clock);
    kit.nextStepStart();
  });

  afterAll(async () => {
    jest.useRealTimers();
    await ctx?.close();
  });

  beforeEach(() => kit.nextStepStart(60 * MIN));

  const http = () => kit.http();

  /** A fresh authenticator code (the next 30-second step, never used). */
  const freshCode = (user: TestUser) => {
    kit.nextStepStart();
    return totpCode(user.totpSecret as string, kit.clock);
  };

  /** An approval of `action` proven with the authenticator. */
  const mfaApproval = async (user: TestUser, action: string) => {
    const approval = dataOf<{ stepUpToken: string; method: string }>(
      await http()
        .post('/auth/step-up')
        .set(kit.as(user))
        .send({ action, code: freshCode(user) })
        .expect(201),
    );
    expect(approval.method).toBe('TOTP');
    return approval.stepUpToken;
  };

  /**
   * A user who enables MFA through the API. Before that, in the same
   * session, they were approved with the password for every privacy action
   * (valid when given; MFA makes them worthless).
   */
  async function mfaUser(): Promise<MfaUser> {
    const user = await kit.createUser();
    const preMfaApprovals: Record<string, string> = {};
    for (const action of [
      'DATA_EXPORT',
      'DATA_EXPORT_DOWNLOAD',
      'ACCOUNT_DELETION',
    ]) {
      preMfaApprovals[action] = await kit.approve(user, action, {
        password: PASSWORD,
      });
    }
    const { recoveryCodes } = await kit.enableMfa(user);
    return { ...user, recoveryCodes, preMfaApprovals };
  }

  /** How a refused request was made: the caller and its approval token. */
  type Refusal = (
    user: MfaUser,
    action: string,
  ) => Promise<{ caller: TestUser; token?: string }>;

  /** Ways of asking without a valid MFA step-up for `action`. */
  const refusals: Record<string, Refusal> = {
    'no approval': (user) => Promise.resolve({ caller: user }),
    'a malformed approval': (user) =>
      Promise.resolve({ caller: user, token: 'stup_forged' }),
    'an approval of another action': async (user, action) => ({
      caller: user,
      token: await mfaApproval(
        user,
        action === 'ACCOUNT_DELETION' ? 'DATA_EXPORT' : 'ACCOUNT_DELETION',
      ),
    }),
    'an expired approval': async (user, action) => {
      const token = await mfaApproval(user, action);
      kit.advance(10 * MIN);
      return { caller: user, token };
    },
    'an approval of another session': async (user, action) => {
      const token = await mfaApproval(user, action);
      const other = { ...user };
      await kit.signIn(other);
      return { caller: other, token };
    },
    'an approval of another user': async (user, action) => {
      const mallory = await mfaUser();
      return { caller: user, token: await mfaApproval(mallory, action) };
    },
    'a password approval given before MFA was enabled': (user, action) =>
      Promise.resolve({ caller: user, token: user.preMfaApprovals[action] }),
  };

  /** Sends `test` with the refusal's approval (if any). */
  const withToken = (test: request.Test, token?: string) =>
    token === undefined ? test : test.set(HEADER, token);

  /** The archive files stored for `user` (none when the folder is absent). */
  async function archiveFilesOf(user: TestUser): Promise<string[]> {
    const files: string[] = [];
    const walk = async (dir: string) => {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(dir, entry);
        if (entry.includes('.')) files.push(path);
        else await walk(path);
      }
    };
    await walk(join(exportRoot, user.id));
    return files;
  }

  /** Reads a binary response body. */
  const binary = (test: request.Test) =>
    test.buffer(true).parse((response, done) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => done(null, Buffer.concat(chunks)));
    });

  /** A ZIP archive starts with the local file header signature. */
  const isZip = (body: unknown) =>
    Buffer.isBuffer(body) && body.subarray(0, 4).toString('hex') === '504b0304';

  /** Waits until the export worker completed the export. */
  const completion = (exportId: string) =>
    eventually(
      async () => {
        const row = await ctx.client.dataExport.findUniqueOrThrow({
          where: { id: exportId },
        });
        if (row.status === 'FAILED') throw new Error('The export failed');
        return row.status === 'COMPLETED' ? row : null;
      },
      60_000,
      'the export',
    );

  /** An export requested with an MFA step-up, once completed. */
  async function completedExport(user: TestUser) {
    const requested = dataOf<{ id: string }>(
      await http()
        .post(EXPORTS)
        .set(kit.as(user))
        .set(HEADER, await mfaApproval(user, 'DATA_EXPORT'))
        .expect(202),
    );
    return completion(requested.id);
  }

  describe('personal-data export', () => {
    it.each(Object.keys(refusals))(
      'with %s: 403, no export record, job or archive',
      async (variant) => {
        const user = await mfaUser();
        const { caller, token } = await refusals[variant](user, 'DATA_EXPORT');

        const refused = await withToken(
          http().post(EXPORTS).set(kit.as(caller)),
          token,
        ).expect(403);

        expect(messageOf(refused)).toMatch(/step-up/i);
        expect(
          await ctx.client.dataExport.count({ where: { authId: user.id } }),
        ).toBe(0);
        expect(
          await ctx.client.infrastructureJob.count({
            where: { authId: user.id, queue: { contains: 'export' } },
          }),
        ).toBe(0);
        expect(await archiveFilesOf(user)).toEqual([]);
      },
    );

    it('with an MFA step-up: 202, built in the background, COMPLETED with a valid ZIP at its storageKey', async () => {
      const user = await mfaUser();
      const other = await mfaUser();

      const response = await http()
        .post(EXPORTS)
        .set(kit.as(user))
        .set(HEADER, await mfaApproval(user, 'DATA_EXPORT'))
        .expect(202);

      // Accepted, not built yet: the worker builds it asynchronously.
      const accepted = dataOf<{ id: string; status: string }>(response);
      expect(accepted.status).toBe('QUEUED');
      const row = await completion(accepted.id);
      {
        expect(row).toMatchObject({
          authId: user.id,
          status: 'COMPLETED',
          storageKey: expect.stringMatching(
            new RegExp(`^${user.id}/${row.id}/[0-9a-f-]{36}\\.zip$`),
          ) as string,
        });
        const archive = await readFile(
          join(exportRoot, row.storageKey as string),
        );
        expect(Number(row.sizeBytes)).toBe(archive.length);
        expect(row.sha256).toBe(
          createHash('sha256').update(archive).digest('hex'),
        );
        const zip = await readZip(archive); // validates CRCs and sizes
        expect(zip.names).toEqual(
          expect.arrayContaining([
            'README.txt',
            'manifest.json',
            'data/account.json',
            'data/profile.json',
            'data/subscription.json',
          ]),
        );
        const account = JSON.parse(
          (zip.files.get('data/account.json') as Buffer).toString('utf8'),
        ) as {
          account: { id: string; email: string };
          security: { mfaEnabled: boolean; mfaMethod: string };
        };
        expect(account.account).toMatchObject({
          id: user.id,
          email: user.email,
        });
        expect(account.security).toMatchObject({
          mfaEnabled: true,
          mfaMethod: 'totp',
        });
        // Only the owner's data, and no MFA credential.
        const text = [...zip.files.values()]
          .map((b) => b.toString('utf8'))
          .join('\n');
        expect(text).not.toContain(other.email);
        expect(text).not.toContain(other.id);
        expect(text).not.toContain(user.totpSecret as string);
        for (const code of user.recoveryCodes) {
          expect(text).not.toContain(code);
        }
        const { mfaSecret } = await ctx.client.authSecurity.findUniqueOrThrow({
          where: { authId: user.id },
        });
        expect(text).not.toContain(mfaSecret as string);
      }
    });

    it('a recovery code is an MFA step-up too', async () => {
      const user = await mfaUser();
      const { stepUpToken } = dataOf<{ stepUpToken: string }>(
        await http()
          .post('/auth/step-up')
          .set(kit.as(user))
          .send({ action: 'DATA_EXPORT', recoveryCode: user.recoveryCodes[0] })
          .expect(201),
      );

      await http()
        .post(EXPORTS)
        .set(kit.as(user))
        .set(HEADER, stepUpToken)
        .expect(202);
      expect(
        await ctx.client.dataExport.count({ where: { authId: user.id } }),
      ).toBe(1);
    });

    it('an MFA user cannot approve it with the password or a wrong code', async () => {
      const user = await mfaUser();
      await http()
        .post('/auth/step-up')
        .set(kit.as(user))
        .send({ action: 'DATA_EXPORT', password: PASSWORD })
        .expect(400);
      await http()
        .post('/auth/step-up')
        .set(kit.as(user))
        .send({ action: 'DATA_EXPORT', code: wrongCode(freshCode(user)) })
        .expect(400);

      expect(
        await ctx.client.stepUpApproval.count({
          where: { authId: user.id, action: 'DATA_EXPORT' },
        }),
      ).toBe(1); // the password approval given before MFA only
      await http().post(EXPORTS).set(kit.as(user)).expect(403);
      expect(
        await ctx.client.dataExport.count({ where: { authId: user.id } }),
      ).toBe(0);
    });
  });

  describe('downloading an export', () => {
    /** GET .../download: the signed link (raw response). */
    const linkRequest = (user: TestUser, exportId: string) =>
      http().get(`${EXPORTS}/${exportId}/download`).set(kit.as(user));

    it.each(Object.keys(refusals))(
      'with %s: 403, no link and no archive',
      async (variant) => {
        const user = await mfaUser();
        const row = await completedExport(user);
        const { caller, token } = await refusals[variant](
          user,
          'DATA_EXPORT_DOWNLOAD',
        );

        const link = await withToken(linkRequest(caller, row.id), token).expect(
          403,
        );
        expect(JSON.stringify(link.body)).not.toMatch(/signature|url/i);

        // The archive route itself, even with a correctly signed link.
        const { url } = dataOf<{ url: string }>(
          await linkRequest(user, row.id)
            .set(HEADER, await mfaApproval(user, 'DATA_EXPORT_DOWNLOAD'))
            .expect(200),
        );
        const archive = await binary(
          withToken(http().get(url).set(kit.as(caller)), token),
        ).expect(403);
        expect(isZip(archive.body)).toBe(false);
        expect(archive.headers['content-type']).toMatch(/json/);
      },
    );

    it('with an MFA step-up: the link and then exactly the owner’s stored archive', async () => {
      const user = await mfaUser();
      const row = await completedExport(user);
      const approval = await mfaApproval(user, 'DATA_EXPORT_DOWNLOAD');

      const link = dataOf<{ url: string; expiresAt: string }>(
        await linkRequest(user, row.id).set(HEADER, approval).expect(200),
      );
      expect(
        new Date(link.expiresAt).getTime() - kit.clock.getTime(),
      ).toBeLessThanOrEqual(15 * MIN);
      // The signed link alone is not enough: the archive route needs the
      // approval too.
      await http().get(link.url).set(kit.as(user)).expect(403);
      const archive = await binary(
        http().get(link.url).set(kit.as(user)).set(HEADER, approval),
      ).expect(200);

      expect(archive.headers['content-type']).toBe('application/zip');
      expect(archive.headers['cache-control']).toBe('private, no-store');
      expect(archive.body).toEqual(
        await readFile(join(exportRoot, row.storageKey as string)),
      );
      expect(isZip(archive.body)).toBe(true);
    });

    it('another user never gets the owner’s archive, even with their own MFA step-up', async () => {
      const owner = await mfaUser();
      const mallory = await mfaUser();
      const ownerExport = await completedExport(owner);
      const malloryExport = await completedExport(mallory);
      const ownerApproval = await mfaApproval(owner, 'DATA_EXPORT_DOWNLOAD');
      const malloryApproval = await mfaApproval(
        mallory,
        'DATA_EXPORT_DOWNLOAD',
      );
      const ownerLink = dataOf<{ url: string }>(
        await linkRequest(owner, ownerExport.id)
          .set(HEADER, ownerApproval)
          .expect(200),
      ).url;

      // No link for someone else's export (indistinguishable from none).
      await linkRequest(mallory, ownerExport.id)
        .set(HEADER, malloryApproval)
        .expect(404);
      // The owner's signed link with Mallory's token and approval...
      const stolen = await binary(
        http().get(ownerLink).set(kit.as(mallory)).set(HEADER, malloryApproval),
      ).expect(403);
      expect(isZip(stolen.body)).toBe(false);
      // ...or with the owner's approval.
      await binary(
        http().get(ownerLink).set(kit.as(mallory)).set(HEADER, ownerApproval),
      ).expect(403);

      // Mallory's own download is her own archive only.
      const malloryLink = dataOf<{ url: string }>(
        await linkRequest(mallory, malloryExport.id)
          .set(HEADER, malloryApproval)
          .expect(200),
      ).url;
      const own = await binary(
        http()
          .get(malloryLink)
          .set(kit.as(mallory))
          .set(HEADER, malloryApproval),
      ).expect(200);
      expect(own.body).toEqual(
        await readFile(join(exportRoot, malloryExport.storageKey as string)),
      );
      const zip = await readZip(own.body as Buffer);
      const text = [...zip.files.values()].map((b) => b.toString()).join('');
      expect(text).toContain(mallory.email);
      expect(text).not.toContain(owner.email);
    });
  });

  describe('account deletion', () => {
    /** Requests the emailed confirmation code; returns it (mocked email). */
    async function confirmationCode(user: TestUser): Promise<string> {
      const before = ctx.emails.sent.length;
      await http()
        .post(`${DELETION}/confirmation-code`)
        .set(kit.as(user))
        .expect(202);
      const sent = await eventually(
        () =>
          Promise.resolve(
            ctx.emails.sent
              .slice(before)
              .find(
                (e) =>
                  e.kind === 'account-deletion-code' && e.to === user.email,
              ),
          ),
        60_000,
        'the deletion code email',
      );
      return sent.code as string;
    }

    const deletion = (user: TestUser, body: object, token?: string) =>
      withToken(http().post(DELETION).set(kit.as(user)), token).send(body);

    /** Nothing of the deletion happened: the account is as it was. */
    async function expectNotDeleted(user: TestUser) {
      expect(
        await ctx.client.authUser.findUniqueOrThrow({
          where: { id: user.id },
          select: { status: true },
        }),
      ).toEqual({ status: 'ACTIVE' });
      expect(
        await ctx.client.accountDeletionRequest.count({
          where: { authId: user.id },
        }),
      ).toBe(0);
      await http().get('/auth/mfa').set(kit.as(user)).expect(200);
    }

    it.each(Object.keys(refusals))(
      'with %s: 403, nothing deleted and the emailed code not used up',
      async (variant) => {
        const user = await mfaUser();
        const code = await confirmationCode(user);
        const challenge = await ctx.client.authChallenge.findFirstOrThrow({
          where: { authId: user.id, purpose: 'ACCOUNT_DELETION' },
        });
        const { caller, token } = await refusals[variant](
          user,
          'ACCOUNT_DELETION',
        );

        const refused = await deletion(
          caller,
          { password: PASSWORD, code },
          token,
        ).expect(403);

        expect(messageOf(refused)).toMatch(/step-up/i);
        await expectNotDeleted(user);
        // Refused before the code was checked: it is exactly as issued.
        expect(
          await ctx.client.authChallenge.findUniqueOrThrow({
            where: { id: challenge.id },
          }),
        ).toEqual(challenge);
      },
    );

    it('with an MFA step-up, the password and emailed code are still required', async () => {
      const user = await mfaUser();
      const approval = await mfaApproval(user, 'ACCOUNT_DELETION');

      // No code requested yet.
      await deletion(
        user,
        { password: PASSWORD, code: 'ABC123' },
        approval,
      ).expect(403);
      const code = await confirmationCode(user);
      // The password is missing, wrong; the code is wrong, or an
      // authenticator code (it is not the emailed code).
      await deletion(user, { code }, approval).expect(400);
      await deletion(
        user,
        { password: 'wrong password', code },
        approval,
      ).expect(403);
      const wrong = code === 'ZZZ999' ? 'ZZZ998' : 'ZZZ999';
      await deletion(
        user,
        { password: PASSWORD, code: wrong },
        approval,
      ).expect(403);
      await deletion(
        user,
        { password: PASSWORD, code: freshCode(user) },
        approval,
      ).expect(403);
      // The existing limit of 5 confirmation attempts per 15 minutes still
      // applies, even to a correct request.
      const limited = await deletion(
        user,
        { password: PASSWORD, code },
        approval,
      ).expect(429);
      expect(messageOf(limited)).toMatch(/^Rate limit exceeded/);

      await expectNotDeleted(user);
    });

    it('with an MFA step-up, the password and the emailed code: accepted, every token ends, then the account and its archives are erased', async () => {
      const user = await mfaUser();
      const row = await completedExport(user);
      expect(await archiveFilesOf(user)).toHaveLength(1);
      const code = await confirmationCode(user);
      const refreshToken = dataOf<{ refreshToken: string }>(
        await (async () => {
          kit.advance(SECOND);
          const login = dataOf<{ challengeToken: string }>(
            await kit.login(user).expect(201),
          );
          return http()
            .post('/auth/login/mfa')
            .set('X-Forwarded-For', user.ip)
            .send({
              challengeToken: login.challengeToken,
              code: freshCode(user),
            })
            .expect(200);
        })(),
      ).refreshToken;

      const accepted = await deletion(
        user,
        { password: PASSWORD, code },
        await mfaApproval(user, 'ACCOUNT_DELETION'),
      ).expect(202);

      expect(dataOf<{ status: string }>(accepted)).toMatchObject({
        status: 'PENDING',
      });
      expect(
        await ctx.client.authUser.findUniqueOrThrow({
          where: { id: user.id },
          select: { status: true },
        }),
      ).toEqual({ status: 'PENDING_DELETION' });
      await http().get('/auth/mfa').set(kit.as(user)).expect(401);
      await http()
        .post('/auth/refresh-token')
        .set('X-Forwarded-For', user.ip)
        .send({ refreshToken })
        .expect(401);

      const erased = await ctx
        .get<AccountDeletionRecoveryService>(AccountDeletionRecoveryService)
        .resume();
      expect(erased.completed).toBeGreaterThanOrEqual(1);
      expect(await ctx.client.authUser.count({ where: { id: user.id } })).toBe(
        0,
      );
      expect(await ctx.client.dataExport.count({ where: { id: row.id } })).toBe(
        0,
      );
      expect(await archiveFilesOf(user)).toEqual([]);
    });
  });
});
