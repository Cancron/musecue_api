import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AccountDeletionController } from '../../privacy/account-deletion/account-deletion.controller';
import { PrivacyExportController } from '../../privacy/privacy-export.controller';
import { SubscriptionController } from '../../subscription/subscription.controller';
import { MfaController } from '../mfa/mfa.controller';
import { STEP_UP_ACTION, StepUpGuard } from './step-up.guard';

type Controller = { prototype: object; name: string };

const handler = (controller: Controller, name: string) =>
  (controller.prototype as Record<string, object>)[name];

/**
 * The inventory of sensitive actions: every handler that changes MFA
 * settings or recovery codes, cancels a subscription, exports or downloads
 * personal data, or deletes the account requires a step-up approval for
 * exactly its action, after AuthGuard. (Controller tests about other
 * concerns replace StepUpGuard; this keeps a missing decorator visible.)
 */
describe('Step-up protected routes', () => {
  it.each([
    [MfaController, 'startEnrollment', 'MFA_SETTINGS'],
    [MfaController, 'confirmEnrollment', 'MFA_SETTINGS'],
    [MfaController, 'revokeTrustedDevice', 'MFA_SETTINGS'],
    [MfaController, 'regenerateRecoveryCodes', 'MFA_RECOVERY_CODES'],
    [SubscriptionController, 'cancelSubscription', 'SUBSCRIPTION_CANCEL'],
    [PrivacyExportController, 'requestExport', 'PRIVACY_EXPORT'],
    [PrivacyExportController, 'createDownloadLink', 'PRIVACY_EXPORT_DOWNLOAD'],
    [PrivacyExportController, 'downloadArchive', 'PRIVACY_EXPORT_DOWNLOAD'],
    [AccountDeletionController, 'requestDeletion', 'ACCOUNT_DELETION'],
  ] as [Controller, string, string][])(
    '%p.%s requires %s',
    (controller, method, action) => {
      const target = handler(controller, method);
      expect(Reflect.getMetadata(STEP_UP_ACTION, target)).toBe(action);
      expect(Reflect.getMetadata(GUARDS_METADATA, target)).toContain(
        StepUpGuard,
      );
      // Authentication first: AuthGuard is on the controller (runs before
      // handler guards).
      expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toContain(
        AuthGuard,
      );
    },
  );

  it.each([
    [MfaController, 'getStatus'],
    [MfaController, 'listTrustedDevices'],
    [MfaController, 'verify'],
    [PrivacyExportController, 'listExports'],
    [PrivacyExportController, 'getExport'],
    [AccountDeletionController, 'requestConfirmationCode'],
  ] as [Controller, string][])(
    '%p.%s (read-only or harmless) needs no step-up',
    (controller, method) => {
      expect(
        Reflect.getMetadata(STEP_UP_ACTION, handler(controller, method)),
      ).toBeUndefined();
    },
  );
});
