import { commissionOf, type Share } from '@soukconnect/contracts';
import { PermanentError } from '@soukconnect/messaging';

export type EntryKind = 'SALE' | 'COMMISSION' | 'REFUND' | 'COMMISSION_REVERSAL';

export interface Entry {
  shopId: string;
  kind: EntryKind;
  /** Signed centimes: what the platform owes the shop (+) or keeps from it (−). */
  amount: number;
}

/** The shares must add up to the amount charged: payments never trusts a total alone. */
export function assertShares(shares: readonly Share[], amount: number): void {
  const sum = shares.reduce((total, share) => total + share.amount, 0);
  if (sum !== amount) {
    throw new PermanentError(`Shares add up to ${sum}, the payment is ${amount}`);
  }
  if (new Set(shares.map((share) => share.shopId)).size !== shares.length) {
    throw new PermanentError('A shop appears twice in the shares');
  }
}

/**
 * Entries of a successful payment (US-13): for each shop, the sale and the commission of the
 * platform, rounded to the nearest centime on the share of the shop.
 */
export function saleEntries(shares: readonly Share[], amount: number): Entry[] {
  assertShares(shares, amount);
  return shares.flatMap((share) => [
    { shopId: share.shopId, kind: 'SALE' as const, amount: share.amount },
    {
      shopId: share.shopId,
      kind: 'COMMISSION' as const,
      amount: -commissionOf(share.amount, share.commissionBps),
    },
  ]);
}

/** A full refund reverses every sale and every commission: the balance of the order is zero. */
export function refundEntries(shares: readonly Share[]): Entry[] {
  return shares.flatMap((share) => [
    { shopId: share.shopId, kind: 'REFUND' as const, amount: -share.amount },
    {
      shopId: share.shopId,
      kind: 'COMMISSION_REVERSAL' as const,
      amount: commissionOf(share.amount, share.commissionBps),
    },
  ]);
}

export interface Balance {
  sales: number;
  commission: number;
  refunds: number;
  net: number;
}

/** What a shop earned over a set of entries: sales minus commissions, net of refunds. */
export function balanceOf(entries: readonly Pick<Entry, 'kind' | 'amount'>[]): Balance {
  const sum = (kinds: EntryKind[]) =>
    entries
      .filter((entry) => kinds.includes(entry.kind))
      .reduce((total, entry) => total + entry.amount, 0);
  const sales = sum(['SALE']);
  // 0 - x rather than -x: an empty sum gives 0, not -0.
  const commission = 0 - sum(['COMMISSION', 'COMMISSION_REVERSAL']);
  const refunds = 0 - sum(['REFUND']);
  return { sales, commission, refunds, net: sales - commission - refunds };
}
