import { describe, expect, it } from 'vitest';
import type { MenuItem } from '../api/types';
import {
  cartItemCount,
  cartProblem,
  cartReducer,
  cartSubtotal,
  createEmptyCart,
  type CartAction,
  type CartState,
  toCreateOrderRequest,
} from './cart';

const item = (id: number, pricePaise: number, extra: Partial<MenuItem> = {}): MenuItem => ({
  id,
  categoryId: 1,
  name: `Item ${id}`,
  description: null,
  pricePaise,
  isAvailable: true,
  isVeg: true,
  ...extra,
});

const run = (actions: CartAction[], start: CartState = createEmptyCart()) => actions.reduce(cartReducer, start);

describe('cart', () => {
  it('adds items, increments existing lines and computes subtotal in paise', () => {
    const s = run([
      { type: 'add', item: item(1, 24000) },
      { type: 'add', item: item(1, 24000) },
      { type: 'add', item: item(2, 5050) },
    ]);
    expect(s.lines.map((l) => [l.menuItemId, l.quantity])).toEqual([[1, 2], [2, 1]]);
    expect(cartSubtotal(s)).toBe(2 * 24000 + 5050);
    expect(cartItemCount(s)).toBe(3);
  });

  it('refuses to add unavailable items', () => {
    const s = run([{ type: 'add', item: item(1, 100, { isAvailable: false }) }]);
    expect(s.lines).toHaveLength(0);
  });

  it('decrement below 1 removes the line; remove deletes it', () => {
    let s = run([{ type: 'add', item: item(1, 100) }, { type: 'add', item: item(2, 100) }]);
    s = cartReducer(s, { type: 'decrement', menuItemId: 1 });
    expect(s.lines.map((l) => l.menuItemId)).toEqual([2]);
    s = cartReducer(s, { type: 'remove', menuItemId: 2 });
    expect(s.lines).toHaveLength(0);
  });

  it('clamps invalid quantities to 1..99', () => {
    let s = run([{ type: 'add', item: item(1, 100) }]);
    s = cartReducer(s, { type: 'setQuantity', menuItemId: 1, quantity: 500 });
    expect(s.lines[0].quantity).toBe(99);
    s = cartReducer(s, { type: 'setQuantity', menuItemId: 1, quantity: -3 });
    expect(s.lines[0].quantity).toBe(1);
    s = cartReducer(s, { type: 'setQuantity', menuItemId: 1, quantity: Number.NaN });
    expect(s.lines[0].quantity).toBe(1);
    s = cartReducer(s, { type: 'setQuantity', menuItemId: 1, quantity: 99 });
    s = cartReducer(s, { type: 'increment', menuItemId: 1 });
    expect(s.lines[0].quantity).toBe(99);
  });

  it('reports problems for empty carts and unavailable lines', () => {
    expect(cartProblem(createEmptyCart())).toMatch(/at least one/);
    let s = run([{ type: 'add', item: item(1, 100) }]);
    expect(cartProblem(s)).toBeNull();
    s = cartReducer(s, { type: 'markUnavailable', menuItemIds: [1] });
    expect(cartProblem(s)).toMatch(/unavailable/);
  });

  it('syncs price and availability from a refreshed menu', () => {
    let s = run([{ type: 'add', item: item(1, 100) }, { type: 'add', item: item(2, 100) }]);
    s = cartReducer(s, {
      type: 'syncMenu',
      categories: [{ id: 1, name: 'C', items: [item(1, 150, { isAvailable: false })] }],
    });
    expect(s.lines[0]).toMatchObject({ unitPricePaise: 150, available: false });
    expect(s.lines[1].available).toBe(false); // item 2 no longer on menu
  });

  it('builds the API request: trims fields and drops table for takeaway', () => {
    let s = run([
      { type: 'add', item: item(1, 100) },
      { type: 'setTable', tableNumber: ' 12 ' },
      { type: 'setNotes', notes: '  no onion ' },
    ]);
    expect(toCreateOrderRequest(s)).toEqual({
      clientRequestId: s.requestId,
      orderType: 'DINE_IN',
      tableNumber: '12',
      notes: 'no onion',
      items: [{ menuItemId: 1, quantity: 1 }],
    });
    s = cartReducer(s, { type: 'setOrderType', orderType: 'TAKEAWAY' });
    expect(toCreateOrderRequest(s).tableNumber).toBeUndefined();
  });

  it('reset clears lines and issues a new request id but keeps the order type', () => {
    const s = run([{ type: 'setOrderType', orderType: 'TAKEAWAY' }, { type: 'add', item: item(1, 100) }]);
    const r = cartReducer(s, { type: 'reset' });
    expect(r.lines).toHaveLength(0);
    expect(r.requestId).not.toBe(s.requestId);
    expect(r.orderType).toBe('TAKEAWAY');
  });

  it('marks a dine-in batch as packed, sends the flag per dish, and clears it after sending or for takeaway', () => {
    let s = run([{ type: 'setOrderType', orderType: 'DINE_IN' }, { type: 'setTable', tableNumber: '3', tableId: 3 }, { type: 'add', item: item(1, 100) }]);
    expect(toCreateOrderRequest(s).items).toEqual([{ menuItemId: 1, quantity: 1 }]); // nothing extra unless asked
    s = cartReducer(s, { type: 'setPacked', packed: true });
    expect(toCreateOrderRequest(s).items).toEqual([{ menuItemId: 1, quantity: 1, packed: true }]);
    expect(cartReducer(s, { type: 'reset' }).packed).toBe(false); // the next batch starts as eat-in
    const t = cartReducer(s, { type: 'setOrderType', orderType: 'TAKEAWAY' });
    expect(t.packed).toBe(false);
    expect(cartReducer(t, { type: 'setPacked', packed: true }).packed).toBe(false); // packing orders are all packed already
    expect(toCreateOrderRequest(t).items).toEqual([{ menuItemId: 1, quantity: 1 }]);
  });
});
