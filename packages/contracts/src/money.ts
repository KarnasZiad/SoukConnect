import { z } from 'zod';
import type { Locale } from './locales.js';

export const CURRENCY = 'MAD';
export const currency = z.literal(CURRENCY);

/** Integer amount in centimes of dirham. 100 million dirhams is far above any order. */
export const amount = z.int().min(0).max(10_000_000_000);

/** Commission rate in basis points: 1000 = 10 %. Capped at 50 %. */
export const commissionBps = z.int().min(0).max(5000);
export const DEFAULT_COMMISSION_BPS = 1000;

/** Commission on a sale, rounded to the nearest centime (half up). */
export function commissionOf(sale: number, bps: number): number {
  if (!Number.isSafeInteger(sale) || !Number.isSafeInteger(bps) || sale < 0 || bps < 0) {
    throw new RangeError('Amounts and rates are non-negative integers');
  }
  return Math.round((sale * bps) / 10_000);
}

export interface PricedLine {
  shopId: string;
  unitPrice: number;
  quantity: number;
  commissionBps: number;
}

export interface Share {
  shopId: string;
  amount: number;
  commissionBps: number;
}

/**
 * What each shop sells in an order, in the order shops first appear. A shop has a single rate:
 * it is frozen on every line at reservation time.
 */
export function sharesOf(lines: readonly PricedLine[]): Share[] {
  const shares = new Map<string, Share>();
  for (const line of lines) {
    const subtotal = line.unitPrice * line.quantity;
    const share = shares.get(line.shopId);
    if (!share) {
      shares.set(line.shopId, {
        shopId: line.shopId,
        amount: subtotal,
        commissionBps: line.commissionBps,
      });
    } else if (share.commissionBps !== line.commissionBps) {
      throw new Error(`Shop ${line.shopId} has two commission rates in the same order`);
    } else {
      share.amount += subtotal;
    }
  }
  return [...shares.values()];
}

export function totalOf(lines: readonly Pick<PricedLine, 'unitPrice' | 'quantity'>[]): number {
  return lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
}

const FORMAT_LOCALES: Record<Locale, string> = { fr: 'fr-MA', en: 'en', ar: 'ar-MA' };

/** "1.250,00 MAD", "MAD 1,250.00", "1.250,00 د.م." : Moroccan usage, Latin digits. */
export function formatMoney(centimes: number, locale: Locale): string {
  return new Intl.NumberFormat(FORMAT_LOCALES[locale], {
    style: 'currency',
    currency: CURRENCY,
  }).format(centimes / 100);
}
