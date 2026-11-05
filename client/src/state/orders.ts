import type { LiveOrder, OrderStatus } from '../api/types';

/**
 * Client-side copy of the orders, merged from two sources:
 *   1. REST snapshots (on first load and after every reconnect)
 *   2. Socket.IO events ('order.created' / 'order.updated')
 * The same order can arrive from both, in any order, so every merge is "newest wins".
 * These are pure functions (no React) so they are easy to test.
 */

export type OrderMap = ReadonlyMap<number, LiveOrder>;

export const ACTIVE_STATUSES: readonly OrderStatus[] = ['NEW', 'PREPARING', 'READY'];
export const isActive = (o: LiveOrder) => ACTIVE_STATUSES.includes(o.status);

// Workflow position, used as a tie-breaker when two versions share the same updatedAt.
const RANK: Record<OrderStatus, number> = { NEW: 0, PREPARING: 1, READY: 2, COMPLETED: 3, CANCELLED: 4 };

/** Is `a` a newer version of the same order than `b`? */
export function isNewer(a: LiveOrder, b: LiveOrder): boolean {
  const ta = Date.parse(a.updatedAt);
  const tb = Date.parse(b.updatedAt);
  return ta !== tb ? ta > tb : RANK[a.status] > RANK[b.status];
}

/** Adds or replaces one order. Returns the SAME map if nothing changed (so React skips a render). */
export function upsertOrder(map: OrderMap, order: LiveOrder): OrderMap {
  const current = map.get(order.id);
  if (current && !isNewer(order, current)) return map;
  const next = new Map<number, LiveOrder>(map);
  next.set(order.id, order);
  return next;
}

/**
 * Applies a fresh REST snapshot. The snapshot is the truth, except:
 *  - a local copy that is newer (an event arrived while the request was in flight) is kept;
 *  - local orders missing from the snapshot are kept if they are history (served/cancelled,
 *    just older than the snapshot's limit) or were touched by an event during the request.
 * A local ACTIVE order that is missing from the snapshot must have finished while we were
 * disconnected, so it is dropped — otherwise it would haunt the kitchen screen forever.
 */
export function mergeSnapshot(map: OrderMap, snapshot: LiveOrder[], touchedDuringSync: ReadonlySet<number> = new Set()): OrderMap {
  const next = new Map<number, LiveOrder>();
  for (const order of snapshot) {
    const local = map.get(order.id);
    next.set(order.id, local && isNewer(local, order) ? local : order);
  }
  for (const [id, local] of map) {
    if (next.has(id)) continue;
    if (!isActive(local) || touchedDuringSync.has(id)) next.set(id, local);
  }
  return next;
}

const byCreatedAsc = (a: LiveOrder, b: LiveOrder) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id;

export interface KitchenLanes {
  NEW: LiveOrder[];
  PREPARING: LiveOrder[];
  READY: LiveOrder[];
}

/**
 * Kitchen columns. Each column is sorted oldest-first by creation time, which never changes,
 * so tickets don't jump around while staff are reading them — a ticket only moves when its
 * own status changes, and new tickets always join the end of "New".
 */
export function kitchenLanes(map: OrderMap): KitchenLanes {
  const lanes: KitchenLanes = { NEW: [], PREPARING: [], READY: [] };
  for (const o of map.values()) {
    if (o.status === 'NEW' || o.status === 'PREPARING' || o.status === 'READY') lanes[o.status].push(o);
  }
  lanes.NEW.sort(byCreatedAsc);
  lanes.PREPARING.sort(byCreatedAsc);
  lanes.READY.sort(byCreatedAsc);
  return lanes;
}

/** Reception history: newest first, optionally filtered by status. */
export function recentOrders(map: OrderMap, status?: OrderStatus, limit = 100): LiveOrder[] {
  return [...map.values()]
    .filter((o) => !status || o.status === status)
    .sort((a, b) => byCreatedAsc(b, a))
    .slice(0, limit);
}

/** The next step each role can take. Mirrors the server's rules (the server still decides). */
export const NEXT_STATUS: Partial<Record<OrderStatus, OrderStatus>> = {
  NEW: 'PREPARING',
  PREPARING: 'READY',
  READY: 'COMPLETED',
};
