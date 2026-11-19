import { Injectable } from '@nestjs/common';
import { CreditSource, Prisma } from '@prisma/client';
import { CreditSettingsService } from '../credits/credit-settings.service';
import { CreditWalletService } from '../credits/credit-wallet.service';
import { InvalidCreditOperationError } from '../credits/credit-wallet.errors';
import {
  dueAllowances,
  isCreditSourceUsable,
  type AllowanceAmounts,
  type DueAllowance,
} from './credit-allowance.policy';
import type {
  SubscriptionAccess,
  SubscriptionRecord,
} from './subscription-access.policy';
import { SubscriptionAccessService } from './subscription-access.service';

const ZERO = new Prisma.Decimal(0);
const NO_AMOUNTS: AllowanceAmounts = { trialCredits: 0, proMonthlyCredits: 0 };

export interface CreditEligibility {
  /** Whether the user has usable credits. */
  eligible: boolean;
  /** Credits usable now (exact decimal string). */
  usableCredits: string;
  usableBySource: Record<CreditSource, string>;
  /** The Pro access decision made for the same request. */
  proAccess: SubscriptionAccess;
}

/**
 * Decides whether a user has credits to use, granting any trial or monthly
 * Pro allowance that is due first (idempotent: each allowance is granted
 * once per trial or per month of a term, however often this runs, also
 * concurrently). Free accounts have no allowance: nothing is granted at
 * sign-up or sign-in, so they have zero credits until they start a trial,
 * buy Pro, or receive purchased or referral credits.
 */
@Injectable()
export class CreditEligibilityService {
  constructor(
    private readonly access: SubscriptionAccessService,
    private readonly wallet: CreditWalletService,
    private readonly settings: CreditSettingsService,
  ) {}

  async getEligibility(authId: string): Promise<CreditEligibility> {
    const now = new Date();
    const { access, record } = await this.access.getAccessDetails(authId, now);
    await this.grantMissingAllowances(authId, record, now);

    const balance = await this.wallet.getBalance(authId);
    const usableBySource = Object.fromEntries(
      Object.values(CreditSource).map((source) => [source, ZERO]),
    ) as Record<CreditSource, Prisma.Decimal>;
    for (const allocation of balance.allocations) {
      if (isCreditSourceUsable(allocation.source, record, now)) {
        usableBySource[allocation.source] = usableBySource[
          allocation.source
        ].plus(allocation.remaining);
      }
    }
    const usable = Object.values(usableBySource).reduce(
      (sum, value) => sum.plus(value),
      ZERO,
    );
    return {
      eligible: usable.gt(0),
      usableCredits: usable.toFixed(),
      usableBySource: Object.fromEntries(
        Object.entries(usableBySource).map(([source, value]) => [
          source,
          value.toFixed(),
        ]),
      ) as Record<CreditSource, string>,
      proAccess: access,
    };
  }

  /**
   * Grants the trial and current monthly Pro allowances the user is due and
   * has not received yet. Returns how many were newly granted.
   */
  async grantDueAllowances(authId: string): Promise<number> {
    const now = new Date();
    const { record } = await this.access.getAccessDetails(authId, now);
    return this.grantMissingAllowances(authId, record, now);
  }

  private async grantMissingAllowances(
    authId: string,
    record: SubscriptionRecord | null,
    now: Date,
  ): Promise<number> {
    // Which allowances are due does not depend on the amounts.
    const due = dueAllowances(record, now, NO_AMOUNTS);
    const missing: DueAllowance[] = [];
    for (const allowance of due) {
      const received = await this.wallet.hasGrant(
        authId,
        allowance.source,
        allowance.sourceReference,
      );
      if (!received) missing.push(allowance);
    }
    if (missing.length === 0) return 0;

    // Amounts are the settings at the time the allowance is first granted.
    const settings = await this.settings.getSettings();
    const toGrant = dueAllowances(record, now, settings).filter((allowance) =>
      missing.some(
        (gap) =>
          gap.source === allowance.source &&
          gap.sourceReference === allowance.sourceReference,
      ),
    );
    let granted = 0;
    for (const allowance of toGrant) {
      try {
        const result = await this.wallet.grant({
          authId,
          source: allowance.source,
          sourceReference: allowance.sourceReference,
          amount: allowance.amount,
          expiresAt: allowance.expiresAt,
          description: allowance.description,
          // A concurrent request may have granted it with older settings.
          keepExistingGrant: true,
        });
        if (!result.replayed) granted += 1;
      } catch (error) {
        // The trial or month ended in the moment since `now`: nothing to
        // grant any more (the wallet refuses already-expired credits).
        if (
          error instanceof InvalidCreditOperationError &&
          allowance.expiresAt.getTime() <= Date.now()
        ) {
          continue;
        }
        throw error;
      }
    }
    return granted;
  }
}
