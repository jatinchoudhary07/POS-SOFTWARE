import type { CartState } from './cart';

/**
 * Keeps the unsent order in localStorage so a page refresh (or switching to the kitchen
 * view and back) never loses it. The draft's requestId is kept too, so re-sending after a
 * refresh is still protected against duplicates.
 */
const KEY = 'pos.draft.v1';

export function loadDraft(): CartState | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? parseDraft(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveDraft(cart: CartState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cart));
  } catch {
    // Storage full or blocked (private mode): the draft simply isn't persisted.
  }
}

/** Accepts only a well-formed draft; anything else is discarded. */
export function parseDraft(v: unknown): CartState | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as Record<string, unknown>;
  if (typeof d.requestId !== 'string' || d.requestId.length < 8) return null;
  if (d.orderType !== 'DINE_IN' && d.orderType !== 'TAKEAWAY') return null;
  if (typeof d.tableNumber !== 'string' || typeof d.notes !== 'string' || !Array.isArray(d.lines)) return null;
  const linesOk = d.lines.every(
    (l) =>
      l &&
      typeof l === 'object' &&
      Number.isInteger(l.menuItemId) &&
      typeof l.name === 'string' &&
      Number.isInteger(l.unitPricePaise) &&
      Number.isInteger(l.quantity) &&
      l.quantity >= 1 &&
      l.quantity <= 99 &&
      typeof l.available === 'boolean',
  );
  // drafts saved before customer details existed have no such fields
  return linesOk
    ? ({ ...d, customerName: typeof d.customerName === 'string' ? d.customerName : '', customerPhone: typeof d.customerPhone === 'string' ? d.customerPhone : '', packed: d.packed === true && d.orderType === 'DINE_IN' } as unknown as CartState)
    : null;
}
