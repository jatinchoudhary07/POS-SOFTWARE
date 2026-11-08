import { and, desc, eq, inArray, like, ne, sql } from 'drizzle-orm';
import type { DB } from '../db/client';
import {
  billOrders,
  bills,
  diningTables,
  menuCategories,
  menuItems,
  mergedRequests,
  orderItems,
  orders,
  payments,
  type OrderStatus,
  type PaymentMethod,
  type OrderType,
} from '../db/schema';
import type { EventBus } from '../events';
import { AppError, notFound } from '../lib/errors';
import { lineTotalPaise, MAX_QUANTITY_PER_LINE, subtotalPaise } from '../lib/money';
import { formatOrderNumber, orderNumberPrefix, parseSequence } from '../lib/orderNumber';
import { derivePaymentStatus, paidMethod, type OrderPaymentStatus } from '../lib/paymentStatus';
import type { CreateOrderInput, ReplaceOrderItemsInput } from '../validation';

export interface OrderItemDTO {
  id: number;
  menuItemId: number | null;
  itemName: string;
  unitPricePaise: number;
  quantity: number;
  lineTotalPaise: number;
  /** false for lines added to a running order that the kitchen has not taken yet */
  sentToKitchen: boolean;
}

export interface OrderDTO {
  id: number;
  orderNumber: string;
  orderType: OrderType;
  tableId: number | null;
  tableNumber: string | null;
  notes: string | null;
  customerName: string | null;
  customerPhone: string | null;
  /** Set when the order was cancelled. */
  cancelReason: string | null;
  /** Kitchen workflow status. */
  status: OrderStatus;
  /** Payment state, derived from payment attempts — independent of `status`. */
  paymentStatus: OrderPaymentStatus;
  paymentMethod: PaymentMethod | null;
  /** Final amount of the bill, once one has been generated (subtotal + tax − discount). */
  billTotalPaise: number | null;
  subtotalPaise: number;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  items: OrderItemDTO[];
}

type OrderWithItems = typeof orders.$inferSelect & {
  items: (typeof orderItems.$inferSelect)[];
  bill: typeof bills.$inferSelect | null;
  payments: (typeof payments.$inferSelect)[];
};

/** Relations loaded with every order. Exported so other services return the same shape. */
export const ORDER_WITH = {
  items: { orderBy: [orderItems.id] },
  bill: true as const,
  payments: true as const,
};

function toOrderDTO(o: OrderWithItems, db?: DB): OrderDTO {
  let bill = o.bill;
  let orderPayments = o.payments;
  if (!bill && db) {
    const bo = db.select().from(billOrders).innerJoin(bills, eq(billOrders.billId, bills.id)).where(eq(billOrders.orderId, o.id)).get();
    if (bo) {
      bill = bo.bills;
      if (orderPayments.length === 0) {
        orderPayments = db.select().from(payments).where(eq(payments.billId, bill.id)).all();
      }
    }
  }

  return {
    id: o.id,
    orderNumber: o.orderNumber,
    orderType: o.orderType,
    tableId: o.tableId,
    tableNumber: o.tableNumber,
    notes: o.notes,
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    cancelReason: o.cancelReason,
    status: o.status,
    paymentStatus: derivePaymentStatus(orderPayments),
    paymentMethod: paidMethod(orderPayments),
    billTotalPaise: bill?.totalPaise ?? null,
    subtotalPaise: o.subtotalPaise,
    itemCount: o.items.reduce((n, i) => n + i.quantity, 0),
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
    items: o.items.map((i) => ({
      id: i.id,
      menuItemId: i.menuItemId,
      itemName: i.itemName,
      unitPricePaise: i.unitPricePaise,
      quantity: i.quantity,
      lineTotalPaise: i.lineTotalPaise,
      sentToKitchen: i.kitchenDone,
    })),
  };
}

/**
 * Allowed kitchen workflow moves. COMPLETED is shown to staff as "Served".
 * CANCELLED is reached only through cancel(), never through a status change.
 */
export const STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  NEW: ['PREPARING'],
  PREPARING: ['READY'],
  READY: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

const STATUS_LABELS: Record<OrderStatus, string> = {
  NEW: 'Sent to kitchen',
  PREPARING: 'Preparing',
  READY: 'Ready',
  COMPLETED: 'Served',
  CANCELLED: 'Cancelled',
};

/**
 * What the kitchen screen needs — and nothing else: no prices, totals or payment state.
 * Sent to KITCHEN logins over REST and Socket.IO.
 */
export interface KitchenOrderDTO {
  id: number;
  orderNumber: string;
  orderType: OrderType;
  tableNumber: string | null;
  notes: string | null;
  status: OrderStatus;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  items: { id: number; itemName: string; quantity: number; /** already taken by the kitchen (shown dimmed when new items were added) */ sent: boolean }[];
}

export function toKitchenOrder(o: OrderDTO): KitchenOrderDTO {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    orderType: o.orderType,
    tableNumber: o.tableNumber,
    notes: o.notes,
    status: o.status,
    itemCount: o.itemCount,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    items: o.items.map((i) => ({ id: i.id, itemName: i.itemName, quantity: i.quantity, sent: i.sentToKitchen })),
  };
}

export interface UpdateStatusResult {
  order: OrderDTO;
  /** false when the order was already in the requested status (repeated request). */
  changed: boolean;
}

export interface CreateOrderResult {
  order: OrderDTO;
  /** true when this clientRequestId was already used and the existing order is returned. */
  duplicate: boolean;
  /** true when the items were added to the table's existing unpaid order instead of making a new one. */
  merged: boolean;
}

export function createOrderService(db: DB, events: EventBus, now: () => Date = () => new Date()) {
  function findById(id: number): OrderDTO | undefined {
    const row = db.query.orders
      .findFirst({ where: eq(orders.id, id), with: ORDER_WITH })
      .sync();
    return row ? toOrderDTO(row, db) : undefined;
  }

  function findByClientRequestId(clientRequestId: string): { order: OrderDTO; merged: boolean } | undefined {
    const row = db.select({ id: orders.id }).from(orders).where(eq(orders.clientRequestId, clientRequestId)).get();
    if (row) return { order: findById(row.id)!, merged: false };
    const m = db.select({ orderId: mergedRequests.orderId }).from(mergedRequests).where(eq(mergedRequests.clientRequestId, clientRequestId)).get();
    return m ? { order: findById(m.orderId)!, merged: true } : undefined;
  }

  /** Deletes the unpaid bill(s) built from an order's old items, so checkout makes a fresh one. */
  function dropOpenBills(tx: Pick<DB, 'select' | 'delete'>, orderId: number) {
    const linked = new Set<number>();
    for (const b of tx.select({ id: bills.id }).from(bills).where(eq(bills.orderId, orderId)).all()) linked.add(b.id);
    for (const b of tx.select({ id: billOrders.billId }).from(billOrders).where(eq(billOrders.orderId, orderId)).all()) linked.add(b.id);
    const billIds = [...linked];
    if (billIds.length === 0) return;
    tx.delete(billOrders).where(inArray(billOrders.billId, billIds)).run();
    tx.delete(bills).where(inArray(bills.id, billIds)).run();
  }

  /** The unpaid order currently open on a table (the running session), if any. */
  function findMergeTarget(tx: Pick<DB, 'select'>, tableId: number): OrderDTO | undefined {
    const rows = tx
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.tableId, tableId), ne(orders.status, 'CANCELLED')))
      .orderBy(desc(orders.id))
      .all();
    for (const r of rows) {
      const o = findById(r.id);
      if (o && o.paymentStatus === 'UNPAID') return o;
    }
    return undefined;
  }

  /** Merge repeated lines for the same item (e.g. [{id:1,q:2},{id:1,q:1}] -> q:3) and cap quantities. */
  function mergeQuantities(items: { menuItemId: number; quantity: number }[]) {
    const quantities = new Map<number, number>();
    for (const line of items) {
      quantities.set(line.menuItemId, (quantities.get(line.menuItemId) ?? 0) + line.quantity);
    }
    for (const [menuItemId, quantity] of quantities) {
      if (quantity > MAX_QUANTITY_PER_LINE) {
        throw new AppError(400, 'VALIDATION_ERROR', `Quantity for item ${menuItemId} must be at most ${MAX_QUANTITY_PER_LINE}`);
      }
    }
    return quantities;
  }

  /** Looks the items up and prices them from the menu; refuses unknown or unavailable items. */
  function resolveLines(tx: Pick<DB, 'select'>, quantities: Map<number, number>) {
    const ids = [...quantities.keys()];
    const found = tx
      .select({
        id: menuItems.id,
        name: menuItems.name,
        pricePaise: menuItems.pricePaise,
        isAvailable: menuItems.isAvailable,
        categoryActive: menuCategories.isActive,
      })
      .from(menuItems)
      .innerJoin(menuCategories, eq(menuItems.categoryId, menuCategories.id))
      .where(inArray(menuItems.id, ids))
      .all();
    const byId = new Map(found.map((f) => [f.id, f]));

    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new AppError(400, 'ITEM_NOT_FOUND', 'Some items are no longer on the menu', { menuItemIds: missing });
    }
    const unavailable = found.filter((f) => !f.isAvailable || !f.categoryActive);
    if (unavailable.length > 0) {
      throw new AppError(409, 'ITEM_UNAVAILABLE', `Not available right now: ${unavailable.map((u) => u.name).join(', ')}`, {
        menuItemIds: unavailable.map((u) => u.id),
      });
    }

    return ids.map((id) => {
      const item = byId.get(id)!;
      const quantity = quantities.get(id)!;
      return { menuItemId: id, itemName: item.name, unitPricePaise: item.pricePaise, quantity, lineTotalPaise: lineTotalPaise(item.pricePaise, quantity) };
    });
  }

  return {
    getById(id: number): OrderDTO {
      const order = findById(id);
      if (!order) throw notFound(`Order ${id} not found`);
      return order;
    },

    list(filter: { statuses?: OrderStatus[]; limit: number }): OrderDTO[] {
      const rows = db.query.orders
        .findMany({
          where: filter.statuses?.length ? inArray(orders.status, filter.statuses) : undefined,
          orderBy: [desc(orders.createdAt), desc(orders.id)],
          limit: filter.limit,
          with: ORDER_WITH,
        })
        .sync();
      return rows.map((r) => toOrderDTO(r, db));
    },

    /**
     * Moves an order to the next workflow status. The check and the write happen in one
     * synchronous transaction, and the UPDATE only matches if the status is still the one we
     * checked, so two screens pressing at once can never skip or repeat a step.
     * Only a real change emits 'order.updated' (and only after the transaction committed).
     */
    updateStatus(id: number, to: OrderStatus): UpdateStatusResult {
      const changed = db.transaction((tx) => {
        const row = tx
          .select({ status: orders.status, orderNumber: orders.orderNumber })
          .from(orders)
          .where(eq(orders.id, id))
          .get();
        if (!row) throw notFound(`Order ${id} not found`);
        if (row.status === to) return false; // repeated request: nothing to do

        if (row.status === 'CANCELLED') {
          const what = to === 'READY' ? 'marked ready' : to === 'PREPARING' ? 'started' : 'served';
          throw new AppError(409, 'ORDER_CANCELLED', `Order #${row.orderNumber} was cancelled, so it can't be ${what}.`, { currentStatus: row.status, requestedStatus: to });
        }
        if (!STATUS_TRANSITIONS[row.status].includes(to)) {
          throw new AppError(
            409,
            'INVALID_TRANSITION',
            `Order #${row.orderNumber} is ${STATUS_LABELS[row.status]} and cannot be changed to ${STATUS_LABELS[to]}`,
            { currentStatus: row.status, requestedStatus: to },
          );
        }
        const result = tx
          .update(orders)
          .set({ status: to, updatedAt: now() })
          .where(and(eq(orders.id, id), eq(orders.status, row.status)))
          .run();
        if (result.changes !== 1) {
          throw new AppError(409, 'CONFLICT', 'The order was changed by someone else. Please try again.');
        }
        // Everything on the order at this point is now with the kitchen.
        tx.update(orderItems).set({ kitchenDone: true }).where(eq(orderItems.orderId, id)).run();
        return true;
      });

      const order = findById(id)!;
      if (changed) {
        events.emit('order.updated', order);
        if (to === 'READY') events.emit('order.alert', { kind: 'READY', order });
      }
      return { order, changed };
    },

    /**
     * Cancels an order that has not been paid and that the kitchen has not started. Once cooking
     * has begun the food is made, so it can no longer be cancelled. Paid orders are never
     * cancelled here - they are refunded instead.
     */
    cancel(id: number, reason: string): OrderDTO {
      const changed = db.transaction((tx) => {
        const order = findById(id);
        if (!order) throw notFound(`Order ${id} not found`);
        if (order.status === 'CANCELLED') return false;
        if (order.status !== 'NEW') {
          throw new AppError(409, 'ORDER_STARTED', `Order #${order.orderNumber} is already ${order.status === 'COMPLETED' ? 'served' : 'being prepared'}, so it can no longer be cancelled.`);
        }
        if (order.paymentStatus !== 'UNPAID' && order.paymentStatus !== 'FAILED') {
          throw new AppError(409, 'ORDER_HAS_PAYMENT', 'This order has a payment on it. Refund it from checkout instead of cancelling.');
        }
        tx.update(orders).set({ status: 'CANCELLED', cancelReason: reason, updatedAt: now() }).where(eq(orders.id, id)).run();
        // A bill made for this order must not linger (it would make the table look "printed" for the next customer).
        const billIds = [
          ...tx.select({ id: bills.id }).from(bills).where(eq(bills.orderId, id)).all().map((b) => b.id),
          ...tx.select({ id: billOrders.billId }).from(billOrders).where(eq(billOrders.orderId, id)).all().map((b) => b.id),
        ];
        const hasPayments = billIds.length > 0 && !!tx.select({ id: payments.id }).from(payments).where(inArray(payments.billId, billIds)).get();
        if (!hasPayments) dropOpenBills(tx, id);
        return true;
      });
      const order = findById(id)!;
      if (changed) {
        events.emit('order.updated', order);
        events.emit('order.alert', { kind: 'CANCELLED', order });
      }
      return order;
    },

    /**
     * Replaces the items of an order that is still NEW and has no payment on it. Any unpaid bill
     * made from the old items is thrown away (checkout makes a fresh one), so a stale total can
     * never be charged.
     */
    replaceItems(id: number, input: ReplaceOrderItemsInput): OrderDTO {
      db.transaction((tx) => {
        const order = findById(id);
        if (!order) throw notFound(`Order ${id} not found`);
        if (order.status !== 'NEW') {
          throw new AppError(409, 'ORDER_LOCKED', 'The kitchen has started this order, so its items can no longer be changed. Cancel it or add a new order.');
        }
        if (order.items.some((i) => i.sentToKitchen)) {
          throw new AppError(409, 'ORDER_LOCKED', 'The kitchen has already taken part of this order, so its items can no longer be changed. Cancel it or add a new order.');
        }
        const hasPaymentRows = tx
          .select({ id: payments.id })
          .from(payments)
          .where(eq(payments.orderId, id))
          .get();
        const billPayment = tx
          .select({ id: payments.id })
          .from(payments)
          .innerJoin(billOrders, eq(billOrders.billId, payments.billId))
          .where(eq(billOrders.orderId, id))
          .get();
        if (order.paymentStatus !== 'UNPAID' || hasPaymentRows || billPayment) {
          throw new AppError(409, 'ORDER_HAS_PAYMENT', 'This order already has a payment attempt, so its items cannot be changed. Cancel it and enter a new order.');
        }
        dropOpenBills(tx, id);

        const lines = resolveLines(tx, mergeQuantities(input.items));
        const at = now();
        tx.delete(orderItems).where(eq(orderItems.orderId, id)).run();
        tx.insert(orderItems).values(lines.map((l) => ({ ...l, orderId: id, createdAt: at }))).run();
        tx.update(orders)
          .set({ subtotalPaise: subtotalPaise(lines), ...(input.notes !== undefined ? { notes: input.notes ?? null } : {}), updatedAt: at })
          .where(eq(orders.id, id))
          .run();
      });
      const order = findById(id)!;
      events.emit('order.updated', order);
      events.emit('order.alert', { kind: 'CHANGED', order });
      return order;
    },

    /**
     * Creates an order. Prices and names always come from the database, never from
     * the browser, so a tampered request cannot change what the customer pays.
     */
    create(input: CreateOrderInput): CreateOrderResult {
      const existing = findByClientRequestId(input.clientRequestId);
      if (existing) return { order: existing.order, duplicate: true, merged: existing.merged };

      const quantities = mergeQuantities(input.items);

      // better-sqlite3 transactions are synchronous, so nothing else can write between
      // reading the last order number and inserting the new one.
      const { orderId, merged } = db.transaction((tx) => {
        const lines = resolveLines(tx, quantities);

        const createdAt = now();
        const prefix = orderNumberPrefix(createdAt);
        const last = tx
          .select({ orderNumber: orders.orderNumber })
          .from(orders)
          .where(like(orders.orderNumber, `${prefix}-%`))
          .orderBy(desc(orders.orderNumber))
          .limit(1)
          .get();
        const sequence = (last ? parseSequence(last.orderNumber) : 0) + 1;

        let tableId: number | null = null;
        let tableNumber: string | null = null;
        if (input.orderType === 'DINE_IN') {
          if (input.tableId) {
            const table = tx.select().from(diningTables).where(eq(diningTables.id, input.tableId)).get();
            if (!table) {
              throw new AppError(400, 'INVALID_TABLE', `Table ${input.tableId} does not exist`);
            }
            if (!table.isActive) {
              throw new AppError(400, 'TABLE_INACTIVE', `Table "${table.name}" is inactive`);
            }
            tableId = table.id;
            tableNumber = table.name;
          } else if (input.tableNumber) {
            const table = tx
              .select()
              .from(diningTables)
              .where(and(sql`lower(${diningTables.name}) = lower(${input.tableNumber})`, eq(diningTables.isActive, true)))
              .get();
            if (table) {
              tableId = table.id;
              tableNumber = table.name;
            } else {
              tableNumber = input.tableNumber;
            }
          }
        }

        if (input.orderType === 'DINE_IN' && !tableNumber) {
          throw new AppError(400, 'TABLE_REQUIRED', 'Choose a table for a dine-in order');
        }

        // A table that already has an unpaid order gets these items added to it (one order per table
        // until it is cleared). If the kitchen already took the order it goes back to NEW, with the
        // added lines marked so the kitchen only cooks what is new.
        const target = tableId !== null ? findMergeTarget(tx, tableId) : undefined;
        if (target) {
          dropOpenBills(tx, target.id);
          for (const line of lines) {
            const open = tx
              .select()
              .from(orderItems)
              .where(and(eq(orderItems.orderId, target.id), eq(orderItems.menuItemId, line.menuItemId), eq(orderItems.kitchenDone, false)))
              .get();
            if (open) {
              const quantity = open.quantity + line.quantity;
              if (quantity > MAX_QUANTITY_PER_LINE) {
                throw new AppError(400, 'VALIDATION_ERROR', `Quantity for ${line.itemName} must be at most ${MAX_QUANTITY_PER_LINE}`);
              }
              tx.update(orderItems).set({ quantity, lineTotalPaise: lineTotalPaise(open.unitPricePaise, quantity) }).where(eq(orderItems.id, open.id)).run();
            } else {
              tx.insert(orderItems).values({ ...line, orderId: target.id, createdAt }).run();
            }
          }
          const all = tx.select({ total: orderItems.lineTotalPaise }).from(orderItems).where(eq(orderItems.orderId, target.id)).all();
          const note = [target.notes, input.notes].filter(Boolean).join(' | ').slice(0, 500) || null;
          tx.update(orders)
            .set({
              status: 'NEW',
              notes: note,
              ...(input.customerName ? { customerName: input.customerName } : {}),
              ...(input.customerPhone ? { customerPhone: input.customerPhone } : {}),
              subtotalPaise: all.reduce((n, r) => n + r.total, 0),
              updatedAt: createdAt,
            })
            .where(eq(orders.id, target.id))
            .run();
          tx.insert(mergedRequests).values({ clientRequestId: input.clientRequestId, orderId: target.id, createdAt }).run();
          return { orderId: target.id, merged: true };
        }

        const order = tx
          .insert(orders)
          .values({
            orderNumber: formatOrderNumber(createdAt, sequence),
            clientRequestId: input.clientRequestId,
            orderType: input.orderType,
            tableId,
            tableNumber,
            notes: input.notes ?? null,
            customerName: input.customerName ?? null,
            customerPhone: input.customerPhone ?? null,
            status: 'NEW',
            subtotalPaise: subtotalPaise(lines),
            createdAt,
            updatedAt: createdAt,
          })
          .returning({ id: orders.id })
          .get();

        tx.insert(orderItems)
          .values(lines.map((l) => ({ ...l, orderId: order.id, createdAt })))
          .run();
        return { orderId: order.id, merged: false };
      });

      const order = findById(orderId)!;
      events.emit(merged ? 'order.updated' : 'order.created', order);
      events.emit('order.alert', { kind: merged ? 'ITEMS_ADDED' : 'NEW_ORDER', order });
      return { order, duplicate: false, merged };
    },
  };
}

export type OrderService = ReturnType<typeof createOrderService>;

