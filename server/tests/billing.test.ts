import { describe, expect, it } from 'vitest';
import { applyBps, computeBill, roundOffToRupee } from '../src/lib/billing';

describe('applyBps (half-up rounding to whole paise)', () => {
  it.each([
    [10000, 500, 500], // 5% of ₹100 = ₹5.00
    [33333, 250, 833], // 2.5% of ₹333.33 = 833.325 -> 833
    [10001, 250, 250], // 250.025 -> 250
    [10020, 250, 251], // 250.5 exactly -> 251 (half up)
    [1, 5000, 1], // 0.5 -> 1
    [1, 4999, 0], // 0.4999 -> 0
    [0, 1800, 0],
    [12345, 0, 0],
  ])('%i paise × %i bps = %i paise', (value, bps, expected) => {
    expect(applyBps(value, bps)).toBe(expected);
  });

  it('rejects negative or fractional inputs', () => {
    expect(() => applyBps(-1, 100)).toThrow();
    expect(() => applyBps(100.5, 100)).toThrow();
    expect(() => applyBps(100, 2.5)).toThrow();
  });
});

describe('roundOffToRupee', () => {
  it.each([
    [53049, -49],
    [53050, 50], // exactly 50 paise rounds up
    [53000, 0],
    [53099, 1],
  ])('%i -> %i', (paise, off) => {
    expect(roundOffToRupee(paise)).toBe(off);
    expect((paise + off) % 100).toBe(0);
  });
});

describe('computeBill', () => {
  it('with no taxes and no discount, total = subtotal', () => {
    const b = computeBill({ subtotalPaise: 63000, discount: { type: 'NONE' }, taxes: [], roundToRupee: false });
    expect(b).toEqual({ subtotalPaise: 63000, discountPaise: 0, taxablePaise: 63000, taxLines: [], taxPaise: 0, roundOffPaise: 0, totalPaise: 63000 });
  });

  it('applies the discount before tax and rounds each tax line separately', () => {
    const b = computeBill({
      subtotalPaise: 53050, // ₹530.50
      discount: { type: 'PERCENT', bps: 1000 }, // 10% = 5305
      taxes: [
        { name: 'CGST', rateBps: 250 },
        { name: 'SGST', rateBps: 250 },
      ],
      roundToRupee: false,
    });
    expect(b.discountPaise).toBe(5305);
    expect(b.taxablePaise).toBe(47745);
    // 47745 × 2.5% = 1193.625 -> 1194 per line
    expect(b.taxLines).toEqual([
      { name: 'CGST', rateBps: 250, amountPaise: 1194 },
      { name: 'SGST', rateBps: 250, amountPaise: 1194 },
    ]);
    expect(b.taxPaise).toBe(2388);
    expect(b.totalPaise).toBe(47745 + 2388);
  });

  it('adds a round-off line when enabled, and the parts always add up', () => {
    const b = computeBill({ subtotalPaise: 53050, discount: { type: 'NONE' }, taxes: [{ name: 'GST', rateBps: 500 }], roundToRupee: true });
    // 53050 + 2653 (2652.5 -> 2653) = 55703 -> round off -3 -> 55700
    expect(b.taxPaise).toBe(2653);
    expect(b.roundOffPaise).toBe(-3);
    expect(b.totalPaise).toBe(55700);
    expect(b.taxablePaise + b.taxPaise + b.roundOffPaise).toBe(b.totalPaise);
  });

  it('supports a fixed-amount discount and caps discounts at the subtotal', () => {
    expect(computeBill({ subtotalPaise: 10000, discount: { type: 'AMOUNT', paise: 2500 }, taxes: [], roundToRupee: false }).totalPaise).toBe(7500);
    expect(computeBill({ subtotalPaise: 10000, discount: { type: 'PERCENT', bps: 10000 }, taxes: [], roundToRupee: false }).totalPaise).toBe(0);
    expect(() => computeBill({ subtotalPaise: 10000, discount: { type: 'AMOUNT', paise: 10001 }, taxes: [], roundToRupee: false })).toThrow();
    expect(() => computeBill({ subtotalPaise: 10000, discount: { type: 'PERCENT', bps: 10001 }, taxes: [], roundToRupee: false })).toThrow();
  });

  it('never produces fractional paise (property check over many inputs)', () => {
    for (let subtotal = 0; subtotal < 5000; subtotal += 37) {
      for (const bps of [0, 1, 250, 500, 1200, 1800, 2800]) {
        const b = computeBill({ subtotalPaise: subtotal, discount: { type: 'PERCENT', bps: 333 }, taxes: [{ name: 'T', rateBps: bps }], roundToRupee: subtotal % 2 === 0 });
        for (const v of [b.discountPaise, b.taxablePaise, b.taxPaise, b.roundOffPaise, b.totalPaise]) expect(Number.isInteger(v)).toBe(true);
        expect(b.taxablePaise + b.taxPaise + b.roundOffPaise).toBe(b.totalPaise);
      }
    }
  });
});
