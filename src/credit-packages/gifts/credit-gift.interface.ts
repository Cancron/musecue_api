import type { CreditGiftStatus, CreditPackageCode } from '@prisma/client';

/** A gift as its sender or recipient sees it. */
export interface CreditGiftView {
  id: string;
  /** `sender` or `recipient`: the caller's role in this gift. */
  role: 'sender' | 'recipient';
  status: CreditGiftStatus;
  /** The other user (username only). */
  sender: { id: string; username: string } | null;
  recipient: { id: string; username: string } | null;
  packageCode: CreditPackageCode;
  credits: number;
  message: string | null;
  deliverAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  declinedAt: string | null;
  canceledAt: string | null;
  paidAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  /** Sender only: the list price and the current checkout, if any. */
  listPriceUsdCents?: number;
  checkout?: {
    orderId: string;
    status: string;
    amountDueUsdCents: number;
    checkoutUrl: string | null;
  } | null;
  replayed?: boolean;
}
