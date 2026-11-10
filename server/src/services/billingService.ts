import { and, asc, desc, eq, gte, inArray, lt, ne, or, sql } from 'drizzle-orm';
import type { DB } from '../db/client';
import {
  billOrders,
  bills,
  diningTables,
  orderItems,
  orders,
  payments,
  restaurantSettings,
  taxRates,
  type BillStatus,
  type DiscountType,
  type PaymentMethod,
  type PaymentStatus,
  type TaxLine,
} from '../db/schema';
import type { EventBus } from '../events';
import { computeBill, type DiscountInput } from '../lib/billing';
import { AppError, notFound } from '../lib/errors';
import { creditTotals, recordCreditSale, type CreditTotals } from '../lib/credit';
import { derivePaymentStatus, type OrderPaymentStatus } from '../lib/paymentStatus';
import type { PaymentProvider, ProviderOutcome } from '../payments/provider';
import type { GenerateBillInput, RecordPaymentInput, UpdateSettingsInput } from '../validation';
import type { OrderDTO } from './orderService';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export const DEFAULT_DAILY_GOAL_PAISE = 500_000;

export interface SettingsDTO {
  restaurantName: string;
  addressLine: string | null;
  phone: string | null;
  taxId: string | null;
  receiptFooter: string | null;
  roundToRupee: boolean;
  taxes: { name: string; rateBps: number }[];
  /** false until the settings have been saved once (defaults are in use). */
  configured: boolean;
}

export interface BillDTO {
  id: number;
  orderId: number;
  tableId: number | null;
  status: BillStatus;
  subtotalPaise: number;
  discount: { type: DiscountType; value: number; reason: string | null; paise: number };
  taxablePaise: number;
  taxLines: TaxLine[];
  taxPaise: number;
  roundOffPaise: number;
  totalPaise: number;
  updatedAt: string;
}

export interface PaymentDTO {
  id: number;
  /** Human-readable reference printed on receipts, e.g. "PAY-000042". */
  reference: string;
  orderId: number;
  billId: number;
  method: PaymentMethod;
  status: PaymentStatus;
  amountPaise: number;
  tenderedPaise: number | null;
  changePaise: number | null;
  provider: string;
  providerReference: string | null;
  failureReason: string | null;
  note: string | null;
  createdAt: string;
  completedAt: string | null;
  refundedAt: string | null;
  refundReason: string | null;
}

export interface CheckoutDTO {
  order: OrderDTO;
  bill: BillDTO | null;
  payments: PaymentDTO[];
}

export interface TableCheckoutDTO {
  table: { id: number; name: string; capacity: number | null };
  orders: OrderDTO[];
  bill: BillDTO | null;
  payments: PaymentDTO[];
  paymentStatus: OrderPaymentStatus;
}

export interface ReceiptDTO {
  restaurant: Omit<SettingsDTO, 'taxes' | 'roundToRupee' | 'configured'>;
  order: OrderDTO;
  bill: BillDTO;
  paymentStatus: OrderPaymentStatus;
  /** The successful (or refunded) payment, if any. */
  payment: PaymentDTO | null;
  generatedAt: string;
}

export interface TableReceiptDTO {
  restaurant: Omit<SettingsDTO, 'taxes' | 'roundToRupee' | 'configured'>;
  table: { id: number; name: string };
  orders: OrderDTO[];
  bill: BillDTO;
  paymentStatus: OrderPaymentStatus;
  payment: PaymentDTO | null;
  generatedAt: string;
}

export interface DailySummaryDTO {
  date: string;
  /** Local-time day boundaries of the reception computer: [from, to). */
  from: string;
  to: string;
  orderCount: number;
  /** Payments received this day (by completion time), including ones refunded later. */
  grossSalesPaise: number;
  paidCount: number;
  byMethod: Record<PaymentMethod, { count: number; totalPaise: number }>;
  /** Refunds recorded this day (by refund time), whatever day the sale was. */
  refundCount: number;
  refundTotalPaise: number;
  netSalesPaise: number;
  /** Orders created this day that are not paid yet (bill total, or estimate if no bill yet). */
  unpaidCount: number;
  unpaidTotalPaise: number;
  failedAttemptCount: number;
  uncertainAttemptCount: number;
  /** Credit (pay later): given and collected this day, and what is owed right now. */
  credit: CreditTotals;
  payments: (PaymentDTO & { orderNumber: string })[];
}

export type BillRow = typeof bills.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
export type BillingTx = Parameters<Parameters<DB['transaction']>[0]>[0];

/**
 * What the terminal payment code (payments/paytm) borrows from billing, so the bill and payment rules live in one place.
 * Nothing here changes how cash, UPI or credit payments work.
 */
export interface TerminalKit {
  /** Same checks as paying an order by hand (not paid, no open attempt, bill open, total unchanged). */
  assertPayableOrder(tx: BillingTx, orderId: number, expectedTotalPaise: number): BillRow;
  /** The same for the open bill of a table. Returns the bill and the orders it covers. */
  assertPayableTable(tx: BillingTx, tableId: number, expectedTotalPaise: number): { bill: BillRow; orderIds: number[] };
  insertPayment(tx: BillingTx, values: typeof payments.$inferInsert): PaymentRow;
  markBillPaid(tx: BillingTx, billId: number): void;
  touchOrder(tx: BillingTx, orderId: number): void;
  orderIdsOfBill(tx: BillingTx | DB, billId: number, fallbackOrderId: number): number[];
  publish(orderId: number): void;
  checkout(orderId: number): CheckoutDTO;
  checkoutTable(tableId: number): TableCheckoutDTO;
  toPaymentDTO(row: PaymentRow): PaymentDTO;
}

/** Called inside the transaction when a person settles an unsure payment by hand, so a terminal attempt can be closed too. */
export interface PaymentHooks {
  afterManualResolve?: (tx: BillingTx, payment: PaymentRow, outcome: 'SUCCEEDED' | 'FAILED') => void;
}

const toBillDTO = (b: BillRow): BillDTO => ({
  id: b.id,
  orderId: b.orderId,
  tableId: b.tableId ?? null,
  status: b.status,
  subtotalPaise: b.subtotalPaise,
  discount: { type: b.discountType, value: b.discountValue, reason: b.discountReason, paise: b.discountPaise },
  taxablePaise: b.taxablePaise,
  taxLines: b.taxLines,
  taxPaise: b.taxPaise,
  roundOffPaise: b.roundOffPaise,
  totalPaise: b.totalPaise,
  updatedAt: b.updatedAt.toISOString(),
});

export const paymentReference = (id: number) => `PAY-${String(id).padStart(6, '0')}`;

const toPaymentDTO = (p: PaymentRow): PaymentDTO => ({
  id: p.id,
  reference: paymentReference(p.id),
  orderId: p.orderId,
  billId: p.billId,
  method: p.method,
  status: p.status,
  amountPaise: p.amountPaise,
  tenderedPaise: p.tenderedPaise,
  changePaise: p.changePaise,
  provider: p.provider,
  providerReference: p.providerReference,
  failureReason: p.failureReason,
  note: p.note,
  createdAt: p.createdAt.toISOString(),
  completedAt: p.completedAt?.toISOString() ?? null,
  refundedAt: p.refundedAt?.toISOString() ?? null,
  refundReason: p.refundReason,
});

const isUniqueViolation = (e: unknown) =>
  typeof e === 'object' && e !== null && 'code' in e && String((e as { code: unknown }).code).startsWith('SQLITE_CONSTRAINT_UNIQUE');

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface BillingServiceOptions {
  /** Reads an order as the REST API returns it (used for events and responses). */
  loadOrder: (id: number) => OrderDTO;
  defaultRestaurantName: string;
  providers?: PaymentProvider[];
  hooks?: PaymentHooks;
  /** How long to wait for a provider (terminal) before treating the outcome as UNKNOWN. */
  providerTimeoutMs?: number;
  now?: () => Date;
}

export function createBillingService(db: DB, events: EventBus, opts: BillingServiceOptions) {
  const now = opts.now ?? (() => new Date());
  const providers = opts.providers ?? [];
  const providerTimeoutMs = opts.providerTimeoutMs ?? 120_000;
  type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

  // -- helpers ---------------------------------------------------------------

  function readSettings(tx: DB | Tx = db): SettingsDTO {
    const row = tx.select().from(restaurantSettings).where(eq(restaurantSettings.id, 1)).get();
    const taxes = tx
      .select({ name: taxRates.name, rateBps: taxRates.rateBps })
      .from(taxRates)
      .orderBy(asc(taxRates.sortOrder), asc(taxRates.id))
      .all();
    return {
      restaurantName: row?.restaurantName ?? opts.defaultRestaurantName,
      addressLine: row?.addressLine ?? null,
      phone: row?.phone ?? null,
      taxId: row?.taxId ?? null,
      receiptFooter: row?.receiptFooter ?? null,
      roundToRupee: row?.roundToRupee ?? false,
      taxes,
      configured: !!row,
    };
  }

  /**
   * Marks the order as changed so every screen's "newest wins" merge accepts the new version.
   * updated_at is forced to move forward even if two changes happen in the same millisecond.
   */
  function touchOrder(tx: Tx, orderId: number) {
    tx.run(sql`UPDATE orders SET updated_at = MAX(updated_at + 1, ${now().getTime()}) WHERE id = ${orderId}`);
  }

  // Bill/payment changes: staff screens update; the kitchen is not told (it needs no money data).
  function publish(orderId: number) {
    events.emit('order.updated', opts.loadOrder(orderId), { kitchen: false });
  }

  function getOrderRow(tx: DB | Tx, orderId: number) {
    const order = tx.select().from(orders).where(eq(orders.id, orderId)).get();
    if (!order) throw notFound(`Order ${orderId} not found`);
    return order;
  }

  function attemptsFor(tx: DB | Tx, orderId: number) {
    const direct = tx.select().from(payments).where(eq(payments.orderId, orderId)).orderBy(desc(payments.id)).all();
    if (direct.length > 0) return direct;
    const bo = tx
      .select({ billId: billOrders.billId })
      .from(billOrders)
      .where(eq(billOrders.orderId, orderId))
      .get();
    if (bo) {
      return tx.select().from(payments).where(eq(payments.billId, bo.billId)).orderBy(desc(payments.id)).all();
    }
    return [];
  }

  /** Common checks before any new payment attempt. Returns the bill to charge. */
  function assertPayable(tx: Tx, orderId: number, expectedTotalPaise: number): BillRow {
    const order = getOrderRow(tx, orderId);
    if (order.status === 'CANCELLED') throw new AppError(409, 'ORDER_CANCELLED', 'Cancelled orders cannot be paid');
    const attempts = attemptsFor(tx, orderId);
    const paid = attempts.find((p) => p.status === 'SUCCEEDED');
    if (paid) {
      throw new AppError(409, 'ALREADY_PAID', `Order #${order.orderNumber} is already paid (${paymentReference(paid.id)})`, {
        paymentId: paid.id,
      });
    }
    if (attempts.some((p) => p.status === 'REFUNDED')) {
      throw new AppError(409, 'ALREADY_REFUNDED', `Order #${order.orderNumber} was paid and refunded; it cannot be paid again`);
    }
    const open = attempts.find((p) => p.status === 'PENDING' || p.status === 'UNKNOWN');
    if (open) {
      throw new AppError(
        409,
        'PAYMENT_UNCERTAIN',
        `Payment ${paymentReference(open.id)} for this order has an uncertain outcome. Check it and resolve it before taking another payment.`,
        { paymentId: open.id },
      );
    }
    const bill = tx.select().from(bills).where(eq(bills.orderId, orderId)).get();
    if (!bill) throw new AppError(409, 'BILL_REQUIRED', 'Generate the bill before taking payment');
    if (bill.status !== 'OPEN') throw new AppError(409, 'BILL_CLOSED', 'This bill is already closed');
    if (bill.totalPaise <= 0) throw new AppError(409, 'ZERO_TOTAL', 'The bill total is ₹0; nothing to pay');
    if (bill.totalPaise !== expectedTotalPaise) {
      throw new AppError(409, 'BILL_CHANGED', 'The bill changed since it was shown. Check the new total and try again.', {
        totalPaise: bill.totalPaise,
      });
    }
    return bill;
  }

  /** Same idempotency key again: return the original attempt instead of creating another. */
  function findByKey(tx: DB | Tx, orderId: number, key: string): PaymentRow | undefined {
    const existing = tx.select().from(payments).where(eq(payments.idempotencyKey, key)).get();
    if (existing && existing.orderId !== orderId) {
      throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This payment request id was already used for a different order');
    }
    return existing;
  }

  function insertAttempt(tx: Tx, values: typeof payments.$inferInsert): PaymentRow {
    try {
      return tx.insert(payments).values(values).returning().get();
    } catch (e) {
      // The partial unique indexes are the last line of defence against double payment.
      if (isUniqueViolation(e)) throw new AppError(409, 'ALREADY_PAID', 'A payment for this order was already recorded');
      throw e;
    }
  }

  function markBillPaid(tx: Tx, billId: number) {
    const r = tx.update(bills).set({ status: 'PAID', updatedAt: now() }).where(and(eq(bills.id, billId), eq(bills.status, 'OPEN'))).run();
    if (r.changes !== 1) throw new AppError(409, 'BILL_CLOSED', 'This bill is already closed');
    const covered = tx.select({ orderId: billOrders.orderId }).from(billOrders).where(eq(billOrders.billId, billId)).all();
    for (const row of covered) touchOrder(tx, row.orderId);
  }

  function checkout(orderId: number): CheckoutDTO {
    const order = opts.loadOrder(orderId);
    let bill = db.select().from(bills).where(eq(bills.orderId, orderId)).get();
    if (!bill) {
      const bo = db.select().from(billOrders).innerJoin(bills, eq(billOrders.billId, bills.id)).where(eq(billOrders.orderId, orderId)).get();
      if (bo) bill = bo.bills;
    }
    let paymentList = attemptsFor(db, orderId);
    if (paymentList.length === 0 && bill) {
      paymentList = db.select().from(payments).where(eq(payments.billId, bill.id)).orderBy(desc(payments.id)).all();
    }
    return { order, bill: bill ? toBillDTO(bill) : null, payments: paymentList.map(toPaymentDTO) };
  }

  /** Bill for an order that has none yet, using today's settings (for the unpaid estimate). */
  function estimateTotal(subtotalPaise: number, settings: SettingsDTO) {
    return computeBill({ subtotalPaise, discount: { type: 'NONE' }, taxes: settings.taxes, roundToRupee: settings.roundToRupee }).totalPaise;
  }

  function checkoutTable(tableId: number): TableCheckoutDTO {
    const table = db.select().from(diningTables).where(eq(diningTables.id, tableId)).get();
    if (!table) throw notFound(`Table ${tableId} not found`);

    // Check for active unpaid dine-in orders on this table first
    const orderRows = db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.orderType, 'DINE_IN'),
          ne(orders.status, 'CANCELLED'),
          sql`(${orders.tableId} = ${tableId} OR (${orders.tableId} IS NULL AND lower(${orders.tableNumber}) = lower(${table.name})))`,
        ),
      )
      .orderBy(asc(orders.createdAt), asc(orders.id))
      .all();
    const activeUnpaidOrders = orderRows
      .map((r) => opts.loadOrder(r.id))
      .filter((o) => o.paymentStatus !== 'PAID' && o.status !== 'CANCELLED');

    // Look for an existing OPEN bill for this table
    const openBill = db
      .select()
      .from(bills)
      .where(and(eq(bills.tableId, tableId), eq(bills.status, 'OPEN')))
      .get();

    let coveredOrders: OrderDTO[] = [];
    let paymentList: PaymentDTO[] = [];
    let bill: typeof bills.$inferSelect | null = null;

    if (activeUnpaidOrders.length > 0) {
      // There are active unpaid orders for this table
      if (openBill) {
        bill = openBill;
        const coveredRows = db
          .select({ orderId: billOrders.orderId })
          .from(billOrders)
          .where(eq(billOrders.billId, openBill.id))
          .all();
        coveredOrders = coveredRows.map((r) => opts.loadOrder(r.orderId));
        paymentList = db
          .select()
          .from(payments)
          .where(eq(payments.billId, openBill.id))
          .orderBy(desc(payments.id))
          .all()
          .map(toPaymentDTO);
      } else {
        coveredOrders = activeUnpaidOrders;
        paymentList = [];
        bill = null;
      }
    } else {
      // No active unpaid orders: fallback to the most recent completed/refunded bill
      const lastBill = db
        .select()
        .from(bills)
        .where(eq(bills.tableId, tableId))
        .orderBy(desc(bills.id))
        .limit(1)
        .get();

      if (lastBill) {
        bill = lastBill;
        const coveredRows = db
          .select({ orderId: billOrders.orderId })
          .from(billOrders)
          .where(eq(billOrders.billId, lastBill.id))
          .all();
        coveredOrders = coveredRows.map((r) => opts.loadOrder(r.orderId));
        paymentList = db
          .select()
          .from(payments)
          .where(eq(payments.billId, lastBill.id))
          .orderBy(desc(payments.id))
          .all()
          .map(toPaymentDTO);
      }
    }

    const paymentStatus: OrderPaymentStatus = bill
      ? bill.status === 'PAID'
        ? 'PAID'
        : bill.status === 'REFUNDED'
          ? 'REFUNDED'
          : derivePaymentStatus(paymentList)
      : 'UNPAID';

    return {
      table: { id: table.id, name: table.name, capacity: table.capacity },
      orders: coveredOrders,
      bill: bill ? toBillDTO(bill) : null,
      payments: paymentList,
      paymentStatus,
    };
  }

  function generateTableBill(
    tableId: number,
    input: GenerateBillInput,
    { canChangeDiscount = true } = {},
  ): TableCheckoutDTO {
    const changed = db.transaction((tx) => {
      const table = tx.select().from(diningTables).where(eq(diningTables.id, tableId)).get();
      if (!table) throw notFound(`Table ${tableId} not found`);

      const orderRows = tx
        .select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status, subtotalPaise: orders.subtotalPaise })
        .from(orders)
        .where(
          and(
            eq(orders.orderType, 'DINE_IN'),
            ne(orders.status, 'CANCELLED'),
            sql`(${orders.tableId} = ${tableId} OR (${orders.tableId} IS NULL AND lower(${orders.tableNumber}) = lower(${table.name})))`,
          ),
        )
        .orderBy(asc(orders.createdAt), asc(orders.id))
        .all();

      if (orderRows.length === 0) {
        throw new AppError(400, 'NO_ORDERS_TO_BILL', `No orders found for table "${table.name}"`);
      }

      // Exclude already-paid orders; check for uncertain payment attempts
      const unpaidOrders: typeof orderRows = [];
      for (const o of orderRows) {
        const attempts = attemptsFor(tx, o.id);
        if (attempts.some((p) => p.status === 'SUCCEEDED' || p.status === 'REFUNDED')) {
          continue;
        }
        if (attempts.some((p) => p.status === 'PENDING' || p.status === 'UNKNOWN')) {
          throw new AppError(
            409,
            'PAYMENT_UNCERTAIN',
            `Payment for order #${o.orderNumber} is in progress or uncertain; resolve it first`,
          );
        }
        unpaidOrders.push(o);
      }

      if (unpaidOrders.length === 0) {
        throw new AppError(400, 'NO_ORDERS_TO_BILL', `All orders for table "${table.name}" are already paid`);
      }

      // Existing open bill for this table
      const existing = tx
        .select()
        .from(bills)
        .where(and(eq(bills.tableId, tableId), eq(bills.status, 'OPEN')))
        .get();

      // Concurrency protection: prevent any order from being in another bill
      for (const o of unpaidOrders) {
        const assoc = tx
          .select({ billId: billOrders.billId, status: bills.status })
          .from(billOrders)
          .innerJoin(bills, eq(billOrders.billId, bills.id))
          .where(eq(billOrders.orderId, o.id))
          .get();

        if (assoc) {
          if (existing && assoc.billId === existing.id) {
            // Belonged to this table's previous open bill, acceptable to re-bill
          } else if (assoc.status === 'PAID') {
            throw new AppError(409, 'ALREADY_PAID', `Order #${o.orderNumber} is already paid`);
          } else {
            throw new AppError(409, 'ALREADY_BILLED', `Order #${o.orderNumber} is already on another bill`);
          }
        }
      }

      // Defensive: line total validation
      for (const o of unpaidOrders) {
        const { lines } = tx
          .select({ lines: sql<number>`COALESCE(SUM(${orderItems.lineTotalPaise}), 0)` })
          .from(orderItems)
          .where(eq(orderItems.orderId, o.id))
          .get()!;
        if (lines !== o.subtotalPaise) throw new Error(`Order ${o.id} subtotal does not match its lines`);
      }

      const subtotalPaise = unpaidOrders.reduce((sum, o) => sum + o.subtotalPaise, 0);

      const d = input.discount;
      if (!canChangeDiscount) {
        const same =
          (d.type === 'NONE' && (!existing || existing.discountType === 'NONE')) ||
          (existing &&
            d.type === existing.discountType &&
            (d.type === 'PERCENT' ? d.bps : d.type === 'AMOUNT' ? d.paise : 0) === existing.discountValue &&
            (d.type === 'NONE' ? null : d.reason) === existing.discountReason);
        if (!same) throw new AppError(403, 'FORBIDDEN', 'Only the Superadmin can add, change or remove discounts');
      }

      const discount: DiscountInput =
        d.type === 'PERCENT' ? { type: 'PERCENT', bps: d.bps } : d.type === 'AMOUNT' ? { type: 'AMOUNT', paise: d.paise } : { type: 'NONE' };
      if (d.type === 'AMOUNT' && d.paise >= subtotalPaise) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Discount must be less than the subtotal');
      }
      if (d.type === 'PERCENT' && d.bps >= 10_000) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Discount must be less than 100%');
      }

      const settings = readSettings(tx);
      const b = computeBill({ subtotalPaise, discount, taxes: settings.taxes, roundToRupee: settings.roundToRupee });

      const values = {
        status: 'OPEN' as const,
        subtotalPaise: b.subtotalPaise,
        discountType: d.type,
        discountValue: d.type === 'PERCENT' ? d.bps : d.type === 'AMOUNT' ? d.paise : 0,
        discountReason: d.type === 'NONE' ? null : d.reason,
        discountPaise: b.discountPaise,
        taxablePaise: b.taxablePaise,
        taxPaise: b.taxPaise,
        taxLines: b.taxLines,
        roundOffPaise: b.roundOffPaise,
        totalPaise: b.totalPaise,
        tableId,
      };

      let billId: number;
      if (existing) {
        billId = existing.id;
        const unchanged = existing.totalPaise === values.totalPaise && existing.discountPaise === values.discountPaise && existing.subtotalPaise === values.subtotalPaise;
        tx.update(bills).set({ ...values, ...(unchanged ? {} : { printedAt: null }), updatedAt: now() }).where(eq(bills.id, existing.id)).run();
        tx.delete(billOrders).where(eq(billOrders.billId, existing.id)).run();
      } else {
        const inserted = tx
          .insert(bills)
          .values({ ...values, orderId: unpaidOrders[0].id, createdAt: now(), updatedAt: now() })
          .returning({ id: bills.id })
          .get();
        billId = inserted.id;
      }

      for (const o of unpaidOrders) {
        tx.insert(billOrders).values({ billId, orderId: o.id, createdAt: now() }).run();
        touchOrder(tx, o.id);
      }

      return unpaidOrders.map((o) => o.id);
    });

    for (const id of changed) publish(id);
    return checkoutTable(tableId);
  }

  // -- public API ------------------------------------------------------------

  return {
    getSettings: () => readSettings(),

    /** Replaces the receipt details and tax lines. Existing PAID bills are never touched. */
    updateSettings(input: UpdateSettingsInput): SettingsDTO {
      db.transaction((tx) => {
        const values = {
          restaurantName: input.restaurantName,
          addressLine: input.addressLine,
          phone: input.phone,
          taxId: input.taxId,
          receiptFooter: input.receiptFooter,
          roundToRupee: input.roundToRupee,
          updatedAt: now(),
        };
        tx.insert(restaurantSettings)
          .values({ id: 1, ...values, createdAt: now() })
          .onConflictDoUpdate({ target: restaurantSettings.id, set: values })
          .run();
        tx.delete(taxRates).run();
        if (input.taxes.length > 0) {
          tx.insert(taxRates)
            .values(input.taxes.map((t, i) => ({ name: t.name, rateBps: t.rateBps, sortOrder: i })))
            .run();
        }
      });
      return readSettings();
    },

    /** The daily sales goal in paise (₹5,000 until the Superadmin changes it). */
    getDailyGoal(): number {
      return db.select({ g: restaurantSettings.dailyGoalPaise }).from(restaurantSettings).where(eq(restaurantSettings.id, 1)).get()?.g ?? DEFAULT_DAILY_GOAL_PAISE;
    },

    setDailyGoal(paise: number): number {
      db.transaction((tx) => {
        const exists = tx.select({ id: restaurantSettings.id }).from(restaurantSettings).where(eq(restaurantSettings.id, 1)).get();
        if (exists) {
          tx.update(restaurantSettings).set({ dailyGoalPaise: paise, updatedAt: now() }).where(eq(restaurantSettings.id, 1)).run();
        } else {
          // settings were never saved: create the row with the default restaurant name so nothing else changes
          tx.insert(restaurantSettings)
            .values({ id: 1, restaurantName: opts.defaultRestaurantName, dailyGoalPaise: paise, createdAt: now(), updatedAt: now() })
            .run();
        }
      });
      return paise;
    },

    checkout,

    /**
     * Creates (or recalculates) the OPEN bill from the persisted order and current tax settings.
     * Nothing the client sends affects the amounts except an explicit, bounded discount.
     */
    /** `canChangeDiscount: false` (Reception) may (re)generate the bill but not add/alter a discount. */
    generateBill(orderId: number, input: GenerateBillInput, { canChangeDiscount = true } = {}): CheckoutDTO {
      const changed = db.transaction((tx) => {
        const order = getOrderRow(tx, orderId);
        if (order.status === 'CANCELLED') throw new AppError(409, 'ORDER_CANCELLED', 'Cancelled orders cannot be billed');
        const attempts = attemptsFor(tx, orderId);
        if (attempts.some((p) => p.status === 'SUCCEEDED' || p.status === 'REFUNDED')) {
          throw new AppError(409, 'ALREADY_PAID', `Order #${order.orderNumber} is already paid; its bill can no longer change`);
        }
        if (attempts.some((p) => p.status === 'PENDING' || p.status === 'UNKNOWN')) {
          throw new AppError(409, 'PAYMENT_UNCERTAIN', 'A payment for this order is in progress or uncertain; resolve it first');
        }

        // Defensive: the stored subtotal must equal the sum of the stored lines.
        const { lines } = tx
          .select({ lines: sql<number>`COALESCE(SUM(${orderItems.lineTotalPaise}), 0)` })
          .from(orderItems)
          .where(eq(orderItems.orderId, orderId))
          .get()!;
        if (lines !== order.subtotalPaise) throw new Error(`Order ${orderId} subtotal does not match its lines`);

        const d = input.discount;
        const existing = tx.select().from(bills).where(eq(bills.orderId, orderId)).get();
        if (!canChangeDiscount) {
          const same =
            (d.type === 'NONE' && (!existing || existing.discountType === 'NONE')) ||
            (existing &&
              d.type === existing.discountType &&
              (d.type === 'PERCENT' ? d.bps : d.type === 'AMOUNT' ? d.paise : 0) === existing.discountValue &&
              (d.type === 'NONE' ? null : d.reason) === existing.discountReason);
          if (!same) throw new AppError(403, 'FORBIDDEN', 'Only the Superadmin can add, change or remove discounts');
        }
        const discount: DiscountInput =
          d.type === 'PERCENT' ? { type: 'PERCENT', bps: d.bps } : d.type === 'AMOUNT' ? { type: 'AMOUNT', paise: d.paise } : { type: 'NONE' };
        if (d.type === 'AMOUNT' && d.paise >= order.subtotalPaise) {
          throw new AppError(400, 'VALIDATION_ERROR', 'Discount must be less than the subtotal');
        }
        if (d.type === 'PERCENT' && d.bps >= 10_000) {
          throw new AppError(400, 'VALIDATION_ERROR', 'Discount must be less than 100%');
        }
        const settings = readSettings(tx);
        const b = computeBill({ subtotalPaise: order.subtotalPaise, discount, taxes: settings.taxes, roundToRupee: settings.roundToRupee });
        const values = {
          status: 'OPEN' as const,
          subtotalPaise: b.subtotalPaise,
          discountType: d.type,
          discountValue: d.type === 'PERCENT' ? d.bps : d.type === 'AMOUNT' ? d.paise : 0,
          discountReason: d.type === 'NONE' ? null : d.reason,
          discountPaise: b.discountPaise,
          taxablePaise: b.taxablePaise,
          taxPaise: b.taxPaise,
          taxLines: b.taxLines,
          roundOffPaise: b.roundOffPaise,
          totalPaise: b.totalPaise,
        };

        let billId: number;
        if (existing) {
          billId = existing.id;
          const same = (Object.keys(values) as (keyof typeof values)[]).every(
            (k) => JSON.stringify(existing[k]) === JSON.stringify(values[k]),
          );
          if (same) return false; // regenerating an identical bill is a no-op (no event)
          tx.update(bills).set({ ...values, printedAt: null, updatedAt: now() }).where(eq(bills.id, existing.id)).run();
        } else {
          const inserted = tx
            .insert(bills)
            .values({ ...values, orderId, tableId: order.tableId ?? null, createdAt: now(), updatedAt: now() })
            .returning({ id: bills.id })
            .get();
          billId = inserted.id;
        }
        tx.insert(billOrders).values({ billId, orderId, createdAt: now() }).onConflictDoNothing().run();
        touchOrder(tx, orderId);
        return true;
      });
      if (changed) publish(orderId);
      return checkout(orderId);
    },

    /**
     * Records a payment confirmed by the cashier (cash counted, or UPI verified by hand).
     * One transaction: insert the attempt + close the bill. The event is sent after commit.
     */
    recordManualPayment(
      orderId: number,
      input: Exclude<RecordPaymentInput, { method: 'TERMINAL' }>,
    ): { checkout: CheckoutDTO; payment: PaymentDTO; duplicate: boolean } {
      const existing = findByKey(db, orderId, input.idempotencyKey);
      if (existing) return { checkout: checkout(orderId), payment: toPaymentDTO(existing), duplicate: true };

      const payment = db.transaction((tx) => {
        const bill = assertPayable(tx, orderId, input.expectedTotalPaise);
        const at = now();
        const base = {
          orderId,
          billId: bill.id,
          amountPaise: bill.totalPaise,
          idempotencyKey: input.idempotencyKey,
          provider: 'MANUAL',
          createdAt: at,
          updatedAt: at,
        };
        let row: PaymentRow;
        if (input.method === 'CASH') {
          if (input.tenderedPaise < bill.totalPaise) {
            throw new AppError(
              400,
              'UNDERPAYMENT',
              `Cash received (₹${(input.tenderedPaise / 100).toFixed(2)}) is less than the total (₹${(bill.totalPaise / 100).toFixed(2)})`,
              { totalPaise: bill.totalPaise, tenderedPaise: input.tenderedPaise },
            );
          }
          row = insertAttempt(tx, {
            ...base,
            method: 'CASH',
            status: 'SUCCEEDED',
            tenderedPaise: input.tenderedPaise,
            changePaise: input.tenderedPaise - bill.totalPaise,
            completedAt: at,
          });
        } else if (input.method === 'CREDIT') {
          row = insertAttempt(tx, {
            ...base,
            method: 'CREDIT',
            status: 'SUCCEEDED',
            note: `On credit: ${input.customerName} (${input.customerPhone})`,
            completedAt: at,
          });
          recordCreditSale(tx, { paymentId: row.id, billId: bill.id, amountPaise: bill.totalPaise, name: input.customerName, phone: input.customerPhone, at });
        } else if (input.outcome === 'SUCCEEDED') {
          row = insertAttempt(tx, {
            ...base,
            method: 'UPI_MANUAL',
            status: 'SUCCEEDED',
            providerReference: input.providerReference,
            note: 'Manually verified by cashier in merchant app / bank',
            completedAt: at,
          });
        } else {
          row = insertAttempt(tx, {
            ...base,
            method: 'UPI_MANUAL',
            status: 'FAILED',
            providerReference: input.providerReference,
            failureReason: input.failureReason,
            completedAt: at,
          });
        }
        if (row.status === 'SUCCEEDED') markBillPaid(tx, bill.id);
        touchOrder(tx, orderId);
        return row;
      });
      publish(orderId);
      return { checkout: checkout(orderId), payment: toPaymentDTO(payment), duplicate: false };
    },

    /**
     * Payment through a provider (future terminal). Two phases so an uncertain outcome is never
     * lost or silently retried: commit PENDING -> ask the provider -> commit the outcome.
     */
    async startProviderPayment(
      orderId: number,
      input: Extract<RecordPaymentInput, { method: 'TERMINAL' }>,
    ): Promise<{ checkout: CheckoutDTO; payment: PaymentDTO; duplicate: boolean }> {
      const provider = providers.find((p) => p.methods.includes(input.method));
      if (!provider) {
        throw new AppError(400, 'PROVIDER_NOT_CONFIGURED', 'No payment terminal is connected. Use cash or manual UPI.');
      }
      const existing = findByKey(db, orderId, input.idempotencyKey);
      if (existing) return { checkout: checkout(orderId), payment: toPaymentDTO(existing), duplicate: true };

      const pending = db.transaction((tx) => {
        const bill = assertPayable(tx, orderId, input.expectedTotalPaise);
        const row = insertAttempt(tx, {
          orderId,
          billId: bill.id,
          method: input.method,
          status: 'PENDING',
          amountPaise: bill.totalPaise,
          idempotencyKey: input.idempotencyKey,
          provider: provider.id,
          createdAt: now(),
          updatedAt: now(),
        });
        touchOrder(tx, orderId);
        return row;
      });
      publish(orderId);

      const order = opts.loadOrder(orderId);
      let result: ProviderOutcome;
      let timer: NodeJS.Timeout | undefined;
      try {
        result = await Promise.race([
          provider.collect({
            paymentId: pending.id,
            idempotencyKey: pending.idempotencyKey,
            orderNumber: order.orderNumber,
            amountPaise: pending.amountPaise,
          }),
          new Promise<ProviderOutcome>((resolve) => {
            timer = setTimeout(() => resolve({ outcome: 'UNKNOWN', reason: 'No response from the terminal in time' }), providerTimeoutMs);
          }),
        ]);
      } catch (e) {
        // An error talking to the device does NOT mean the customer wasn't charged.
        result = { outcome: 'UNKNOWN', reason: `Terminal error: ${e instanceof Error ? e.message : 'unknown'}` };
      } finally {
        clearTimeout(timer);
      }

      db.transaction((tx) => {
        const at = now();
        const status: PaymentStatus = result.outcome;
        const r = tx
          .update(payments)
          .set({
            status,
            providerReference: result.reference ?? null,
            failureReason: result.outcome === 'SUCCEEDED' ? null : result.reason,
            completedAt: status === 'UNKNOWN' ? null : at,
            updatedAt: at,
          })
          // Only if still PENDING: someone may have resolved it by hand meanwhile.
          .where(and(eq(payments.id, pending.id), eq(payments.status, 'PENDING')))
          .run();
        if (r.changes === 1 && status === 'SUCCEEDED') markBillPaid(tx, pending.billId);
        if (r.changes === 1) touchOrder(tx, orderId);
      });
      publish(orderId);
      const row = db.select().from(payments).where(eq(payments.id, pending.id)).get()!;
      return { checkout: checkout(orderId), payment: toPaymentDTO(row), duplicate: false };
    },

    /** A person checked the terminal/bank and records what really happened (admin only). */
    resolvePayment(paymentId: number, input: { outcome: 'SUCCEEDED' | 'FAILED'; providerReference: string | null; note: string }) {
      const result = db.transaction((tx) => {
        const p = tx.select().from(payments).where(eq(payments.id, paymentId)).get();
        if (!p) throw notFound(`Payment ${paymentId} not found`);
        if (p.status === input.outcome) return { row: p, changed: false };
        if (p.status !== 'PENDING' && p.status !== 'UNKNOWN') {
          throw new AppError(409, 'NOT_UNRESOLVED', `Payment ${paymentReference(p.id)} is ${p.status} and cannot be resolved`);
        }
        const at = now();
        tx.update(payments)
          .set({
            status: input.outcome,
            providerReference: input.providerReference ?? p.providerReference,
            note: input.note,
            completedAt: at,
            updatedAt: at,
          })
          .where(eq(payments.id, p.id))
          .run();
        if (input.outcome === 'SUCCEEDED') markBillPaid(tx, p.billId);
        opts.hooks?.afterManualResolve?.(tx, p, input.outcome);
        touchOrder(tx, p.orderId);
        return { row: tx.select().from(payments).where(eq(payments.id, p.id)).get()!, changed: true };
      });
      if (result.changed) publish(result.row.orderId);
      return { payment: toPaymentDTO(result.row), changed: result.changed, checkout: checkout(result.row.orderId) };
    },

    /** Records a FULL refund that has already been handed back to the customer (admin only). */
    refundPayment(paymentId: number, input: { reason: string }) {
      const result = db.transaction((tx) => {
        const p = tx.select().from(payments).where(eq(payments.id, paymentId)).get();
        if (!p) throw notFound(`Payment ${paymentId} not found`);
        if (p.status === 'REFUNDED') return { row: p, changed: false, orderIds: [p.orderId] };
        if (p.status !== 'SUCCEEDED') {
          throw new AppError(409, 'NOT_REFUNDABLE', `Only successful payments can be refunded (this one is ${p.status})`);
        }
        if (p.method === 'CREDIT') {
          throw new AppError(409, 'NOT_REFUNDABLE', 'A bill on credit cannot be refunded. Collect the money owed instead.');
        }
        if (p.provider !== 'MANUAL') {
          throw new AppError(409, 'NOT_REFUNDABLE', 'Refund terminal payments on the terminal itself');
        }
        const at = now();
        tx.update(payments).set({ status: 'REFUNDED', refundedAt: at, refundReason: input.reason, updatedAt: at }).where(eq(payments.id, p.id)).run();
        tx.update(bills).set({ status: 'REFUNDED', updatedAt: at }).where(eq(bills.id, p.billId)).run();
        const covered = tx.select({ orderId: billOrders.orderId }).from(billOrders).where(eq(billOrders.billId, p.billId)).all();
        const orderIds = covered.length > 0 ? covered.map((c) => c.orderId) : [p.orderId];
        for (const id of orderIds) touchOrder(tx, id);
        return { row: tx.select().from(payments).where(eq(payments.id, p.id)).get()!, changed: true, orderIds };
      });
      if (result.changed) {
        for (const id of result.orderIds) publish(id);
      }
      return { payment: toPaymentDTO(result.row), changed: result.changed, checkout: checkout(result.row.orderId) };
    },

    receipt(orderId: number): ReceiptDTO {
      const order = opts.loadOrder(orderId);
      let bill = db.select().from(bills).where(eq(bills.orderId, orderId)).get();
      if (!bill) {
        const bo = db.select().from(billOrders).innerJoin(bills, eq(billOrders.billId, bills.id)).where(eq(billOrders.orderId, orderId)).get();
        if (bo) bill = bo.bills;
      }
      if (!bill) throw new AppError(409, 'BILL_REQUIRED', 'Generate the bill first');
      let attempts = attemptsFor(db, orderId);
      if (attempts.length === 0) {
        attempts = db.select().from(payments).where(eq(payments.billId, bill.id)).orderBy(desc(payments.id)).all();
      }
      if (bill.status === 'OPEN') db.update(bills).set({ printedAt: now() }).where(eq(bills.id, bill.id)).run();
      const settled = attempts.find((p) => p.status === 'SUCCEEDED') ?? attempts.find((p) => p.status === 'REFUNDED');
      const { taxes: _t, roundToRupee: _r, configured: _c, ...restaurant } = readSettings();
      return {
        restaurant,
        order,
        bill: toBillDTO(bill),
        paymentStatus: bill.status === 'PAID' ? 'PAID' : bill.status === 'REFUNDED' ? 'REFUNDED' : derivePaymentStatus(attempts),
        payment: settled ? toPaymentDTO(settled) : null,
        generatedAt: now().toISOString(),
      };
    },

    checkoutTable,

    kit: {
      assertPayableOrder: (tx, orderId, expectedTotalPaise) => assertPayable(tx, orderId, expectedTotalPaise),
      assertPayableTable(tx, tableId, expectedTotalPaise) {
        const bill = tx.select().from(bills).where(and(eq(bills.tableId, tableId), eq(bills.status, 'OPEN'))).get();
        if (!bill) throw new AppError(409, 'BILL_REQUIRED', 'Generate the bill before taking payment');
        if (bill.totalPaise <= 0) throw new AppError(409, 'ZERO_TOTAL', 'The bill total is ₹0; nothing to pay');
        if (bill.totalPaise !== expectedTotalPaise) {
          throw new AppError(409, 'BILL_CHANGED', 'The bill changed since it was shown. Check the new total and try again.', { totalPaise: bill.totalPaise });
        }
        const orderIds = tx.select({ orderId: billOrders.orderId }).from(billOrders).where(eq(billOrders.billId, bill.id)).all().map((r) => r.orderId);
        for (const id of orderIds) {
          const ord = getOrderRow(tx, id);
          if (ord.status === 'CANCELLED') throw new AppError(409, 'ORDER_CANCELLED', 'Cancelled orders cannot be paid');
          const attempts = attemptsFor(tx, id);
          if (attempts.some((a) => a.status === 'SUCCEEDED')) throw new AppError(409, 'ALREADY_PAID', `Order #${ord.orderNumber} is already paid`);
          const open = attempts.find((a) => a.status === 'PENDING' || a.status === 'UNKNOWN');
          if (open) {
            throw new AppError(409, 'PAYMENT_UNCERTAIN', `Payment ${paymentReference(open.id)} for this bill has an uncertain outcome. Check it and resolve it before taking another payment.`, { paymentId: open.id });
          }
        }
        return { bill, orderIds };
      },
      insertPayment: (tx, values) => insertAttempt(tx, values),
      markBillPaid: (tx, billId) => markBillPaid(tx, billId),
      touchOrder: (tx, orderId) => touchOrder(tx, orderId),
      orderIdsOfBill(tx, billId, fallbackOrderId) {
        const ids = tx.select({ orderId: billOrders.orderId }).from(billOrders).where(eq(billOrders.billId, billId)).all().map((r) => r.orderId);
        return ids.length > 0 ? ids : [fallbackOrderId];
      },
      publish: (orderId) => publish(orderId),
      checkout: (orderId) => checkout(orderId),
      checkoutTable: (tableId) => checkoutTable(tableId),
      toPaymentDTO: (row) => toPaymentDTO(row),
    } satisfies TerminalKit,

    generateTableBill,

    recordTablePayment(
      tableId: number,
      input: Exclude<RecordPaymentInput, { method: 'TERMINAL' }>,
    ): { checkout: TableCheckoutDTO; payment: PaymentDTO; duplicate: boolean } {
      const existingPayment = db
        .select()
        .from(payments)
        .innerJoin(bills, eq(payments.billId, bills.id))
        .where(and(eq(bills.tableId, tableId), eq(payments.idempotencyKey, input.idempotencyKey)))
        .get();

      if (existingPayment) {
        return { checkout: checkoutTable(tableId), payment: toPaymentDTO(existingPayment.payments), duplicate: true };
      }

      const openBill = db
        .select()
        .from(bills)
        .where(and(eq(bills.tableId, tableId), eq(bills.status, 'OPEN')))
        .get();

      if (!openBill) throw new AppError(409, 'BILL_REQUIRED', 'Generate the bill before taking payment');

      const { payment, touchedIds } = db.transaction((tx) => {
        const liveBill = tx.select().from(bills).where(eq(bills.id, openBill.id)).get();
        if (!liveBill || liveBill.status !== 'OPEN') throw new AppError(409, 'BILL_CLOSED', 'This bill is already closed');
        if (liveBill.totalPaise <= 0) throw new AppError(409, 'ZERO_TOTAL', 'The bill total is ₹0; nothing to pay');
        if (liveBill.totalPaise !== input.expectedTotalPaise) {
          throw new AppError(409, 'BILL_CHANGED', 'The bill changed since it was shown. Check the new total and try again.', {
            totalPaise: liveBill.totalPaise,
          });
        }

        const covered = tx.select({ orderId: billOrders.orderId }).from(billOrders).where(eq(billOrders.billId, liveBill.id)).all();
        const ids = covered.map((c) => c.orderId);

        for (const id of ids) {
          const ord = getOrderRow(tx, id);
          if (ord.status === 'CANCELLED') throw new AppError(409, 'ORDER_CANCELLED', 'Cancelled orders cannot be paid');
          const attempts = attemptsFor(tx, id);
          if (attempts.some((p) => p.status === 'SUCCEEDED')) {
            throw new AppError(409, 'ALREADY_PAID', `Order #${ord.orderNumber} is already paid`);
          }
        }

        const at = now();
        const base = {
          orderId: liveBill.orderId,
          billId: liveBill.id,
          amountPaise: liveBill.totalPaise,
          idempotencyKey: input.idempotencyKey,
          provider: 'MANUAL',
          createdAt: at,
          updatedAt: at,
        };

        let row: PaymentRow;
        if (input.method === 'CASH') {
          if (input.tenderedPaise < liveBill.totalPaise) {
            throw new AppError(
              400,
              'UNDERPAYMENT',
              `Cash received (₹${(input.tenderedPaise / 100).toFixed(2)}) is less than the total (₹${(liveBill.totalPaise / 100).toFixed(2)})`,
              { totalPaise: liveBill.totalPaise, tenderedPaise: input.tenderedPaise },
            );
          }
          row = insertAttempt(tx, {
            ...base,
            method: 'CASH',
            status: 'SUCCEEDED',
            tenderedPaise: input.tenderedPaise,
            changePaise: input.tenderedPaise - liveBill.totalPaise,
            completedAt: at,
          });
        } else if (input.method === 'CREDIT') {
          row = insertAttempt(tx, {
            ...base,
            method: 'CREDIT',
            status: 'SUCCEEDED',
            note: `On credit: ${input.customerName} (${input.customerPhone})`,
            completedAt: at,
          });
          recordCreditSale(tx, { paymentId: row.id, billId: liveBill.id, amountPaise: liveBill.totalPaise, name: input.customerName, phone: input.customerPhone, at });
        } else if (input.outcome === 'SUCCEEDED') {
          row = insertAttempt(tx, {
            ...base,
            method: 'UPI_MANUAL',
            status: 'SUCCEEDED',
            providerReference: input.providerReference,
            note: 'Manually verified by cashier in merchant app / bank',
            completedAt: at,
          });
        } else {
          row = insertAttempt(tx, {
            ...base,
            method: 'UPI_MANUAL',
            status: 'FAILED',
            providerReference: input.providerReference,
            failureReason: input.failureReason,
            completedAt: at,
          });
        }

        if (row.status === 'SUCCEEDED') markBillPaid(tx, liveBill.id);
        for (const id of ids) touchOrder(tx, id);

        return { payment: row, touchedIds: ids };
      });

      for (const id of touchedIds) publish(id);
      return { checkout: checkoutTable(tableId), payment: toPaymentDTO(payment), duplicate: false };
    },

    tableReceipt(tableId: number): TableReceiptDTO {
      const table = db.select().from(diningTables).where(eq(diningTables.id, tableId)).get();
      if (!table) throw notFound(`Table ${tableId} not found`);

      // Check for active unpaid orders first
      const orderRows = db
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(
            eq(orders.orderType, 'DINE_IN'),
            ne(orders.status, 'CANCELLED'),
            sql`(${orders.tableId} = ${tableId} OR (${orders.tableId} IS NULL AND lower(${orders.tableNumber}) = lower(${table.name})))`,
          ),
        )
        .orderBy(asc(orders.createdAt), asc(orders.id))
        .all();
      const activeUnpaidOrders = orderRows
        .map((r) => opts.loadOrder(r.id))
        .filter((o) => o.paymentStatus !== 'PAID' && o.status !== 'CANCELLED');

      let bill: typeof bills.$inferSelect | undefined;

      if (activeUnpaidOrders.length > 0) {
        bill = db
          .select()
          .from(bills)
          .where(and(eq(bills.tableId, tableId), eq(bills.status, 'OPEN')))
          .get();

        // A leftover bill that does not match what is on the table now must not be printed.
        if (bill) {
          const covered = new Set(db.select({ id: billOrders.orderId }).from(billOrders).where(eq(billOrders.billId, bill.id)).all().map((r) => r.id));
          const wanted = new Set(activeUnpaidOrders.map((o) => o.id));
          if (covered.size !== wanted.size || [...wanted].some((id) => !covered.has(id))) bill = undefined;
        }

        if (!bill) {
          try {
            const checkout = generateTableBill(tableId, { discount: { type: 'NONE' } });
            if (checkout.bill) {
              bill = db.select().from(bills).where(eq(bills.id, checkout.bill.id)).get();
            }
          } catch {
            // Fall through to error below if no orders exist
          }
        }
      } else {
        bill = db
          .select()
          .from(bills)
          .where(eq(bills.tableId, tableId))
          .orderBy(desc(bills.id))
          .limit(1)
          .get();
      }

      if (!bill) throw new AppError(409, 'BILL_REQUIRED', 'Generate the bill first');

      if (bill.status === 'OPEN') db.update(bills).set({ printedAt: now() }).where(eq(bills.id, bill.id)).run();
      const coveredRows = db
        .select({ orderId: billOrders.orderId })
        .from(billOrders)
        .where(eq(billOrders.billId, bill.id))
        .all();
      const coveredOrders = coveredRows.map((r) => opts.loadOrder(r.orderId));

      const attempts = db.select().from(payments).where(eq(payments.billId, bill.id)).orderBy(desc(payments.id)).all();
      const settled = attempts.find((p) => p.status === 'SUCCEEDED') ?? attempts.find((p) => p.status === 'REFUNDED');
      const { taxes: _t, roundToRupee: _r, configured: _c, ...restaurant } = readSettings();

      return {
        restaurant,
        table: { id: table.id, name: table.name },
        orders: coveredOrders,
        bill: toBillDTO(bill),
        paymentStatus: bill.status === 'PAID' ? 'PAID' : bill.status === 'REFUNDED' ? 'REFUNDED' : derivePaymentStatus(attempts),
        payment: settled ? toPaymentDTO(settled) : null,
        generatedAt: now().toISOString(),
      };
    },

    /**
     * Daily summary for one LOCAL calendar day of the reception computer.
     *  - Sales are counted on the day the payment was completed (cash basis).
     *  - A refund is subtracted on the day it was recorded, even for an older sale.
     *  - FAILED / PENDING / UNKNOWN attempts are never revenue.
     */
    /** Today's date (server local time) as YYYY-MM-DD. */
    todayKey(): string {
      const t = now();
      return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    },

    dailySummary(date?: string): DailySummaryDTO {
      const today = now();
      const [y, m, d] = (date ?? `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`).split('-').map(Number);
      const from = new Date(y, m - 1, d);
      const to = new Date(y, m - 1, d + 1); // next local midnight (handles DST)
      const inDay = (col: typeof payments.completedAt | typeof payments.refundedAt) => and(gte(col, from), lt(col, to));

      const dayOrders = db.query.orders
        .findMany({
          where: and(gte(orders.createdAt, from), lt(orders.createdAt, to), ne(orders.status, 'CANCELLED')),
          with: { bill: true, payments: true },
        })
        .sync();

      const sales = db
        .select()
        .from(payments)
        .where(and(inArray(payments.status, ['SUCCEEDED', 'REFUNDED']), inDay(payments.completedAt)))
        .all();
      const refunds = db.select().from(payments).where(and(eq(payments.status, 'REFUNDED'), inDay(payments.refundedAt))).all();

      const byMethod: DailySummaryDTO['byMethod'] = {
        CASH: { count: 0, totalPaise: 0 },
        UPI_MANUAL: { count: 0, totalPaise: 0 },
        TERMINAL: { count: 0, totalPaise: 0 },
        CREDIT: { count: 0, totalPaise: 0 },
      };
      for (const p of sales) {
        byMethod[p.method].count++;
        byMethod[p.method].totalPaise += p.amountPaise;
      }
      const grossSalesPaise = sales.reduce((s, p) => s + p.amountPaise, 0);
      const refundTotalPaise = refunds.reduce((s, p) => s + p.amountPaise, 0);

      const settings = readSettings();
      // Orders settled through a table bill have their payment recorded on the bill, not on the order itself.
      const dayIds = dayOrders.map((o) => o.id);
      const viaBill = new Map<number, (typeof payments.$inferSelect)[]>();
      if (dayIds.length > 0) {
        const linked = db
          .select({ orderId: billOrders.orderId, p: payments })
          .from(billOrders)
          .innerJoin(payments, eq(payments.billId, billOrders.billId))
          .where(inArray(billOrders.orderId, dayIds))
          .all();
        for (const l of linked) viaBill.set(l.orderId, [...(viaBill.get(l.orderId) ?? []), l.p]);
      }
      const unpaid = dayOrders.filter((o) => {
        const status = derivePaymentStatus(o.payments.length > 0 ? o.payments : (viaBill.get(o.id) ?? []));
        return status !== 'PAID' && status !== 'REFUNDED';
      });

      // Every attempt touching this day, for the reconciliation list.
      const dayPayments = db
        .select({ p: payments, orderNumber: orders.orderNumber })
        .from(payments)
        .innerJoin(orders, eq(payments.orderId, orders.id))
        .where(
          or(
            and(gte(payments.createdAt, from), lt(payments.createdAt, to)),
            inDay(payments.completedAt),
            inDay(payments.refundedAt),
          ),
        )
        .orderBy(asc(payments.id))
        .all();
      const attemptsCreatedToday = dayPayments.filter((r) => r.p.createdAt >= from && r.p.createdAt < to).map((r) => r.p);

      return {
        date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
        from: from.toISOString(),
        to: to.toISOString(),
        orderCount: dayOrders.length,
        grossSalesPaise,
        paidCount: sales.length,
        byMethod,
        refundCount: refunds.length,
        refundTotalPaise,
        netSalesPaise: grossSalesPaise - refundTotalPaise,
        credit: creditTotals(db, from, to),
        unpaidCount: unpaid.length,
        unpaidTotalPaise: unpaid.reduce((s, o) => s + (o.bill?.totalPaise ?? estimateTotal(o.subtotalPaise, settings)), 0),
        failedAttemptCount: attemptsCreatedToday.filter((p) => p.status === 'FAILED').length,
        uncertainAttemptCount: attemptsCreatedToday.filter((p) => p.status === 'PENDING' || p.status === 'UNKNOWN').length,
        payments: dayPayments.map((r) => ({ ...toPaymentDTO(r.p), orderNumber: r.orderNumber })),
      };
    },
  };
}

export type BillingService = ReturnType<typeof createBillingService>;
