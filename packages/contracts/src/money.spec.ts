import { describe, expect, it } from 'vitest';
import { amount, commissionOf, formatMoney, sharesOf, totalOf } from './money.js';

const shopA = '0199f0a4-7a5b-7c1e-9f00-000000000001';
const shopB = '0199f0a4-7a5b-7c1e-9f00-000000000002';

describe('commissionOf', () => {
  it('applies a rate in basis points, rounded to the nearest centime', () => {
    expect(commissionOf(450_000, 1000)).toBe(45_000);
    expect(commissionOf(12_345, 1000)).toBe(1235); // 1234.5 rounds half up
    expect(commissionOf(12_344, 1000)).toBe(1234);
    expect(commissionOf(999, 0)).toBe(0);
  });

  it('refuses fractional or negative inputs', () => {
    expect(() => commissionOf(10.5, 1000)).toThrow(RangeError);
    expect(() => commissionOf(-1, 1000)).toThrow(RangeError);
    expect(() => commissionOf(100, -5)).toThrow(RangeError);
  });
});

describe('sharesOf', () => {
  it('sums the lines of each shop, in the order shops first appear', () => {
    const shares = sharesOf([
      { shopId: shopB, unitPrice: 20_000, quantity: 2, commissionBps: 800 },
      { shopId: shopA, unitPrice: 450_000, quantity: 1, commissionBps: 1000 },
      { shopId: shopB, unitPrice: 5_000, quantity: 3, commissionBps: 800 },
    ]);

    expect(shares).toEqual([
      { shopId: shopB, amount: 55_000, commissionBps: 800 },
      { shopId: shopA, amount: 450_000, commissionBps: 1000 },
    ]);
  });

  it('refuses two rates for the same shop', () => {
    expect(() =>
      sharesOf([
        { shopId: shopA, unitPrice: 100, quantity: 1, commissionBps: 1000 },
        { shopId: shopA, unitPrice: 100, quantity: 1, commissionBps: 900 },
      ]),
    ).toThrow(/two commission rates/);
  });

  it('totals the lines', () => {
    expect(
      totalOf([
        { unitPrice: 20_000, quantity: 2 },
        { unitPrice: 5_000, quantity: 1 },
      ]),
    ).toBe(45_000);
  });
});

describe('amount', () => {
  it('accepts integer centimes only', () => {
    expect(amount.safeParse(450_000).success).toBe(true);
    expect(amount.safeParse(12.5).success).toBe(false);
    expect(amount.safeParse(-1).success).toBe(false);
  });
});

describe('formatMoney', () => {
  it('follows the Moroccan usage of each language', () => {
    // Intl separates the amount and the currency with a no-break space.
    expect(formatMoney(125_000, 'fr').replace(/\s/g, ' ')).toBe('1.250,00 MAD');
    expect(formatMoney(125_000, 'en').replace(/\s/g, ' ')).toBe('MAD 1,250.00');
    expect(formatMoney(125_000, 'ar')).toContain('1.250,00');
    expect(formatMoney(125_000, 'ar')).toContain('د.م.');
  });
});
