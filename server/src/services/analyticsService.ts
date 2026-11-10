import { and, desc, eq, gte, inArray, lt, ne } from 'drizzle-orm';
import type { DB } from '../db/client';
import { billOrders, bills, menuCategories, menuItems, orderItems, orders, payments, type PaymentMethod } from '../db/schema';
import { AppError } from '../lib/errors';
import { creditTotals, type CreditTotals } from '../lib/credit';
import { derivePaymentStatus, paidMethod, type OrderPaymentStatus } from '../lib/paymentStatus';

/**
 * Owner-facing figures for a range of LOCAL days (inclusive). Same accounting rules as the daily
 * summary: a sale counts on the day its payment completed, a refund on the day it was recorded,
 * and failed / uncertain attempts are never revenue. Item figures use the price at the time of sale.
 */

export const MAX_RANGE_DAYS = 366;

interface Totals {
  grossPaise: number;
  refundPaise: number;
  netPaise: number;
  paidCount: number;
  orderCount: number;
  cancelledCount: number;
}

export interface Bucket {
  count: number;
  totalPaise: number;
}

export interface AnalyticsDTO {
  from: string;
  to: string;
  days: number;
  totals: Totals & { avgOrderPaise: number; discountPaise: number; taxPaise: number; itemsSold: number };
  previous: Totals & { avgOrderPaise: number };
  byDay: { date: string; netPaise: number; orders: number }[];
  byHour: Bucket[];
  byWeekday: Bucket[];
  /** Credit (pay later): given and collected in this period, and what is owed right now. */
  credit: CreditTotals;
  byMethod: Record<PaymentMethod, Bucket>;
  byType: { DINE_IN: Bucket; TAKEAWAY: Bucket };
  byTable: { table: string; count: number; totalPaise: number }[];
  topItems: { name: string; quantity: number; revenuePaise: number }[];
  slowItems: { name: string; quantity: number; revenuePaise: number }[];
  byCategory: { category: string; quantity: number; revenuePaise: number }[];
}

export interface HistoryRowDTO {
  id: number;
  orderNumber: string;
  createdAt: string;
  orderType: 'DINE_IN' | 'TAKEAWAY';
  tableNumber: string | null;
  status: string;
  paymentStatus: OrderPaymentStatus;
  paymentMethod: PaymentMethod | null;
  totalPaise: number;
  itemCount: number;
  itemsSummary: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfDay = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const chunks = <T>(list: T[], size = 500): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

function range(fromKey: string, toKey: string) {
  const start = startOfDay(fromKey);
  const last = startOfDay(toKey);
  const end = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1); // next local midnight
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  if (days < 1) throw new AppError(400, 'VALIDATION_ERROR', 'The end date is before the start date');
  if (days > MAX_RANGE_DAYS) throw new AppError(400, 'VALIDATION_ERROR', `Choose at most ${MAX_RANGE_DAYS} days`);
  return { start, end, days };
}

export function createAnalyticsService(db: DB) {
  const salesIn = (start: Date, end: Date) =>
    db
      .select({ p: payments, o: orders })
      .from(payments)
      .innerJoin(orders, eq(payments.orderId, orders.id))
      .where(and(inArray(payments.status, ['SUCCEEDED', 'REFUNDED']), gte(payments.completedAt, start), lt(payments.completedAt, end)))
      .all();

  const refundsIn = (start: Date, end: Date) =>
    db.select().from(payments).where(and(eq(payments.status, 'REFUNDED'), gte(payments.refundedAt, start), lt(payments.refundedAt, end))).all();

  function totals(start: Date, end: Date): Totals & { avgOrderPaise: number } {
    const sales = salesIn(start, end);
    const refunds = refundsIn(start, end);
    const grossPaise = sales.reduce((s, r) => s + r.p.amountPaise, 0);
    const refundPaise = refunds.reduce((s, p) => s + p.amountPaise, 0);
    const created = db.select({ status: orders.status }).from(orders).where(and(gte(orders.createdAt, start), lt(orders.createdAt, end))).all();
    const cancelledCount = created.filter((o) => o.status === 'CANCELLED').length;
    return {
      grossPaise,
      refundPaise,
      netPaise: grossPaise - refundPaise,
      paidCount: sales.length,
      orderCount: created.length - cancelledCount,
      cancelledCount,
      avgOrderPaise: sales.length ? Math.round(grossPaise / sales.length) : 0,
    };
  }

  return {
    analytics(fromKey: string, toKey: string, tzOffsetMinutes?: number): AnalyticsDTO {
      // Hour and weekday of a sale in the viewer's timezone (the server's own clock is used when none is given).
      const local = (d: Date) => (tzOffsetMinutes === undefined ? { hour: d.getHours(), weekday: d.getDay() } : (() => {
        const s = new Date(d.getTime() - tzOffsetMinutes * 60_000);
        return { hour: s.getUTCHours(), weekday: s.getUTCDay() };
      })());
      const { start, end, days } = range(fromKey, toKey);
      const current = totals(start, end);
      const previous = totals(new Date(start.getFullYear(), start.getMonth(), start.getDate() - days), start);

      const sales = salesIn(start, end);
      const refunds = refundsIn(start, end);

      const dayMap = new Map<string, { netPaise: number; orders: number }>();
      for (let i = 0; i < days; i++) dayMap.set(dayKey(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)), { netPaise: 0, orders: 0 });
      const byHour: Bucket[] = Array.from({ length: 24 }, () => ({ count: 0, totalPaise: 0 }));
      const byWeekday: Bucket[] = Array.from({ length: 7 }, () => ({ count: 0, totalPaise: 0 }));
      const byMethod: AnalyticsDTO['byMethod'] = {
        CASH: { count: 0, totalPaise: 0 },
        UPI_MANUAL: { count: 0, totalPaise: 0 },
        TERMINAL: { count: 0, totalPaise: 0 },
        CREDIT: { count: 0, totalPaise: 0 },
      };
      const byType: AnalyticsDTO['byType'] = { DINE_IN: { count: 0, totalPaise: 0 }, TAKEAWAY: { count: 0, totalPaise: 0 } };
      const tableMap = new Map<string, { count: number; totalPaise: number }>();

      for (const { p, o } of sales) {
        const at = p.completedAt!;
        const day = dayMap.get(dayKey(at));
        if (day) {
          day.netPaise += p.amountPaise;
          day.orders++;
        }
        const when = local(at);
        byHour[when.hour].count++;
        byHour[when.hour].totalPaise += p.amountPaise;
        byWeekday[when.weekday].count++;
        byWeekday[when.weekday].totalPaise += p.amountPaise;
        byMethod[p.method].count++;
        byMethod[p.method].totalPaise += p.amountPaise;
        byType[o.orderType].count++;
        byType[o.orderType].totalPaise += p.amountPaise;
        if (o.orderType === 'DINE_IN' && o.tableNumber) {
          const t = tableMap.get(o.tableNumber) ?? { count: 0, totalPaise: 0 };
          t.count++;
          t.totalPaise += p.amountPaise;
          tableMap.set(o.tableNumber, t);
        }
      }
      for (const r of refunds) {
        const day = dayMap.get(dayKey(r.refundedAt!));
        if (day) day.netPaise -= r.amountPaise;
      }

      // Items and discounts/tax come from orders that are paid (not refunded) in this range.
      const paidIds = sales.filter((s) => s.p.status === 'SUCCEEDED').map((s) => s.o.id);
      const itemMap = new Map<string, { quantity: number; revenuePaise: number }>();
      const catMap = new Map<string, { quantity: number; revenuePaise: number }>();
      const categoryOf = new Map<number, string>(
        db
          .select({ id: menuItems.id, category: menuCategories.name })
          .from(menuItems)
          .innerJoin(menuCategories, eq(menuItems.categoryId, menuCategories.id))
          .all()
          .map((r) => [r.id, r.category]),
      );
      let itemsSold = 0;
      let discountPaise = 0;
      let taxPaise = 0;
      for (const ids of chunks(paidIds)) {
        for (const it of db.select().from(orderItems).where(inArray(orderItems.orderId, ids)).all()) {
          itemsSold += it.quantity;
          const i = itemMap.get(it.itemName) ?? { quantity: 0, revenuePaise: 0 };
          i.quantity += it.quantity;
          i.revenuePaise += it.lineTotalPaise;
          itemMap.set(it.itemName, i);
          const cat = (it.menuItemId !== null && categoryOf.get(it.menuItemId)) || 'Other';
          const c = catMap.get(cat) ?? { quantity: 0, revenuePaise: 0 };
          c.quantity += it.quantity;
          c.revenuePaise += it.lineTotalPaise;
          catMap.set(cat, c);
        }
        for (const b of db.select().from(bills).where(inArray(bills.orderId, ids)).all()) {
          discountPaise += b.discountPaise;
          taxPaise += b.taxPaise;
        }
      }
      const items = [...itemMap].map(([name, v]) => ({ name, ...v }));

      return {
        from: fromKey,
        to: toKey,
        days,
        totals: { ...current, discountPaise, taxPaise, itemsSold },
        previous,
        byDay: [...dayMap].map(([date, v]) => ({ date, ...v })),
        byHour,
        byWeekday,
        byMethod,
        credit: creditTotals(db, start, end),
        byType,
        byTable: [...tableMap].map(([table, v]) => ({ table, ...v })).sort((a, b) => b.totalPaise - a.totalPaise).slice(0, 8),
        topItems: [...items].sort((a, b) => b.quantity - a.quantity || b.revenuePaise - a.revenuePaise).slice(0, 10),
        slowItems: [...items].sort((a, b) => a.quantity - b.quantity || a.revenuePaise - b.revenuePaise).slice(0, 5),
        byCategory: [...catMap].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.revenuePaise - a.revenuePaise),
      };
    },

    /** Every order created in the range (newest first), with search and filters, paged. */
    history(opts: {
      from: string;
      to: string;
      q?: string;
      payment?: OrderPaymentStatus | 'CANCELLED';
      type?: 'DINE_IN' | 'TAKEAWAY';
      limit: number;
      offset: number;
    }): { total: number; rows: HistoryRowDTO[] } {
      const { start, end } = range(opts.from, opts.to);
      const found = db.query.orders
        .findMany({
          where: and(gte(orders.createdAt, start), lt(orders.createdAt, end), opts.type ? eq(orders.orderType, opts.type) : undefined),
          orderBy: [desc(orders.createdAt), desc(orders.id)],
          with: { bill: true, payments: true, items: true },
        })
        .sync();

      // An order settled through a table bill has its payment recorded on the bill (under the first order of
      // that bill), so look payments up through the bill too, exactly like the order screens do.
      const ids = found.map((o) => o.id);
      const viaBill = new Map<number, (typeof payments.$inferSelect)[]>();
      if (ids.length > 0) {
        const linked = db
          .select({ orderId: billOrders.orderId, p: payments })
          .from(billOrders)
          .innerJoin(payments, eq(payments.billId, billOrders.billId))
          .where(inArray(billOrders.orderId, ids))
          .all();
        for (const l of linked) viaBill.set(l.orderId, [...(viaBill.get(l.orderId) ?? []), l.p]);
      }
      const paymentsOf = (o: (typeof found)[number]) => (o.payments.length > 0 ? o.payments : (viaBill.get(o.id) ?? []));

      const q = opts.q?.trim().toLowerCase();
      const rows = found
        .map<HistoryRowDTO>((o) => ({
          id: o.id,
          orderNumber: o.orderNumber,
          createdAt: o.createdAt.toISOString(),
          orderType: o.orderType,
          tableNumber: o.tableNumber,
          status: o.status,
          paymentStatus: derivePaymentStatus(paymentsOf(o)),
          paymentMethod: paidMethod(paymentsOf(o)),
          totalPaise: o.bill?.totalPaise ?? o.subtotalPaise,
          itemCount: o.items.reduce((s, i) => s + i.quantity, 0),
          itemsSummary: o.items.map((i) => `${i.quantity}× ${i.itemName}`).join(', '),
        }))
        .filter((r) => {
          if (opts.payment === 'CANCELLED') return r.status === 'CANCELLED';
          if (opts.payment && (r.paymentStatus !== opts.payment || r.status === 'CANCELLED')) return false;
          if (q && !`${r.orderNumber} ${r.tableNumber ?? ''} ${r.itemsSummary}`.toLowerCase().includes(q)) return false;
          return true;
        });
      return { total: rows.length, rows: rows.slice(opts.offset, opts.offset + opts.limit) };
    },
  };
}

export type AnalyticsService = ReturnType<typeof createAnalyticsService>;
