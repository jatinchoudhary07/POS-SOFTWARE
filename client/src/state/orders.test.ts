import { describe, expect, it } from 'vitest';
import type { Order, OrderStatus } from '../api/types';
import { isNewer, kitchenLanes, mergeSnapshot, recentOrders, upsertOrder, type OrderMap } from './orders';

const T0 = Date.parse('2026-10-21T10:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function order(id: number, status: OrderStatus = 'NEW', createdMin = id, updatedMin = createdMin): Order {
  return {
    id,
    orderNumber: `261021-${String(id).padStart(3, '0')}`,
    orderType: 'TAKEAWAY',
    tableNumber: null,
    notes: null,
    status,
    paymentStatus: 'UNPAID',
    paymentMethod: null,
    billTotalPaise: null,
    subtotalPaise: 1000,
    itemCount: 1,
    createdAt: at(createdMin),
    updatedAt: at(updatedMin),
    items: [],
  };
}
const mapOf = (...orders: Order[]): OrderMap => new Map(orders.map((o) => [o.id, o]));

describe('upsertOrder', () => {
  it('adds a new order and replaces an older version', () => {
    let m = upsertOrder(new Map(), order(1));
    expect(m.get(1)?.status).toBe('NEW');
    m = upsertOrder(m, order(1, 'PREPARING', 1, 2));
    expect(m.get(1)?.status).toBe('PREPARING');
  });

  it('ignores duplicates and stale (out-of-order) events, returning the same map', () => {
    const m = mapOf(order(1, 'READY', 1, 5));
    expect(upsertOrder(m, order(1, 'READY', 1, 5))).toBe(m); // exact duplicate
    expect(upsertOrder(m, order(1, 'PREPARING', 1, 3))).toBe(m); // late event
  });

  it('breaks updatedAt ties by workflow position', () => {
    expect(isNewer(order(1, 'READY', 1, 5), order(1, 'PREPARING', 1, 5))).toBe(true);
    expect(isNewer(order(1, 'PREPARING', 1, 5), order(1, 'READY', 1, 5))).toBe(false);
  });
});

describe('mergeSnapshot', () => {
  it('does not duplicate an order present in both the snapshot and an event', () => {
    let m = upsertOrder(new Map(), order(1)); // event arrived first
    m = mergeSnapshot(m, [order(1), order(2)]);
    expect([...m.keys()].sort()).toEqual([1, 2]);
    expect(kitchenLanes(m).NEW).toHaveLength(2);
  });

  it('keeps a newer local version if an event beat the snapshot response', () => {
    const m = mergeSnapshot(mapOf(order(1, 'PREPARING', 1, 4)), [order(1, 'NEW', 1, 1)]);
    expect(m.get(1)?.status).toBe('PREPARING');
  });

  it('applies changes missed while disconnected', () => {
    const m = mergeSnapshot(mapOf(order(1, 'NEW')), [order(1, 'READY', 1, 9), order(2)]);
    expect(m.get(1)?.status).toBe('READY');
    expect(m.has(2)).toBe(true);
  });

  it('drops an active order that finished while disconnected, but keeps old history', () => {
    const local = mapOf(order(1, 'PREPARING'), order(2, 'COMPLETED'));
    const m = mergeSnapshot(local, [order(3)]);
    expect(m.has(1)).toBe(false); // would otherwise stay on the kitchen screen forever
    expect(m.has(2)).toBe(true); // served history beyond the snapshot limit
  });

  it('keeps an active order created by an event during the snapshot request', () => {
    const m = mergeSnapshot(mapOf(order(5)), [order(1)], new Set([5]));
    expect(m.has(5)).toBe(true);
  });
});

describe('kitchenLanes', () => {
  it('groups active orders by status, oldest first, and leaves served orders out', () => {
    const m = mapOf(
      order(3, 'NEW', 30),
      order(1, 'NEW', 10),
      order(2, 'PREPARING', 20),
      order(4, 'READY', 5),
      order(5, 'COMPLETED', 1),
    );
    const lanes = kitchenLanes(m);
    expect(lanes.NEW.map((o) => o.id)).toEqual([1, 3]);
    expect(lanes.PREPARING.map((o) => o.id)).toEqual([2]);
    expect(lanes.READY.map((o) => o.id)).toEqual([4]);
  });

  it('does not reorder a lane when another order changes status', () => {
    let m: OrderMap = mapOf(order(1, 'PREPARING', 10), order(2, 'PREPARING', 20), order(3, 'PREPARING', 30));
    m = upsertOrder(m, order(2, 'READY', 20, 40));
    expect(kitchenLanes(m).PREPARING.map((o) => o.id)).toEqual([1, 3]);
  });
});

describe('recentOrders', () => {
  it('returns newest first, with optional status filter', () => {
    const m = mapOf(order(1, 'COMPLETED', 1), order(2, 'READY', 2), order(3, 'NEW', 3));
    expect(recentOrders(m).map((o) => o.id)).toEqual([3, 2, 1]);
    expect(recentOrders(m, 'READY').map((o) => o.id)).toEqual([2]);
  });
});
