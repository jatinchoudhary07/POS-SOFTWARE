import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { DB } from '../db/client';
import { creditReceipts, creditSales, customers } from '../db/schema';

type Writer = Pick<DB, 'select' | 'insert' | 'update'>;

/**
 * A bill put on credit ("pay later"): finds or creates the customer (matched by phone number),
 * and records how much they owe for this bill. The payment row itself is written by the caller.
 */
export function recordCreditSale(
  tx: Writer,
  input: { paymentId: number; billId: number; amountPaise: number; name: string; phone: string; at: Date },
): number {
  const name = input.name.trim();
  const existing = tx.select().from(customers).where(eq(customers.phone, input.phone)).get();
  let customerId: number;
  if (existing) {
    customerId = existing.id;
    if (existing.name !== name) tx.update(customers).set({ name, updatedAt: input.at }).where(eq(customers.id, existing.id)).run();
  } else {
    customerId = tx.insert(customers).values({ name, phone: input.phone, createdAt: input.at, updatedAt: input.at }).returning({ id: customers.id }).get().id;
  }
  tx.insert(creditSales)
    .values({ paymentId: input.paymentId, customerId, billId: input.billId, amountPaise: input.amountPaise, createdAt: input.at })
    .run();
  return customerId;
}

export interface CreditTotals {
  /** Bills put on credit during the period (by when it was given). */
  givenPaise: number;
  givenCount: number;
  /** Money collected from customers during the period, by how it was paid. */
  collectedCashPaise: number;
  collectedUpiPaise: number;
  collectedPaise: number;
  /** Everything customers still owe, as of now (not limited to the period). */
  outstandingPaise: number;
  owingCustomers: number;
}

/** Credit figures for sales reports: given and collected in [from, to), plus what is owed right now. */
export function creditTotals(db: DB, from: Date, to: Date): CreditTotals {
  const given = db
    .select({ total: sql<number>`COALESCE(SUM(${creditSales.amountPaise}), 0)`, n: sql<number>`COUNT(*)` })
    .from(creditSales)
    .where(and(gte(creditSales.createdAt, from), lt(creditSales.createdAt, to)))
    .get()!;
  const collected = db
    .select({ method: creditReceipts.method, total: sql<number>`COALESCE(SUM(${creditReceipts.amountPaise}), 0)` })
    .from(creditReceipts)
    .where(and(gte(creditReceipts.createdAt, from), lt(creditReceipts.createdAt, to)))
    .groupBy(creditReceipts.method)
    .all();
  const collectedCashPaise = collected.find((c) => c.method === 'CASH')?.total ?? 0;
  const collectedUpiPaise = collected.find((c) => c.method === 'UPI_MANUAL')?.total ?? 0;
  const owing = outstanding(db);
  return {
    givenPaise: given.total,
    givenCount: given.n,
    collectedCashPaise,
    collectedUpiPaise,
    collectedPaise: collectedCashPaise + collectedUpiPaise,
    outstandingPaise: owing.totalPaise,
    owingCustomers: owing.customers,
  };
}

/** What all customers owe right now. */
export function outstanding(db: DB): { totalPaise: number; customers: number } {
  const sales = db.select({ id: creditSales.id, customerId: creditSales.customerId, amount: creditSales.amountPaise }).from(creditSales).all();
  const paid = new Map(
    db
      .select({ id: creditReceipts.creditSaleId, total: sql<number>`SUM(${creditReceipts.amountPaise})` })
      .from(creditReceipts)
      .groupBy(creditReceipts.creditSaleId)
      .all()
      .map((r) => [r.id, r.total]),
  );
  const perCustomer = new Map<number, number>();
  for (const s of sales) perCustomer.set(s.customerId, (perCustomer.get(s.customerId) ?? 0) + s.amount - (paid.get(s.id) ?? 0));
  let totalPaise = 0;
  let count = 0;
  for (const v of perCustomer.values()) {
    if (v > 0) {
      totalPaise += v;
      count++;
    }
  }
  return { totalPaise, customers: count };
}
