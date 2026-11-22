import { randomUUID } from 'node:crypto';

/**
 * A small stateful stand-in for the Prisma delegates used by the Stripe
 * checkout and webhook services, for fast unit tests that assert outcomes
 * rather than call sequences. It supports equality and `{ in: [...] }`
 * filters, compound unique keys, the unique indexes the services rely on
 * (including "one pending checkout per subscription"), and serialises
 * `$transaction` callbacks the way the UserSubscription row lock does.
 *
 * It does not emulate rollbacks, CHECK constraints or triggers: the
 * PostgreSQL behaviour is covered by test/stripe-checkout.e2e-spec.ts.
 */

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !(value instanceof Date) &&
  !Array.isArray(value);

const same = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date
    ? a.getTime() === b.getTime()
    : a === b;

function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR' && Array.isArray(condition)) {
      return condition.some((alternative) =>
        matches(row, alternative as Where),
      );
    }
    if (isPlainObject(condition) && Array.isArray(condition.in)) {
      return condition.in.some((value) => same(row[key], value));
    }
    // Compound unique inputs such as `authId_provider: { authId, provider }`.
    if (isPlainObject(condition)) return matches(row, condition);
    return same(row[key], condition);
  });
}

export const uniqueViolation = () =>
  Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

class Table<T extends Row> {
  readonly rows: T[] = [];

  constructor(
    private readonly defaults: (data: Row) => T,
    private readonly uniqueKeys: ((row: T) => string | null)[] = [],
  ) {}

  findUnique = ({ where }: { where: Where }) =>
    Promise.resolve(this.find(where));

  findFirst = ({ where }: { where?: Where } = {}) =>
    Promise.resolve(this.find(where));

  findMany = ({ where }: { where?: Where } = {}) =>
    Promise.resolve(
      this.rows.filter((row) => matches(row, where)).map((row) => ({ ...row })),
    );

  findUniqueOrThrow = ({ where }: { where: Where }) => {
    const row = this.find(where);
    return row
      ? Promise.resolve(row)
      : Promise.reject(new Error('No record found'));
  };

  /** Like Prisma's native upsert: atomic here (no await between steps). */
  upsert = ({
    where,
    create,
    update,
  }: {
    where: Where;
    create: Row;
    update: Row;
  }) => {
    const row = this.rows.find((candidate) => matches(candidate, where));
    if (!row) return this.create({ data: create });
    return this.apply(row, update).then(() => ({ ...row }));
  };

  create = ({ data }: { data: Row }) => {
    const row = this.defaults(data);
    if (this.conflicts(row)) return Promise.reject(uniqueViolation());
    this.rows.push(row);
    return Promise.resolve({ ...row });
  };

  createMany = ({
    data,
    skipDuplicates,
  }: {
    data: Row[];
    skipDuplicates?: boolean;
  }) => {
    let count = 0;
    for (const item of data) {
      const row = this.defaults(item);
      if (this.conflicts(row)) {
        if (skipDuplicates) continue;
        return Promise.reject(uniqueViolation());
      }
      this.rows.push(row);
      count += 1;
    }
    return Promise.resolve({ count });
  };

  update = ({ where, data }: { where: Where; data: Row }) => {
    const row = this.rows.find((candidate) => matches(candidate, where));
    if (!row) return Promise.reject(new Error('No record found'));
    return this.apply(row, data).then(() => ({ ...row }));
  };

  updateMany = async ({ where, data }: { where: Where; data: Row }) => {
    const targets = this.rows.filter((row) => matches(row, where));
    for (const row of targets) await this.apply(row, data);
    return { count: targets.length };
  };

  private apply(row: T, data: Row): Promise<void> {
    // Prisma's `{ increment: n }` numeric update.
    const values = Object.fromEntries(
      Object.entries(data).map(([field, value]) =>
        isPlainObject(value) && typeof value.increment === 'number'
          ? [field, Number(row[field]) + value.increment]
          : [field, value],
      ),
    );
    const next = { ...row, ...values, updatedAt: new Date() } as T;
    const others = this.rows.filter((candidate) => candidate !== row);
    if (this.conflicts(next, others)) return Promise.reject(uniqueViolation());
    Object.assign(row, next);
    return Promise.resolve();
  }

  private find(where: Where = {}): T | null {
    const row = this.rows.find((candidate) => matches(candidate, where));
    return row ? { ...row } : null;
  }

  private conflicts(row: T, others: T[] = this.rows): boolean {
    return this.uniqueKeys.some((keyOf) => {
      const key = keyOf(row);
      return key !== null && others.some((other) => keyOf(other) === key);
    });
  }
}

const PENDING = ['CREATING', 'OPEN', 'PROCESSING'];

/** A column value as a key part; rows only hold strings, dates and nulls. */
const key = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value as string);

export function createInMemoryBillingPrisma() {
  let lock: Promise<unknown> = Promise.resolve();
  const now = () => new Date();

  const store = {
    authUser: new Table<Row>(
      (data) => ({
        id: randomUUID(),
        email: `${randomUUID()}@example.com`,
        status: 'ACTIVE',
        verified: true,
        deletedAt: null,
        ...data,
      }),
      [(row) => key(row.id)],
    ),
    userSubscription: new Table<Row>(
      (data) => ({
        id: randomUUID(),
        status: 'FREE',
        trialUsed: false,
        trialStartedAt: null,
        trialExpiresAt: null,
        billingInterval: null,
        proStartedAt: null,
        proExpiresAt: null,
        proCanceledAt: null,
        paymentProvider: null,
        providerSubscriptionId: null,
        pastDueSince: null,
        createdAt: now(),
        updatedAt: now(),
        ...data,
      }),
      [
        (row) => `auth:${key(row.authId)}`,
        (row) =>
          row.providerSubscriptionId
            ? `provider:${key(row.paymentProvider)}:${key(row.providerSubscriptionId)}`
            : null,
      ],
    ),
    paymentCustomer: new Table<Row>(
      (data) => ({ id: randomUUID(), createdAt: now(), ...data }),
      [
        (row) => `user:${key(row.authId)}:${key(row.provider)}`,
        (row) => `customer:${key(row.provider)}:${key(row.providerCustomerId)}`,
      ],
    ),
    checkoutSession: new Table<Row>(
      (data) => ({
        id: randomUUID(),
        status: 'CREATING',
        currency: 'USD',
        providerSessionId: null,
        providerSubscriptionId: null,
        url: null,
        completedAt: null,
        closedAt: null,
        closedReason: null,
        paymentId: null,
        // Column defaults of the checkout discount (migration
        // 20261204120000_add_checkout_discounts).
        discountSource: null,
        discountOfferId: null,
        discountPercent: 0,
        discountCents: 0,
        requestedDiscountCode: null,
        createdAt: now(),
        updatedAt: now(),
        ...data,
      }),
      [
        (row) =>
          row.providerSessionId
            ? `session:${key(row.provider)}:${key(row.providerSessionId)}`
            : null,
        // The partial unique index "one pending checkout per subscription".
        (row) =>
          PENDING.includes(key(row.status))
            ? `pending:${key(row.subscriptionId)}`
            : null,
      ],
    ),
    paymentTransaction: new Table<Row>(
      (data) => ({
        id: randomUUID(),
        currency: 'USD',
        providerInvoiceId: null,
        failedAt: null,
        failureCode: null,
        failureMessage: null,
        refundedAmountCents: 0,
        refundedAt: null,
        createdAt: now(),
        updatedAt: now(),
        ...data,
      }),
      [(row) => `payment:${key(row.provider)}:${key(row.providerPaymentId)}`],
    ),
    paymentRefund: new Table<Row>(
      (data) => ({
        id: randomUUID(),
        currency: 'USD',
        reason: null,
        createdAt: now(),
        updatedAt: now(),
        ...data,
      }),
      [(row) => `refund:${key(row.provider)}:${key(row.providerRefundId)}`],
    ),
    paymentWebhookEvent: new Table<Row>(
      (data) => ({
        id: randomUUID(),
        objectId: null,
        status: 'RECEIVED',
        outcome: null,
        attempts: 1,
        lastErrorCode: null,
        receivedAt: now(),
        processedAt: null,
        updatedAt: now(),
        ...data,
      }),
      [(row) => `event:${key(row.provider)}:${key(row.providerEventId)}`],
    ),
    subscriptionEvent: new Table<Row>(
      (data) => ({ id: randomUUID(), createdAt: now(), ...data }),
      [(row) => (row.paymentId ? `payment:${key(row.paymentId)}` : null)],
    ),
    /** Row locks are modelled by running transactions one at a time. */
    $queryRaw: () => Promise.resolve([]),
    $transaction: <R>(callback: (tx: unknown) => Promise<R>): Promise<R> => {
      const run = lock.then(() => callback(store));
      lock = run.catch(() => undefined);
      return run;
    },
  };
  return store;
}

export type InMemoryBillingPrisma = ReturnType<
  typeof createInMemoryBillingPrisma
>;
