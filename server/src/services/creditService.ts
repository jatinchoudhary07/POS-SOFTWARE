import { and, asc, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import type { DB } from '../db/client';
import { billOrders, bills, creditReceipts, creditSales, customers, diningTables, orderItems, orders } from '../db/schema';
import { AppError, notFound } from '../lib/errors';
import type { CollectCreditInput } from '../validation';

export interface CreditReceiptDTO {
  id: number;
  amountPaise: number;
  method: 'CASH' | 'UPI_MANUAL';
  providerReference: string | null;
  note: string | null;
  createdAt: string;
}

/** One bill that was put on credit, and how much of it is still owed. */
export interface CreditSaleDTO {
  id: number;
  createdAt: string;
  /** The order(s) on the bill, e.g. ["261105-012"]. */
  orderNumbers: string[];
  tableName: string | null;
  itemsSummary: string;
  amountPaise: number;
  paidPaise: number;
  remainingPaise: number;
  receipts: CreditReceiptDTO[];
}

export interface CreditCustomerDTO {
  id: number;
  name: string;
  phone: string;
  /** Still owed across all bills. */
  outstandingPaise: number;
  /** Total ever put on credit, and total collected so far. */
  givenPaise: number;
  collectedPaise: number;
  /** Bills that still have something left to pay. */
  openBills: number;
  /** Latest credit given or money collected. */
  lastActivityAt: string;
}

export interface CreditCustomerDetailDTO {
  customer: CreditCustomerDTO;
  sales: CreditSaleDTO[];
}

export function createCreditService(db: DB, now: () => Date = () => new Date()) {
  /** Per-customer figures for every customer (or one). */
  function customerRows(filter?: { id?: number; q?: string }): CreditCustomerDTO[] {
    const q = filter?.q?.trim();
    const cust = db
      .select()
      .from(customers)
      .where(
        filter?.id !== undefined
          ? eq(customers.id, filter.id)
          : q
            ? or(like(sql`lower(${customers.name})`, `%${q.toLowerCase()}%`), like(customers.phone, `%${q}%`))
            : undefined,
      )
      .all();
    if (cust.length === 0) return [];
    const ids = cust.map((c) => c.id);
    const sales = db.select().from(creditSales).where(inArray(creditSales.customerId, ids)).all();
    const receipts = sales.length
      ? db.select().from(creditReceipts).where(inArray(creditReceipts.creditSaleId, sales.map((s) => s.id))).all()
      : [];
    return cust.map((c) => {
      const mine = sales.filter((s) => s.customerId === c.id);
      const paidBySale = new Map<number, number>();
      let collected = 0;
      let last = c.createdAt.getTime();
      for (const r of receipts) {
        if (!mine.some((s) => s.id === r.creditSaleId)) continue;
        paidBySale.set(r.creditSaleId, (paidBySale.get(r.creditSaleId) ?? 0) + r.amountPaise);
        collected += r.amountPaise;
        last = Math.max(last, r.createdAt.getTime());
      }
      let given = 0;
      let open = 0;
      for (const s of mine) {
        given += s.amountPaise;
        last = Math.max(last, s.createdAt.getTime());
        if (s.amountPaise - (paidBySale.get(s.id) ?? 0) > 0) open++;
      }
      return {
        id: c.id,
        name: c.name,
        phone: c.phone,
        outstandingPaise: given - collected,
        givenPaise: given,
        collectedPaise: collected,
        openBills: open,
        lastActivityAt: new Date(last).toISOString(),
      };
    });
  }

  function salesOf(customerId: number): CreditSaleDTO[] {
    const sales = db.select().from(creditSales).where(eq(creditSales.customerId, customerId)).orderBy(desc(creditSales.id)).all();
    if (sales.length === 0) return [];
    const receipts = db.select().from(creditReceipts).where(inArray(creditReceipts.creditSaleId, sales.map((s) => s.id))).orderBy(asc(creditReceipts.id)).all();
    return sales.map((s) => {
      const bill = db.select().from(bills).where(eq(bills.id, s.billId)).get();
      const linked = db.select({ orderId: billOrders.orderId }).from(billOrders).where(eq(billOrders.billId, s.billId)).all().map((r) => r.orderId);
      const orderIds = linked.length > 0 ? linked : bill ? [bill.orderId] : [];
      const orderRows = orderIds.length ? db.select().from(orders).where(inArray(orders.id, orderIds)).orderBy(asc(orders.id)).all() : [];
      const items = orderIds.length ? db.select().from(orderItems).where(inArray(orderItems.orderId, orderIds)).orderBy(asc(orderItems.id)).all() : [];
      const table = bill?.tableId ? db.select({ name: diningTables.name }).from(diningTables).where(eq(diningTables.id, bill.tableId)).get() : undefined;
      const mine = receipts.filter((r) => r.creditSaleId === s.id);
      const paid = mine.reduce((n, r) => n + r.amountPaise, 0);
      return {
        id: s.id,
        createdAt: s.createdAt.toISOString(),
        orderNumbers: orderRows.map((o) => o.orderNumber),
        tableName: table?.name ?? orderRows[0]?.tableNumber ?? null,
        itemsSummary: items.map((i) => `${i.quantity}× ${i.itemName}`).join(', '),
        amountPaise: s.amountPaise,
        paidPaise: paid,
        remainingPaise: s.amountPaise - paid,
        receipts: mine.map((r) => ({
          id: r.id,
          amountPaise: r.amountPaise,
          method: r.method,
          providerReference: r.providerReference,
          note: r.note,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    });
  }

  return {
    /** Customers with credit on record, most owed first. By default only those who still owe something. */
    list(opts: { q?: string; includeSettled?: boolean } = {}): CreditCustomerDTO[] {
      return customerRows({ q: opts.q })
        .filter((c) => (opts.includeSettled ? c.givenPaise > 0 : c.outstandingPaise > 0))
        .sort((a, b) => b.outstandingPaise - a.outstandingPaise || b.lastActivityAt.localeCompare(a.lastActivityAt));
    },

    /** Looks a customer up by exact phone number (used to fill in the name and show what they already owe). */
    lookupByPhone(phone: string): CreditCustomerDTO | null {
      const c = db.select({ id: customers.id }).from(customers).where(eq(customers.phone, phone)).get();
      return c ? (customerRows({ id: c.id })[0] ?? null) : null;
    },

    get(customerId: number): CreditCustomerDetailDTO {
      const customer = customerRows({ id: customerId })[0];
      if (!customer) throw notFound(`Customer ${customerId} not found`);
      return { customer, sales: salesOf(customerId) };
    },

    /**
     * Records money received from a customer against what they owe. With `creditSaleId` it goes to that
     * bill only; otherwise it pays the oldest bills first. Repeating the same request id does nothing.
     */
    collect(customerId: number, input: CollectCreditInput): CreditCustomerDetailDTO & { duplicate: boolean } {
      const duplicate = db.transaction((tx) => {
        const seen = tx.select({ id: creditReceipts.id }).from(creditReceipts).where(like(creditReceipts.idempotencyKey, `${input.idempotencyKey}#%`)).get();
        if (seen) return true;

        const customer = tx.select().from(customers).where(eq(customers.id, customerId)).get();
        if (!customer) throw notFound(`Customer ${customerId} not found`);
        const sales = tx
          .select()
          .from(creditSales)
          .where(input.creditSaleId !== undefined ? and(eq(creditSales.customerId, customerId), eq(creditSales.id, input.creditSaleId)) : eq(creditSales.customerId, customerId))
          .orderBy(asc(creditSales.id))
          .all();
        if (input.creditSaleId !== undefined && sales.length === 0) throw notFound('That credit bill was not found for this customer');

        const paid = new Map(
          tx
            .select({ id: creditReceipts.creditSaleId, total: sql<number>`SUM(${creditReceipts.amountPaise})` })
            .from(creditReceipts)
            .where(inArray(creditReceipts.creditSaleId, sales.map((s) => s.id)))
            .groupBy(creditReceipts.creditSaleId)
            .all()
            .map((r) => [r.id, r.total]),
        );
        const open = sales.map((s) => ({ sale: s, remaining: s.amountPaise - (paid.get(s.id) ?? 0) })).filter((x) => x.remaining > 0);
        const owed = open.reduce((n, x) => n + x.remaining, 0);
        if (owed === 0) throw new AppError(409, 'NOTHING_OWED', 'Nothing is owed here.');
        if (input.amountPaise > owed) {
          throw new AppError(400, 'OVERPAYMENT', `That is more than the ₹${(owed / 100).toFixed(2)} still owed.`, { owedPaise: owed });
        }

        let left = input.amountPaise;
        const at = now();
        for (const { sale, remaining } of open) {
          if (left <= 0) break;
          const part = Math.min(left, remaining);
          tx.insert(creditReceipts)
            .values({
              creditSaleId: sale.id,
              amountPaise: part,
              method: input.method,
              providerReference: input.method === 'UPI_MANUAL' ? (input.providerReference ?? null) : null,
              note: input.note ?? null,
              idempotencyKey: `${input.idempotencyKey}#${sale.id}`,
              createdAt: at,
            })
            .run();
          left -= part;
        }
        return false;
      });
      return { ...this.get(customerId), duplicate };
    },
  };
}

export type CreditService = ReturnType<typeof createCreditService>;
