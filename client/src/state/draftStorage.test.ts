import { describe, expect, it } from 'vitest';
import { createEmptyCart } from './cart';
import { parseDraft } from './draftStorage';

describe('parseDraft', () => {
  it('round-trips a valid draft including its requestId', () => {
    const cart = {
      ...createEmptyCart(),
      tableNumber: '4',
      lines: [{ menuItemId: 1, name: 'Naan', unitPricePaise: 5000, quantity: 2, available: true }],
    };
    expect(parseDraft(JSON.parse(JSON.stringify(cart)))).toEqual(cart);
  });

  it.each([
    null,
    'x',
    { requestId: 'short', orderType: 'DINE_IN', tableNumber: '', notes: '', lines: [] },
    { requestId: 'abcdefgh-1', orderType: 'DELIVERY', tableNumber: '', notes: '', lines: [] },
    { requestId: 'abcdefgh-1', orderType: 'TAKEAWAY', tableNumber: '', notes: '', lines: [{ menuItemId: 1, name: 'x', unitPricePaise: 1, quantity: 0, available: true }] },
  ])('rejects malformed drafts: %j', (v) => {
    expect(parseDraft(v)).toBeNull();
  });
});
