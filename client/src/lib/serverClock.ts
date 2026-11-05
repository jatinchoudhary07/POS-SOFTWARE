/**
 * The kitchen computer's clock may differ from the reception computer's. Elapsed times are
 * computed against the SERVER's clock: every API response carries a standard `Date` header,
 * from which we keep a running estimate of the offset (second precision is plenty here).
 */
let offsetMs = 0;

export function recordServerDate(dateHeader: string | null): void {
  if (!dateHeader) return;
  const server = Date.parse(dateHeader);
  if (!Number.isNaN(server)) offsetMs = server - Date.now();
}

/** Current time according to the server. */
export function serverNow(): number {
  return Date.now() + offsetMs;
}
