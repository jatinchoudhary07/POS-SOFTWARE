/**
 * Parsing what the cashier types. Amounts are parsed as STRINGS into integer paise / basis
 * points — never via parseFloat — so "0.10" + "0.20" can never become 0.30000000000000004.
 */

/** "530" -> 53000, "530.5" -> 53050, "530.05" -> 53005, "1,200" -> 120000; invalid -> null */
export function parseRupeesToPaise(input: string): number | null {
  const s = input.trim().replace(/,/g, '').replace(/^₹\s*/, '');
  const m = /^(\d{1,7})(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** "2.5" -> 250 bps, "18" -> 1800, "0.25" -> 25; more than 2 decimals or > 100% -> null */
export function parsePercentToBps(input: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{0,2}))?$/.exec(input.trim().replace(/%$/, ''));
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bps <= 10_000 ? bps : null;
}

/** 250 -> "2.5%", 1800 -> "18%", 25 -> "0.25%" */
export function formatBps(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = String(bps % 100).padStart(2, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''}%`;
}

/** 53050 -> "530.50" (for pre-filling inputs) */
export function paiseToInput(paise: number): string {
  return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;
}

/**
 * Handy "customer gave a round note" amounts above the total: the next multiples of
 * ₹10/50/100/500/2000, without duplicates, at most 3.
 */
export function quickCashAmounts(totalPaise: number): number[] {
  const out: number[] = [];
  for (const step of [1000, 5000, 10000, 50000, 200000]) {
    const v = Math.ceil(totalPaise / step) * step;
    if (v > totalPaise && !out.includes(v)) out.push(v);
    if (out.length === 3) break;
  }
  return out;
}
