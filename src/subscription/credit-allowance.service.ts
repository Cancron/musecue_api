import { Injectable } from '@nestjs/common';
import { CreditSource, Prisma } from '@prisma/client';
import { CreditSettingsService } from '../credits/credit-settings.service';
import { CreditWalletService } from '../credits/credit-wallet.service';
import type { GrantCreditsResult } from '../credits/interfaces/credit-wallet.interface';
import { trialAllowanceReference } from './credit-allowance.policy';

export const TRIAL_CREDITS_DESCRIPTION = 'Free trial credits';
export const TRIAL_CREDITS_ENDED_BY_UPGRADE =
  'TRIAL credits expired: upgraded to Pro';

/**
 * Credit changes caused by subscription events, written in the same
 * database transaction as the event itself:
 *
 * - trial activation grants the trial allowance (the administrator's
 *   `trialCredits`, default 50), expiring with the trial: a trial is never
 *   started without its credits, and a failed grant rolls the activation
 *   back;
 * - buying paid Pro ends any unused trial credits at once (EXPIRATION,
 *   effective at the purchase), leaving purchased and referral credits
 *   untouched.
 *
 * Both are idempotent: a trial's credits are granted once (one TRIAL
 * allocation per user, also enforced by the database) and an allocation is
 * expired once.
 */
@Injectable()
export class CreditAllowanceService {
  constructor(
    private readonly wallet: CreditWalletService,
    private readonly settings: CreditSettingsService,
  ) {}

  async grantTrialCredits(
    tx: Prisma.TransactionClient,
    authId: string,
    trial: { startedAt: Date; expiresAt: Date },
  ): Promise<GrantCreditsResult> {
    const settings = await this.settings.getSettings(tx);
    return this.wallet.grant(
      {
        authId,
        source: CreditSource.TRIAL,
        sourceReference: trialAllowanceReference(trial.startedAt),
        amount: settings.trialCredits,
        expiresAt: trial.expiresAt,
        description: TRIAL_CREDITS_DESCRIPTION,
      },
      // Granted at the moment the trial starts.
      { tx, at: trial.startedAt },
    );
  }

  /**
   * Ends unused trial credits, effective `at` (when paid Pro was
   * activated). Returns how many trial allocations were ended.
   */
  expireTrialCreditsOnUpgrade(
    tx: Prisma.TransactionClient,
    authId: string,
    at: Date,
  ): Promise<number> {
    return this.wallet.expireSourceNow(
      authId,
      CreditSource.TRIAL,
      TRIAL_CREDITS_ENDED_BY_UPGRADE,
      { tx, at },
    );
  }
}
