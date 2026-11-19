import { Injectable } from '@nestjs/common';
import { CreditSource, Prisma } from '@prisma/client';
import { CreditSettingsService } from '../credits/credit-settings.service';
import { InvalidCreditOperationError } from '../credits/credit-wallet.errors';
import { CreditWalletService } from '../credits/credit-wallet.service';
import {
  dueTrialAllowance,
  isCreditSourceUsable,
} from './credit-allowance.policy';
import { CreditAllowanceService } from './credit-allowance.service';
import {
  isProActive,
  type SubscriptionAccess,
  type SubscriptionRecord,
} from './subscription-access.policy';
import { SubscriptionAccessService } from './subscription-access.service';

const ZERO = new Prisma.Decimal(0);

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
 * Decides whether a user has credits to use. Allowances are normally
 * granted by the events that pay for them (trial activation, successful Pro
 * payments); before deciding, any allowance still missing is granted here:
 * a trial activated before trial credits existed, a later month of a yearly
 * payment, or a payment recorded before payments granted credits. This never
 * grants twice and never grants Pro credits without a successful payment.
 * Free accounts have no allowance: nothing is granted at sign-up or sign-in.
 */
@Injectable()
export class CreditEligibilityService {
  constructor(
    private readonly access: SubscriptionAccessService,
    private readonly wallet: CreditWalletService,
    private readonly settings: CreditSettingsService,
    private readonly allowances: CreditAllowanceService,
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

  /** Grants missing trial and Pro allowances; returns how many were granted. */
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
    let granted = 0;
    if (await this.grantMissingTrialAllowance(authId, record, now)) {
      granted += 1;
    }
    if (isProActive(record, now)) {
      const outcome = await this.allowances.grantCurrentPaidPeriod(authId, now);
      if (outcome === 'GRANTED') granted += 1;
    }
    return granted;
  }

  private async grantMissingTrialAllowance(
    authId: string,
    record: SubscriptionRecord | null,
    now: Date,
  ): Promise<boolean> {
    // Which trial allowance is due does not depend on the amount.
    const due = dueTrialAllowance(record, now, 0);
    if (!due) return false;
    if (await this.wallet.hasGrant(authId, due.source, due.sourceReference)) {
      return false;
    }
    // The amount is the setting at the time the allowance is first granted.
    const { trialCredits } = await this.settings.getSettings();
    try {
      const result = await this.wallet.grant({
        authId,
        source: due.source,
        sourceReference: due.sourceReference,
        amount: trialCredits,
        expiresAt: due.expiresAt,
        description: due.description,
        // A concurrent request may have granted it with older settings.
        keepExistingGrant: true,
      });
      return !result.replayed;
    } catch (error) {
      // The trial ended in the moment since `now`: nothing to grant any
      // more (the wallet refuses already-expired credits).
      if (
        error instanceof InvalidCreditOperationError &&
        due.expiresAt.getTime() <= Date.now()
      ) {
        return false;
      }
      throw error;
    }
  }
}
