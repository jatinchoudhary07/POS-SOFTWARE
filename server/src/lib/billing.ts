import type { TaxLine } from '../db/schema';

/**
 * Bill arithmetic. Everything is integer paise and integer basis points (1% = 100 bps);
 * no floating-point number ever holds money.
 *
 * Rounding rule (documented in the README): any fraction of a paisa is rounded HALF UP
 * (0.5 paise -> 1 paisa), applied separately to the discount and to EACH tax line.
 *
 * Order of operations:
 *   subtotal            (sum of order lines, snapshotted when the order was placed)
 * - discount            (PERCENT of subtotal, or a fixed AMOUNT; never more than the subtotal)
 * = taxable amount
 * + each tax line       (taxable × rate, rounded per line; prices are treated as tax-EXCLUSIVE)
 * + round off           (only if "round to nearest rupee" is enabled; half up to whole rupees)
 * = total
 */

export const BPS_DENOMINATOR = 10_000;

/** Half-up rounding of (value × bps / 10000) for non-negative integers. */
export function applyBps(valuePaise: number, bps: number): number {
  assertNonNegativeInt(valuePaise, 'value');
  assertNonNegativeInt(bps, 'rate');
  const scaled = valuePaise * bps; // stays far below 2^53 for any realistic bill
  if (!Number.isSafeInteger(scaled)) throw new RangeError('Amount too large');
  return Math.floor((scaled + BPS_DENOMINATOR / 2) / BPS_DENOMINATOR);
}

/** Half-up rounding to whole rupees. Returns the signed round-off in paise (-49..+50). */
export function roundOffToRupee(paise: number): number {
  assertNonNegativeInt(paise, 'amount');
  return Math.floor((paise + 50) / 100) * 100 - paise;
}

export type DiscountInput = { type: 'NONE' } | { type: 'PERCENT'; bps: number } | { type: 'AMOUNT'; paise: number };

export interface BillInput {
  subtotalPaise: number;
  discount: DiscountInput;
  taxes: { name: string; rateBps: number }[];
  roundToRupee: boolean;
}

export interface BillBreakdown {
  subtotalPaise: number;
  discountPaise: number;
  taxablePaise: number;
  taxLines: TaxLine[];
  taxPaise: number;
  roundOffPaise: number;
  totalPaise: number;
}

export function computeBill(input: BillInput): BillBreakdown {
  const { subtotalPaise, discount, taxes, roundToRupee } = input;
  assertNonNegativeInt(subtotalPaise, 'subtotal');

  let discountPaise = 0;
  if (discount.type === 'PERCENT') {
    if (discount.bps > BPS_DENOMINATOR) throw new RangeError('Discount cannot exceed 100%');
    discountPaise = applyBps(subtotalPaise, discount.bps);
  } else if (discount.type === 'AMOUNT') {
    assertNonNegativeInt(discount.paise, 'discount');
    if (discount.paise > subtotalPaise) throw new RangeError('Discount cannot exceed the subtotal');
    discountPaise = discount.paise;
  }

  const taxablePaise = subtotalPaise - discountPaise;
  const taxLines = taxes.map((t) => ({ name: t.name, rateBps: t.rateBps, amountPaise: applyBps(taxablePaise, t.rateBps) }));
  const taxPaise = taxLines.reduce((sum, t) => sum + t.amountPaise, 0);
  const beforeRounding = taxablePaise + taxPaise;
  const roundOffPaise = roundToRupee ? roundOffToRupee(beforeRounding) : 0;

  return {
    subtotalPaise,
    discountPaise,
    taxablePaise,
    taxLines,
    taxPaise,
    roundOffPaise,
    totalPaise: beforeRounding + roundOffPaise,
  };
}

function assertNonNegativeInt(n: number, label: string) {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`Invalid ${label}: ${n}`);
}
