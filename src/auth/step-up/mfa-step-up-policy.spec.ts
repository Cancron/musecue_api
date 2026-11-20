import type { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { StepUpAction, StepUpMethod } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AuthGuard } from '../../common/guards/auth.guard';
import type { PrismaService } from '../../common/services/prisma.service';
import { AccountDeletionController } from '../../privacy/account-deletion/account-deletion.controller';
import { PrivacyExportController } from '../../privacy/privacy-export.controller';
import { StripeWebhookController } from '../../subscription/stripe/stripe-webhook.controller';
import { SubscriptionController } from '../../subscription/subscription.controller';
import { STEP_UP_ACTION_KEY } from './step-up.constants';
import { MFA_STEP_UP_METHODS, StepUpGuard } from './step-up.guard';

const TOKEN = `stup_${'A'.repeat(43)}`;
const NOW = new Date('2026-11-28T10:00:00.000Z');

/**
 * MFA step-up for subscription cancellation, personal-data export and
 * download, and account deletion: which routes need which approval, and
 * that accounts with MFA enabled accept only approvals proven with a second
 * factor. The routes themselves are covered by test/mfa-billing.e2e-spec.ts
 * and test/mfa-privacy.e2e-spec.ts.
 */
describe('MFA step-up policy', () => {
  describe('protected routes', () => {
    const routeOf = (
      controller: abstract new (...args: never[]) => unknown,
      handler: string,
    ) => {
      const method = (controller.prototype as Record<string, object>)[handler];
      return {
        action: Reflect.getMetadata(STEP_UP_ACTION_KEY, method) as
          | StepUpAction
          | undefined,
        guards: [
          ...((Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[]) ??
            []),
          ...((Reflect.getMetadata(GUARDS_METADATA, method) as unknown[]) ??
            []),
        ],
      };
    };

    it.each([
      [SubscriptionController, 'cancelSubscription', 'SUBSCRIPTION_CANCEL'],
      [PrivacyExportController, 'requestExport', 'DATA_EXPORT'],
      [PrivacyExportController, 'createDownloadLink', 'DATA_EXPORT_DOWNLOAD'],
      [PrivacyExportController, 'downloadArchive', 'DATA_EXPORT_DOWNLOAD'],
      [AccountDeletionController, 'requestDeletion', 'ACCOUNT_DELETION'],
    ] as const)(
      '%p.%s needs a %s approval, checked after authentication',
      (controller, handler, action) => {
        const route = routeOf(controller, handler);
        expect(route.action).toBe(action);
        expect(route.guards).toContain(StepUpGuard);
        expect(route.guards.indexOf(AuthGuard)).toBeLessThan(
          route.guards.indexOf(StepUpGuard),
        );
      },
    );

    it.each([
      // Reading export status and asking for the emailed code change nothing.
      [PrivacyExportController, 'getExport'],
      [PrivacyExportController, 'listExports'],
      [AccountDeletionController, 'requestConfirmationCode'],
      // Stripe's webhooks are verified by their signature, never a step-up.
      [StripeWebhookController, 'receive'],
    ] as const)('%p.%s needs no approval', (controller, handler) => {
      const route = routeOf(controller, handler);
      expect(route.action).toBeUndefined();
      expect(route.guards).not.toContain(StepUpGuard);
    });
  });

  describe('StepUpGuard for accounts with MFA enabled', () => {
    let method: StepUpMethod;
    let mfaEnabled: boolean | null;
    let guard: StepUpGuard;

    beforeEach(() => {
      jest.useFakeTimers({ now: NOW });
      method = 'TOTP';
      mfaEnabled = true;
      const prisma = {
        stepUpApproval: {
          findUnique: () =>
            Promise.resolve({
              id: 'approval-1',
              tokenHash: createHash('sha256').update(TOKEN).digest('hex'),
              authId: 'alice',
              sessionId: 'session-1',
              action: 'DATA_EXPORT',
              method,
              expiresAt: new Date(NOW.getTime() + 60_000),
            }),
        },
        refreshSession: { count: () => Promise.resolve(1) },
        authSecurity: {
          findUnique: () =>
            Promise.resolve(mfaEnabled === null ? null : { mfaEnabled }),
        },
      } as unknown as PrismaService;
      guard = new StepUpGuard(new Reflector(), prisma);
    });
    afterEach(() => jest.useRealTimers());

    const check = () => {
      const handler = () => undefined;
      Reflect.defineMetadata(STEP_UP_ACTION_KEY, 'DATA_EXPORT', handler);
      const request = {
        headers: { 'x-step-up-token': TOKEN },
        user: { userId: 'alice', sid: 'session-1' },
      };
      return {
        request,
        result: guard.canActivate({
          getHandler: () => handler,
          getClass: () => class Route {},
          switchToHttp: () => ({ getRequest: () => request }),
        } as unknown as ExecutionContext),
      };
    };

    it('second-factor methods are the authenticator and recovery codes', () => {
      expect(MFA_STEP_UP_METHODS).toEqual(['TOTP', 'RECOVERY_CODE']);
    });

    it.each(['TOTP', 'RECOVERY_CODE'] as const)(
      'accepts an approval proven with %s and records how',
      async (proven) => {
        method = proven;
        const { request, result } = check();
        await expect(result).resolves.toBe(true);
        expect(request).toMatchObject({
          stepUp: { action: 'DATA_EXPORT', method: proven },
        });
      },
    );

    it.each(['PASSWORD', 'GOOGLE'] as const)(
      'refuses an approval proven with %s (given before MFA was enabled): 403',
      async (proven) => {
        method = proven;
        await expect(check().result).rejects.toMatchObject({
          status: 403,
          message: expect.stringMatching(
            /missing, expired or not valid for this action \(DATA_EXPORT\)/,
          ) as string,
        });
      },
    );

    it.each([
      ['MFA is off', false],
      ['there is no security record', null],
    ] as const)('keeps password approvals when %s', async (_, enabled) => {
      mfaEnabled = enabled;
      method = 'PASSWORD';
      await expect(check().result).resolves.toBe(true);
    });
  });
});
