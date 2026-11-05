/**
 * Random id for each draft order (sent as clientRequestId so retries never create duplicates).
 *
 * Note: crypto.randomUUID() only exists on "secure" pages (https or localhost). The kitchen /
 * reception computers open the app over plain http://192.168.x.x, where it is undefined —
 * so we fall back to crypto.getRandomValues(), which works everywhere.
 */
export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
