import request from 'supertest';
import type { App } from 'supertest/types';

/** Request header carrying a step-up approval. */
export const STEP_UP_HEADER = 'X-Step-Up-Token';

export type StepUpAction =
  | 'MFA_SETTINGS'
  | 'MFA_RECOVERY_CODES'
  | 'SUBSCRIPTION_CANCEL'
  | 'PRIVACY_EXPORT'
  | 'PRIVACY_EXPORT_DOWNLOAD'
  | 'ACCOUNT_DELETION';

export type StepUpFactor =
  | { password: string }
  | { code: string }
  | { recoveryCode: string };

/**
 * Obtains a step-up approval for `action` over HTTP (POST /v1/auth/step-up)
 * with the account's factor, and returns the approval token.
 */
export async function stepUp(
  server: App,
  user: { accessToken: string; ip?: string },
  action: StepUpAction,
  factor: StepUpFactor,
): Promise<string> {
  const req = request(server)
    .post('/v1/auth/step-up')
    .set('Authorization', `Bearer ${user.accessToken}`);
  if (user.ip) req.set('X-Forwarded-For', user.ip);
  const response = await req.send({ action, ...factor }).expect(201);
  return (response.body as { data: { approvalToken: string } }).data
    .approvalToken;
}
