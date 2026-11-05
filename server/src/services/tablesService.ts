import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { DB } from '../db/client';
import { billOrders, bills, diningTables, orders, restaurantSettings, taxRates } from '../db/schema';
import { computeBill } from '../lib/billing';
import { AppError, notFound } from '../lib/errors';
import type { CreateTableInput, UpdateTableInput } from '../validation';
import type { OrderDTO } from './orderService';

import type { EventBus } from '../events';

export interface TableDTO {
  id: number;
  name: string;
  capacity: number | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface TableTileDTO extends TableDTO {
  status: 'AVAILABLE' | 'OCCUPIED';
  tableStatus?: 'BLANK' | 'RUNNING_KOT' | 'PRINTED' | 'PAID';
  activeOrderCount: number;
  runningTotalPaise: number;
  firstOrderAt?: string | null;
  /** How far the table's order has got in the kitchen (the least advanced one if several); null when empty. */
  kitchenStatus: 'NEW' | 'PREPARING' | 'READY' | 'COMPLETED' | null;
  /** PAID once everything on the table is paid; stays until the table is cleared. */
  paymentState: 'PAID' | 'UNPAID' | null;
}

export interface TableDetailDTO {
  table: TableTileDTO;
  orders: OrderDTO[];
  runningTotalPaise: number;
}

export interface TablesServiceOptions {
  loadOrder: (id: number) => OrderDTO;
  events?: EventBus;
}

export function createTablesService(db: DB, opts?: TablesServiceOptions) {
  function readSettings() {
    const row = db.select().from(restaurantSettings).where(eq(restaurantSettings.id, 1)).get();
    const taxes = db
      .select({ name: taxRates.name, rateBps: taxRates.rateBps })
      .from(taxRates)
      .orderBy(asc(taxRates.sortOrder), asc(taxRates.id))
      .all();
    return {
      roundToRupee: row?.roundToRupee ?? false,
      taxes,
    };
  }

  const toTableDTO = (t: typeof diningTables.$inferSelect): TableDTO => ({
    id: t.id,
    name: t.name,
    capacity: t.capacity,
    isActive: t.isActive,
    sortOrder: t.sortOrder,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  });

  /** Returns active dine-in orders for a table that are not cancelled. */
  function findDineInOrders(table: typeof diningTables.$inferSelect): OrderDTO[] {
    const rows = db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.orderType, 'DINE_IN'),
          ne(orders.status, 'CANCELLED'),
          sql`(${orders.tableId} = ${table.id} OR (${orders.tableId} IS NULL AND lower(${orders.tableNumber}) = lower(${table.name})))`,
        ),
      )
      .orderBy(asc(orders.createdAt), asc(orders.id))
      .all();

    if (!opts?.loadOrder) return [];
    return rows.map((r) => opts.loadOrder(r.id)).filter((o) => o.status !== 'CANCELLED');
  }

  const STAGES = ['NEW', 'PREPARING', 'READY', 'COMPLETED'] as const;

  function computeTile(table: typeof diningTables.$inferSelect, settings = readSettings()): TableTileDTO {
    const ordersList = findDineInOrders(table);
    // An order is unsettled if it is not paid OR if it is still active in the kitchen (not served).
    // Paid and served orders keep the table occupied (showing Served + Paid) until staff press Clear.
    const clearedAt = table.clearedAt?.getTime() ?? 0;
    const unsettled = ordersList.filter((o) => o.paymentStatus !== 'PAID' || o.status !== 'COMPLETED' || Date.parse(o.createdAt) > clearedAt);
    const unpaid = ordersList.filter((o) => o.paymentStatus !== 'PAID');
    const isOccupied = unsettled.length > 0;

    let runningTotalPaise = 0;
    // Open bills that belong to what is on the table right now. A leftover bill from an order that was
    // cancelled or changed is ignored, so a new customer's table never looks "printed" by mistake.
    const unpaidIds = unpaid.map((o) => o.id);
    const linkedBillIds = new Set<number>();
    if (unpaidIds.length > 0) {
      for (const r of db.select({ id: billOrders.billId }).from(billOrders).where(inArray(billOrders.orderId, unpaidIds)).all()) linkedBillIds.add(r.id);
      for (const r of db.select({ id: bills.id }).from(bills).where(inArray(bills.orderId, unpaidIds)).all()) linkedBillIds.add(r.id);
    }
    const currentBills =
      linkedBillIds.size === 0
        ? []
        : db.select().from(bills).where(and(eq(bills.status, 'OPEN'), inArray(bills.id, [...linkedBillIds]))).orderBy(desc(bills.id)).all();
    const openBill = currentBills.find((b) => b.tableId === table.id) ?? currentBills[0];
    // "Printed" means someone actually printed it, not just that a bill was calculated.
    const printed = currentBills.some((b) => b.printedAt !== null);

    if (unpaid.length > 0) {
      if (openBill) {
        runningTotalPaise = openBill.totalPaise;
      } else {
        const subtotalPaise = unpaid.reduce((sum, o) => sum + o.subtotalPaise, 0);
        runningTotalPaise = computeBill({
          subtotalPaise,
          discount: { type: 'NONE' },
          taxes: settings.taxes,
          roundToRupee: settings.roundToRupee,
        }).totalPaise;
      }
    } else if (unsettled.length > 0) {
      // Table is paid, but kitchen orders are still active (status = 'PAID')
      const lastBill = db
        .select({ totalPaise: bills.totalPaise })
        .from(bills)
        .where(eq(bills.tableId, table.id))
        .orderBy(desc(bills.id))
        .limit(1)
        .get();
      if (lastBill) runningTotalPaise = lastBill.totalPaise;
    }

    const firstOrderAt = unpaid.length > 0 ? unpaid[0].createdAt : unsettled.length > 0 ? unsettled[0].createdAt : null;
    const tableStatus: 'BLANK' | 'RUNNING_KOT' | 'PRINTED' | 'PAID' = !isOccupied
      ? 'BLANK'
      : unpaid.length === 0
        ? 'PAID'
        : printed
          ? 'PRINTED'
          : 'RUNNING_KOT';

    return {
      ...toTableDTO(table),
      status: isOccupied ? 'OCCUPIED' : 'AVAILABLE',
      tableStatus,
      kitchenStatus: unsettled.length === 0 ? null : (STAGES.find((st) => unsettled.some((o) => o.status === st)) ?? null),
      paymentState: unsettled.length === 0 ? null : unpaid.length > 0 ? 'UNPAID' : 'PAID',
      activeOrderCount: unpaid.length > 0 ? unpaid.length : unsettled.length,
      runningTotalPaise,
      firstOrderAt,
    };
  }

  return {
    /** Returns list of active table names for backward compatibility. */
    list(): string[] {
      return db
        .select({ name: diningTables.name })
        .from(diningTables)
        .where(eq(diningTables.isActive, true))
        .orderBy(asc(diningTables.sortOrder), asc(diningTables.id))
        .all()
        .map((t) => t.name);
    },

    /** Returns all configured tables with active status, capacity, and display order. */
    listTables(includeInactive = false): TableDTO[] {
      const rows = db
        .select()
        .from(diningTables)
        .where(includeInactive ? undefined : eq(diningTables.isActive, true))
        .orderBy(asc(diningTables.sortOrder), asc(diningTables.id))
        .all();
      return rows.map(toTableDTO);
    },

    /** Visual tiles for Tables screen with server-derived status, order counts, and running amounts due. */
    listTiles(includeInactive = false): TableTileDTO[] {
      const settings = readSettings();
      const rows = db
        .select()
        .from(diningTables)
        .where(includeInactive ? undefined : eq(diningTables.isActive, true))
        .orderBy(asc(diningTables.sortOrder), asc(diningTables.id))
        .all();
      return rows.map((t) => computeTile(t, settings));
    },

    getById(id: number): TableDTO {
      const table = db.select().from(diningTables).where(eq(diningTables.id, id)).get();
      if (!table) throw notFound(`Table ${id} not found`);
      return toTableDTO(table);
    },

    /** Details for Reception drawer/modal: active unpaid orders, running totals, and table info. */
    getTableDetails(id: number): TableDetailDTO {
      const table = db.select().from(diningTables).where(eq(diningTables.id, id)).get();
      if (!table) throw notFound(`Table ${id} not found`);
      const tile = computeTile(table);
      const allOrders = findDineInOrders(table);
      const activeUnpaidOrders = allOrders.filter((o) => o.paymentStatus !== 'PAID');
      return {
        table: tile,
        orders: activeUnpaidOrders,
        runningTotalPaise: tile.runningTotalPaise,
      };
    },

    create(input: CreateTableInput): TableDTO {
      const name = input.name.trim();
      const existing = db
        .select({ id: diningTables.id })
        .from(diningTables)
        .where(and(sql`lower(${diningTables.name}) = lower(${name})`, eq(diningTables.isActive, true)))
        .get();
      if (existing) {
        throw new AppError(400, 'DUPLICATE_TABLE_NAME', `An active table named "${name}" already exists`);
      }

      const max = db
        .select({ maxOrder: sql<number>`COALESCE(MAX(${diningTables.sortOrder}), -1)` })
        .from(diningTables)
        .get();
      const sortOrder = (max?.maxOrder ?? -1) + 1;
      const now = new Date();

      const inserted = db
        .insert(diningTables)
        .values({
          name,
          capacity: input.capacity ?? null,
          isActive: true,
          sortOrder,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();

      return toTableDTO(inserted);
    },

    update(id: number, input: UpdateTableInput): TableDTO {
      const table = db.select().from(diningTables).where(eq(diningTables.id, id)).get();
      if (!table) throw notFound(`Table ${id} not found`);

      if (input.name !== undefined) {
        const name = input.name.trim();
        const dup = db
          .select({ id: diningTables.id })
          .from(diningTables)
          .where(
            and(
              ne(diningTables.id, id),
              sql`lower(${diningTables.name}) = lower(${name})`,
              eq(diningTables.isActive, true),
            ),
          )
          .get();
        if (dup) {
          throw new AppError(400, 'DUPLICATE_TABLE_NAME', `An active table named "${name}" already exists`);
        }
      }

      // Check unsettled orders before deactivation
      if (input.isActive === false && table.isActive && !input.force) {
        const ordersList = findDineInOrders(table);
        const hasUnsettled = ordersList.some((o) => o.paymentStatus !== 'PAID');
        if (hasUnsettled) {
          throw new AppError(
            409,
            'TABLE_HAS_UNSETTLED_ORDERS',
            `Cannot deactivate "${table.name}" because it has active unsettled orders. Please settle or cancel them first.`,
          );
        }
      }

      const now = new Date();
      const updated = db
        .update(diningTables)
        .set({
          name: input.name !== undefined ? input.name.trim() : table.name,
          capacity: input.capacity !== undefined ? input.capacity : table.capacity,
          isActive: input.isActive !== undefined ? input.isActive : table.isActive,
          sortOrder: input.sortOrder !== undefined ? input.sortOrder : table.sortOrder,
          updatedAt: now,
        })
        .where(eq(diningTables.id, id))
        .returning()
        .get();

      // Unpaid orders still open on this table show the new name too (paid and finished ones keep the name they had).
      if (input.name !== undefined && updated.name !== table.name) {
        const open = db
          .select({ id: orders.id })
          .from(orders)
          .where(and(eq(orders.tableId, id), sql`${orders.status} IN ('NEW', 'PREPARING', 'READY')`))
          .all();
        for (const o of open) {
          // Paid orders are history: they keep the name they were sold under.
          if (opts?.loadOrder && ['PAID', 'REFUNDED'].includes(opts.loadOrder(o.id).paymentStatus)) continue;
          db.update(orders).set({ tableNumber: updated.name, updatedAt: now }).where(eq(orders.id, o.id)).run();
          if (opts?.events && opts?.loadOrder) opts.events.emit('order.updated', opts.loadOrder(o.id));
        }
      }

      return toTableDTO(updated);
    },

    /** Bulk save for backward compatibility; preserves historical orders and avoids deleting in-use tables. */
    save(names: string[]): string[] {
      db.transaction((tx) => {
        const existing = tx.select().from(diningTables).all();
        const existingByName = new Map(existing.map((t) => [t.name.toLowerCase(), t]));

        names.forEach((name, i) => {
          const match = existingByName.get(name.toLowerCase());
          if (match) {
            tx.update(diningTables)
              .set({ name, sortOrder: i, isActive: true, updatedAt: new Date() })
              .where(eq(diningTables.id, match.id))
              .run();
          } else {
            tx.insert(diningTables)
              .values({ name, sortOrder: i, isActive: true })
              .run();
          }
        });

        // Any tables not in the new list: deactivate if they have historical orders; delete only if unused.
        const newNames = new Set(names.map((n) => n.toLowerCase()));
        for (const t of existing) {
          if (!newNames.has(t.name.toLowerCase())) {
            const hasOrders = tx
              .select({ id: orders.id })
              .from(orders)
              .where(eq(orders.tableId, t.id))
              .limit(1)
              .get();
            if (hasOrders) {
              tx.update(diningTables)
                .set({ isActive: false, updatedAt: new Date() })
                .where(eq(diningTables.id, t.id))
                .run();
            } else {
              tx.delete(diningTables).where(eq(diningTables.id, t.id)).run();
            }
          }
        }
      });

      return this.list();
    },

    /** Vacates / clears a table once all orders are settled, marking remaining orders COMPLETED. */
    clearTable(id: number): TableTileDTO {
      const table = db.select().from(diningTables).where(eq(diningTables.id, id)).get();
      if (!table) throw notFound(`Table ${id} not found`);

      const ordersList = findDineInOrders(table);
      const cooking = ordersList.filter((o) => o.status === 'NEW' || o.status === 'PREPARING');
      if (cooking.length > 0) {
        throw new AppError(
          409,
          'KITCHEN_BUSY',
          `Cannot clear "${table.name}" yet: the kitchen is still working on ${cooking.map((o) => '#' + o.orderNumber).join(', ')}.`,
        );
      }
      const unpaid = ordersList.filter((o) => o.paymentStatus !== 'PAID');
      if (unpaid.length > 0) {
        throw new AppError(400, 'UNPAID_ORDERS', `Cannot clear "${table.name}" because it still has unpaid orders. Please settle the bill first.`);
      }

      // Mark all remaining uncompleted orders for this table as COMPLETED
      const active = ordersList.filter((o) => o.status !== 'COMPLETED' && o.status !== 'CANCELLED');
      const nowTime = new Date();
      for (const o of active) {
        db.update(orders)
          .set({ status: 'COMPLETED', updatedAt: nowTime })
          .where(eq(orders.id, o.id))
          .run();
        if (opts?.events && opts?.loadOrder) {
          opts.events.emit('order.updated', opts.loadOrder(o.id));
        }
      }

      const cleared = db.update(diningTables).set({ clearedAt: nowTime }).where(eq(diningTables.id, id)).returning().get();
      return computeTile(cleared);
    },
  };
}

export type TablesService = ReturnType<typeof createTablesService>;
