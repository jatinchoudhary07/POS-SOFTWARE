import type { CreateOrderRequest, MenuCategory, MenuItem, OrderType } from '../api/types';
import { newRequestId } from '../lib/id';

/**
 * The current (unsent) order lives entirely in the browser until "Send to kitchen".
 * This file is plain functions with no React, so it is easy to unit-test.
 */

export const MAX_QTY = 99;
export const MAX_NOTES = 500;
export const MAX_TABLE = 10;
export const MAX_CUSTOMER_NAME = 60;
export const MAX_CUSTOMER_PHONE = 10;

export interface CartLine {
  menuItemId: number;
  name: string;
  unitPricePaise: number; // for display only — the server re-prices every order
  quantity: number;
  /** false if the item became unavailable / was removed since it was added */
  available: boolean;
}

export interface CartState {
  requestId: string;
  orderType: OrderType;
  tableId?: number | null;
  tableNumber: string;
  notes: string;
  /** Optional: who the order is for */
  customerName: string;
  customerPhone: string;
  lines: CartLine[];
}

export type CartAction =
  | { type: 'add'; item: MenuItem }
  | { type: 'increment'; menuItemId: number }
  | { type: 'decrement'; menuItemId: number }
  | { type: 'setQuantity'; menuItemId: number; quantity: number }
  | { type: 'remove'; menuItemId: number }
  | { type: 'setOrderType'; orderType: OrderType }
  | { type: 'setTable'; tableNumber: string; tableId?: number | null }
  | { type: 'setNotes'; notes: string }
  | { type: 'setCustomer'; name?: string; phone?: string }
  | { type: 'syncMenu'; categories: MenuCategory[] }
  | { type: 'markUnavailable'; menuItemIds: number[] }
  | { type: 'reset' };

export function createEmptyCart(orderType: OrderType = 'DINE_IN'): CartState {
  return { requestId: newRequestId(), orderType, tableId: null, tableNumber: '', notes: '', customerName: '', customerPhone: '', lines: [] };
}

const clampQty = (n: number) => (Number.isFinite(n) ? Math.min(MAX_QTY, Math.max(1, Math.trunc(n))) : 1);

const mapLine = (state: CartState, id: number, fn: (l: CartLine) => CartLine | null): CartState => ({
  ...state,
  lines: state.lines.flatMap((l) => {
    if (l.menuItemId !== id) return [l];
    const next = fn(l);
    return next ? [next] : [];
  }),
});

export function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case 'add': {
      const { item } = action;
      if (!item.isAvailable) return state;
      if (state.lines.some((l) => l.menuItemId === item.id)) {
        return mapLine(state, item.id, (l) => ({ ...l, quantity: clampQty(l.quantity + 1) }));
      }
      return {
        ...state,
        lines: [
          ...state.lines,
          { menuItemId: item.id, name: item.name, unitPricePaise: item.pricePaise, quantity: 1, available: true },
        ],
      };
    }
    case 'increment':
      return mapLine(state, action.menuItemId, (l) => ({ ...l, quantity: clampQty(l.quantity + 1) }));
    case 'decrement':
      // Going below 1 removes the line.
      return mapLine(state, action.menuItemId, (l) => (l.quantity <= 1 ? null : { ...l, quantity: l.quantity - 1 }));
    case 'setQuantity':
      return mapLine(state, action.menuItemId, (l) => ({ ...l, quantity: clampQty(action.quantity) }));
    case 'remove':
      return mapLine(state, action.menuItemId, () => null);
    case 'setOrderType':
      return {
        ...state,
        orderType: action.orderType,
        tableNumber: action.orderType === 'DINE_IN' ? state.tableNumber : '',
        tableId: action.orderType === 'DINE_IN' ? state.tableId : null,
      };
    case 'setTable':
      return {
        ...state,
        tableNumber: action.tableNumber.slice(0, MAX_TABLE),
        tableId: action.tableId !== undefined ? action.tableId : state.tableId,
      };
    case 'setNotes':
      return { ...state, notes: action.notes.slice(0, MAX_NOTES) };
    case 'setCustomer':
      return {
        ...state,
        ...(action.name !== undefined ? { customerName: action.name.slice(0, MAX_CUSTOMER_NAME) } : {}),
        // digits only, at most 10
        ...(action.phone !== undefined ? { customerPhone: action.phone.replace(/\D/g, '').slice(0, MAX_CUSTOMER_PHONE) } : {}),
      };
    case 'syncMenu': {
      // Keep cart lines in step with the latest menu (availability, price, name).
      const items = new Map(action.categories.flatMap((c) => c.items).map((i) => [i.id, i]));
      return {
        ...state,
        lines: state.lines.map((l) => {
          const item = items.get(l.menuItemId);
          if (!item) return { ...l, available: false };
          return { ...l, name: item.name, unitPricePaise: item.pricePaise, available: item.isAvailable };
        }),
      };
    }
    case 'markUnavailable':
      return {
        ...state,
        lines: state.lines.map((l) => (action.menuItemIds.includes(l.menuItemId) ? { ...l, available: false } : l)),
      };
    case 'reset':
      return {
        ...createEmptyCart(state.orderType),
        tableNumber: state.orderType === 'DINE_IN' ? state.tableNumber : '',
        tableId: state.orderType === 'DINE_IN' ? state.tableId : null,
      };
  }
}

export const lineTotal = (l: CartLine) => l.unitPricePaise * l.quantity;
export const cartSubtotal = (s: CartState) => s.lines.reduce((sum, l) => sum + lineTotal(l), 0);
export const cartItemCount = (s: CartState) => s.lines.reduce((n, l) => n + l.quantity, 0);

/** A phone number is optional, but if one is typed it must be complete. Checked when the order is placed, not while typing. */
export const phoneProblem = (s: CartState): string | null =>
  s.customerPhone.length > 0 && s.customerPhone.length !== MAX_CUSTOMER_PHONE ? `Phone number must be ${MAX_CUSTOMER_PHONE} digits` : null;

/** Reason the order cannot be sent yet, or null if it is ready. */
export function cartProblem(s: CartState): string | null {
  if (s.lines.length === 0) return 'Add at least one item';
  if (s.lines.some((l) => !l.available)) return 'Remove unavailable items first';
  if (s.lines.some((l) => !Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > MAX_QTY)) {
    return `Quantities must be between 1 and ${MAX_QTY}`;
  }
  return null;
}

export function toCreateOrderRequest(s: CartState): CreateOrderRequest {
  const table = s.tableNumber.trim();
  const notes = s.notes.trim();
  const customerName = s.customerName.trim();
  const customerPhone = s.customerPhone.trim();
  return {
    clientRequestId: s.requestId,
    orderType: s.orderType,
    ...(s.orderType === 'DINE_IN' && s.tableId ? { tableId: s.tableId } : {}),
    ...(s.orderType === 'DINE_IN' && table ? { tableNumber: table } : {}),
    ...(notes ? { notes } : {}),
    ...(customerName ? { customerName } : {}),
    ...(customerPhone ? { customerPhone } : {}),
    items: s.lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity })),
  };
}
