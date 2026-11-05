/**
 * Human-readable order numbers: YYMMDD-NNN, e.g. "261021-007" is the 7th order
 * on 21 Oct 2026. The counter restarts every day, so numbers stay short enough to
 * call out across the counter. Uses the reception computer's local date.
 */
export function orderNumberPrefix(date: Date): string {
  const yy = String(date.getFullYear() % 100).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

export function formatOrderNumber(date: Date, sequence: number): string {
  return `${orderNumberPrefix(date)}-${String(sequence).padStart(3, '0')}`;
}

/** Extracts the daily sequence from an order number ("261021-007" -> 7). */
export function parseSequence(orderNumber: string): number {
  const seq = Number(orderNumber.split('-')[1]);
  return Number.isInteger(seq) ? seq : 0;
}
