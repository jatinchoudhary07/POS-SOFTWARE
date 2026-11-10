import { randomBytes } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { DB } from '../../db/client';
import { bills, paytmAttempts, paytmEvents, payments, type PaymentStatus, type PaytmAttemptState } from '../../db/schema';
import { AppError, notFound } from '../../lib/errors';
import type { BillingTx, CheckoutDTO, PaymentDTO, PaymentHooks, PaymentRow, TableCheckoutDTO, TerminalKit } from '../../services/billingService';
import { paymentReference } from '../../services/billingService';
import { classifySaleRejection } from './codes';
import { MockPaytmClient, type MockScenario } from './mock';
import { decideFromStatus, nextPollDelayMs, type AttemptFacts } from './stateMachine';
import { PaytmTransportError, type PaytmClient, type PaytmStatusResult } from './types';

type AttemptRow = typeof paytmAttempts.$inferSelect;
const OPEN: PaytmAttemptState[] = ['CREATED', 'SENDING', 'ACCEPTED'];
const POLLED: PaytmAttemptState[] = ['SENDING', 'ACCEPTED'];

export interface PaytmOptions {
  client: PaytmClient;
  /** Stored in payments.provider. 'PAYTM_MOCK' in Stage 1. */
  providerId: string;
  /** Prefix of the merchantTransactionId, so test and real ids can never be confused. */
  txnPrefix: string;
  mode: 'mock' | 'live';
  /** Give up waiting for the Sale answer after this (the outcome is then unknown, not failed). */
  saleTimeoutMs?: number;
  statusTimeoutMs?: number;
  /** Status checks: every `pollFastMs` at first, then every `pollSlowMs`. */
  pollFastMs?: number;
  pollSlowMs?: number;
  /** An attempt still unfinished after this becomes UNKNOWN. */
  maxWaitMs?: number;
  /** After a Sale with no answer, "no such transaction" is only believed after this long. */
  notFoundGraceMs?: number;
  /** A person pressing "Check now" is held to this gap, so the terminal service is not hammered. */
  minManualCheckGapMs?: number;
}

export type StartTarget = { kind: 'order'; orderId: number } | { kind: 'table'; tableId: number };

/** What the screens show about a terminal payment. Contains no secrets and no card data. */
export interface TerminalAttemptDTO {
  paymentId: number;
  paymentStatus: PaymentStatus;
  state: PaytmAttemptState;
  provider: string;
  amountPaise: number;
  /** A sentence for the cashier. */
  message: string;
  startedAt: string;
  deadlineAt: string;
  pollCount: number;
  lastCheckedAt: string | null;
  needsReview: boolean;
  reviewNote: string | null;
  voidState: string | null;
  voidMessage: string | null;
  /** Practice mode: no real money moves. */
  mock: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** yyyy-MM-dd HH:mm:ss, the format the terminal service uses. */
export const formatTerminalTime = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

const isUnique = (e: unknown) => typeof e === 'object' && e !== null && 'code' in e && String((e as { code: unknown }).code).startsWith('SQLITE_CONSTRAINT_UNIQUE');
const errText = (e: unknown) => (e instanceof Error ? e.message : 'unknown error');

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new PaytmTransportError('No answer from the terminal service in time')), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

export function createPaytmPayments(db: DB, kit: TerminalKit, opts: PaytmOptions, now: () => Date = () => new Date()) {
  const client = opts.client;
  const saleTimeoutMs = opts.saleTimeoutMs ?? 15_000;
  const statusTimeoutMs = opts.statusTimeoutMs ?? 10_000;
  const fastMs = opts.pollFastMs ?? 3_000;
  const slowMs = opts.pollSlowMs ?? 10_000;
  const maxWaitMs = opts.maxWaitMs ?? 10 * 60_000;
  const notFoundGraceMs = opts.notFoundGraceMs ?? 60_000;
  const minManualGapMs = opts.minManualCheckGapMs ?? 2_000;
  const isMock = opts.mode === 'mock';
  /** Attempts being checked right now in this process: a second check for the same one just waits for the first. */
  const inflight = new Set<number>();
  let timer: NodeJS.Timeout | undefined;

  // -- small helpers ----------------------------------------------------------

  const getAttempt = (id: number) => db.select().from(paytmAttempts).where(eq(paytmAttempts.id, id)).get();
  const getByPayment = (paymentId: number) => db.select().from(paytmAttempts).where(eq(paytmAttempts.paymentId, paymentId)).get();
  const getPayment = (id: number) => db.select().from(payments).where(eq(payments.id, id)).get();

  function log(tx: BillingTx | DB, attemptId: number, kind: string, extra: { request?: unknown; response?: unknown; note?: string } = {}) {
    tx.insert(paytmEvents)
      .values({ attemptId, kind, request: (extra.request ?? null) as never, response: (extra.response ?? null) as never, note: extra.note ?? null, at: now() })
      .run();
  }

  function message(a: AttemptRow, p: PaymentRow | undefined): string {
    switch (a.state) {
      case 'CREATED':
      case 'SENDING':
        return 'Sending the payment to the terminal…';
      case 'ACCEPTED':
        return 'Waiting for the customer to pay on the terminal';
      case 'SUCCEEDED':
        return a.voidState === 'VOIDED' ? 'Paid, then voided on the terminal' : 'Paid';
      case 'FAILED':
        return p?.failureReason ?? 'The payment did not go through. The customer was not charged.';
      case 'UNKNOWN':
        return p?.failureReason ?? 'The outcome is not certain. Check the terminal before taking another payment.';
    }
  }

  function toDTO(a: AttemptRow): TerminalAttemptDTO {
    const p = getPayment(a.paymentId);
    return {
      paymentId: a.paymentId,
      paymentStatus: p?.status ?? 'PENDING',
      state: a.state,
      provider: a.provider,
      amountPaise: a.amountPaise,
      message: message(a, p),
      startedAt: a.createdAt.toISOString(),
      deadlineAt: a.deadlineAt.toISOString(),
      pollCount: a.pollCount,
      lastCheckedAt: a.lastPolledAt?.toISOString() ?? null,
      needsReview: a.needsReview,
      reviewNote: a.reviewNote,
      voidState: a.voidState,
      voidMessage: a.voidMessage,
      mock: isMock,
    };
  }

  function publishAll(orderIds: number[]) {
    for (const id of new Set(orderIds)) kit.publish(id);
  }

  // -- settling (every one is a single transaction and a conditional update, so it can only happen once) ----------

  function settleSucceeded(attemptId: number, d: { acquirementId: string | null; rrn: string | null; payMethod: string | null }, last: { status: string; code: string; msg: string }) {
    const out = db.transaction((tx) => {
      const a = tx.select().from(paytmAttempts).where(eq(paytmAttempts.id, attemptId)).get();
      if (!a) return { changed: false, orderIds: [] as number[] };
      const at = now();
      const r = tx
        .update(paytmAttempts)
        .set({ state: 'SUCCEEDED', acquirementId: d.acquirementId, rrn: d.rrn, payMethod: d.payMethod, lastResultStatus: last.status, lastResultCode: last.code, lastResultMessage: last.msg, finishedAt: at, nextPollAt: null, updatedAt: at })
        .where(and(eq(paytmAttempts.id, attemptId), inArray(paytmAttempts.state, [...OPEN, 'UNKNOWN'])))
        .run();
      // Already settled (a repeated "success" answer, or another check got there first): nothing more to do.
      if (r.changes !== 1) return { changed: false, orderIds: [] as number[] };

      const p = tx.select().from(payments).where(eq(payments.id, a.paymentId)).get()!;
      const bill = tx.select().from(bills).where(eq(bills.id, p.billId)).get()!;
      const orderIds = kit.orderIdsOfBill(tx, p.billId, p.orderId);
      if ((p.status === 'PENDING' || p.status === 'UNKNOWN') && bill.status === 'OPEN') {
        tx.update(payments)
          .set({ status: 'SUCCEEDED', providerReference: d.rrn ?? d.acquirementId ?? a.merchantTransactionId, failureReason: null, note: 'Confirmed by the terminal service (status enquiry)', completedAt: at, updatedAt: at })
          .where(and(eq(payments.id, p.id), inArray(payments.status, ['PENDING', 'UNKNOWN'])))
          .run();
        kit.markBillPaid(tx, p.billId);
        log(tx, attemptId, 'SETTLED', { note: 'Confirmed by status enquiry; bill marked paid' });
      } else {
        // The terminal says the money arrived, but this payment/bill was already closed another way. Never paper over it.
        tx.update(paytmAttempts)
          .set({ needsReview: true, reviewNote: `The terminal confirmed this payment, but it had already been marked ${p.status} (bill ${bill.status}). Check the money with Paytm.` })
          .where(eq(paytmAttempts.id, attemptId))
          .run();
        log(tx, attemptId, 'ANOMALY', { note: `Success confirmed but payment was ${p.status} and bill ${bill.status}` });
      }
      kit.touchOrder(tx, p.orderId);
      return { changed: true, orderIds };
    });
    publishAll(out.orderIds);
    return out.changed;
  }

  function settleFailed(attemptId: number, reason: string, last: { status: string; code: string; msg: string } | null) {
    const out = db.transaction((tx) => {
      const a = tx.select().from(paytmAttempts).where(eq(paytmAttempts.id, attemptId)).get();
      if (!a) return { changed: false, orderIds: [] as number[] };
      const at = now();
      const r = tx
        .update(paytmAttempts)
        .set({ state: 'FAILED', ...(last ? { lastResultStatus: last.status, lastResultCode: last.code, lastResultMessage: last.msg } : {}), finishedAt: at, nextPollAt: null, updatedAt: at })
        .where(and(eq(paytmAttempts.id, attemptId), inArray(paytmAttempts.state, [...OPEN, 'UNKNOWN'])))
        .run();
      if (r.changes !== 1) return { changed: false, orderIds: [] as number[] };
      const p = tx.select().from(payments).where(eq(payments.id, a.paymentId)).get()!;
      tx.update(payments)
        .set({ status: 'FAILED', failureReason: reason, completedAt: at, updatedAt: at })
        .where(and(eq(payments.id, p.id), inArray(payments.status, ['PENDING', 'UNKNOWN'])))
        .run();
      log(tx, attemptId, 'FAILED', { note: reason });
      kit.touchOrder(tx, p.orderId);
      return { changed: true, orderIds: kit.orderIdsOfBill(tx, p.billId, p.orderId) };
    });
    publishAll(out.orderIds);
    return out.changed;
  }

  function settleUnknown(attemptId: number, reason: string, review: boolean) {
    const out = db.transaction((tx) => {
      const a = tx.select().from(paytmAttempts).where(eq(paytmAttempts.id, attemptId)).get();
      if (!a) return { changed: false, orderIds: [] as number[] };
      const at = now();
      if (a.state === 'UNKNOWN') {
        // already unknown: only remember a new warning
        if (review && !a.needsReview) tx.update(paytmAttempts).set({ needsReview: true, reviewNote: reason, updatedAt: at }).where(eq(paytmAttempts.id, attemptId)).run();
        return { changed: false, orderIds: [] as number[] };
      }
      const r = tx
        .update(paytmAttempts)
        .set({ state: 'UNKNOWN', nextPollAt: null, ...(review ? { needsReview: true, reviewNote: reason } : {}), updatedAt: at })
        .where(and(eq(paytmAttempts.id, attemptId), inArray(paytmAttempts.state, OPEN)))
        .run();
      if (r.changes !== 1) return { changed: false, orderIds: [] as number[] };
      const p = tx.select().from(payments).where(eq(payments.id, a.paymentId)).get()!;
      tx.update(payments).set({ status: 'UNKNOWN', failureReason: reason, completedAt: null, updatedAt: at }).where(and(eq(payments.id, p.id), eq(payments.status, 'PENDING'))).run();
      log(tx, attemptId, 'UNKNOWN', { note: reason });
      kit.touchOrder(tx, p.orderId);
      return { changed: true, orderIds: kit.orderIdsOfBill(tx, p.billId, p.orderId) };
    });
    publishAll(out.orderIds);
    return out.changed;
  }

  // -- starting a payment -----------------------------------------------------

  /** Phase 2 of a start: tell the terminal service. Never throws; whatever happens is recorded. */
  async function sendSale(attemptId: number) {
    const a = getAttempt(attemptId);
    if (!a || a.state !== 'CREATED') return;
    const sentAt = now();
    // Recorded BEFORE the request goes out: if we crash mid-request we know it may have been sent.
    db.update(paytmAttempts)
      .set({ state: 'SENDING', saleSentAt: sentAt, nextPollAt: new Date(sentAt.getTime() + fastMs), updatedAt: sentAt })
      .where(and(eq(paytmAttempts.id, attemptId), eq(paytmAttempts.state, 'CREATED')))
      .run();
    const payment = getPayment(a.paymentId)!;
    const request = { merchantTransactionId: a.merchantTransactionId, amountPaise: a.amountPaise, transactionDateTime: formatTerminalTime(a.createdAt), merchantReferenceNo: paymentReference(payment.id) };
    let result;
    try {
      result = await withTimeout(client.sale(request), saleTimeoutMs);
    } catch (e) {
      // No answer is NOT a failure: the terminal may have the request. Stay in SENDING; status checks decide.
      log(db, attemptId, 'SALE', { request, note: `No answer: ${errText(e)}` });
      db.update(paytmAttempts).set({ lastResultMessage: `No answer to the Sale request: ${errText(e)}`, updatedAt: now() }).where(eq(paytmAttempts.id, attemptId)).run();
      return;
    }
    log(db, attemptId, 'SALE', { request, response: result });
    if (result.kind === 'ACCEPTED') {
      const at = now();
      // ACCEPTED means "request taken", never "paid". The payment stays PENDING until a status enquiry confirms it.
      db.update(paytmAttempts)
        .set({ state: 'ACCEPTED', acceptedAt: at, lastResultStatus: 'A', lastResultCode: '0009', lastResultMessage: 'ACCEPTED_SUCCESS', nextPollAt: new Date(at.getTime() + fastMs), updatedAt: at })
        .where(and(eq(paytmAttempts.id, attemptId), eq(paytmAttempts.state, 'SENDING')))
        .run();
      return;
    }
    const verdict = classifySaleRejection(result.resultCodeId, result.resultMsg);
    const last = { status: 'F', code: result.resultCodeId, msg: result.resultMsg };
    if (verdict.action === 'FAIL') {
      settleFailed(attemptId, verdict.message, last);
    } else {
      // Cannot tell whether something exists on the terminal: ask for its status right away.
      db.update(paytmAttempts)
        .set({ lastResultStatus: 'F', lastResultCode: result.resultCodeId, lastResultMessage: result.resultMsg, nextPollAt: now(), updatedAt: now() })
        .where(eq(paytmAttempts.id, attemptId))
        .run();
    }
  }

  async function begin(target: StartTarget, input: { idempotencyKey: string; expectedTotalPaise: number }): Promise<{ row: PaymentRow; duplicate: boolean }> {
    // The same payment request id again: return what already exists. Never a second Sale.
    const existing = db.select().from(payments).where(eq(payments.idempotencyKey, input.idempotencyKey)).get();
    if (existing) {
      const bill = db.select().from(bills).where(eq(bills.id, existing.billId)).get();
      const same = target.kind === 'order' ? existing.orderId === target.orderId || bill?.orderId === target.orderId : bill?.tableId === target.tableId;
      if (!same) throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This payment request id was already used for a different bill');
      return { row: existing, duplicate: true };
    }

    const created = db.transaction((tx) => {
      const bill = target.kind === 'order' ? kit.assertPayableOrder(tx, target.orderId, input.expectedTotalPaise) : kit.assertPayableTable(tx, target.tableId, input.expectedTotalPaise).bill;
      const at = now();
      const row = kit.insertPayment(tx, {
        orderId: bill.orderId,
        billId: bill.id,
        method: 'TERMINAL',
        status: 'PENDING',
        amountPaise: bill.totalPaise,
        idempotencyKey: input.idempotencyKey,
        provider: opts.providerId,
        createdAt: at,
        updatedAt: at,
      });
      const txnId = `${opts.txnPrefix}${String(row.id).padStart(8, '0')}${randomBytes(4).toString('hex').toUpperCase().slice(0, 6)}`;
      try {
        const attempt = tx
          .insert(paytmAttempts)
          .values({ paymentId: row.id, merchantTransactionId: txnId, provider: opts.providerId, mid: client.mid, tid: client.tid, amountPaise: bill.totalPaise, state: 'CREATED', deadlineAt: new Date(at.getTime() + maxWaitMs), createdAt: at, updatedAt: at })
          .returning({ id: paytmAttempts.id })
          .get();
        log(tx, attempt.id, 'MANUAL', { note: 'Payment started from the checkout screen' });
        kit.touchOrder(tx, bill.orderId);
        return { row, attemptId: attempt.id, orderIds: kit.orderIdsOfBill(tx, bill.id, bill.orderId) };
      } catch (e) {
        // Only one unfinished payment per terminal. Throwing rolls the new payment row back too.
        if (isUnique(e) && /paytm_attempts\.tid/.test(errText(e))) {
          throw new AppError(409, 'TERMINAL_BUSY', 'Another payment is already waiting on the Paytm terminal. Finish or cancel it there first.');
        }
        throw e;
      }
    });
    publishAll(created.orderIds);
    await sendSale(created.attemptId);
    publishAll(created.orderIds);
    return { row: getPayment(created.row.id)!, duplicate: false };
  }

  // -- checking a payment -----------------------------------------------------

  /** One Status Enquiry for one attempt, and whatever it decides. Safe to call any number of times, from anywhere. */
  async function pollOnce(attemptId: number, o: { manual?: boolean } = {}): Promise<AttemptRow | undefined> {
    if (inflight.has(attemptId)) return getAttempt(attemptId);
    inflight.add(attemptId);
    try {
      const a0 = getAttempt(attemptId);
      if (!a0) return undefined;
      const canCheck = OPEN.includes(a0.state) || (o.manual && a0.state === 'UNKNOWN');
      if (!canCheck || a0.state === 'CREATED') return a0;

      const request = { merchantTransactionId: a0.merchantTransactionId, transactionDateTime: formatTerminalTime(a0.createdAt) };
      let result: PaytmStatusResult;
      try {
        result = await withTimeout(client.status(request), statusTimeoutMs);
      } catch (e) {
        result = { kind: 'ERROR', resultMsg: `No answer to the status request: ${errText(e)}` };
      }
      log(db, attemptId, 'STATUS', { request, response: result });

      // Something may have settled it while we were waiting (a person, or another check).
      const a = getAttempt(attemptId)!;
      if (!(OPEN.includes(a.state) || (o.manual && a.state === 'UNKNOWN'))) return a;

      const facts: AttemptFacts = { state: a.state, merchantTransactionId: a.merchantTransactionId, mid: a.mid, tid: a.tid, amountPaise: a.amountPaise, saleSentAt: a.saleSentAt, deadlineAt: a.deadlineAt };
      const decision = decideFromStatus(facts, result, { now: now(), notFoundGraceMs });
      const last = result.kind === 'RESPONSE' ? { status: result.resultStatus, code: result.resultCodeId, msg: result.resultMsg } : { status: '', code: result.kind === 'ERROR' ? (result.resultCodeId ?? '') : '0404', msg: result.kind === 'ERROR' ? result.resultMsg : 'No such transaction' };

      switch (decision.type) {
        case 'SUCCEED':
          settleSucceeded(attemptId, decision, last);
          break;
        case 'FAIL':
          settleFailed(attemptId, decision.reason, last);
          break;
        case 'UNKNOWN':
          settleUnknown(attemptId, decision.reason, decision.review);
          break;
        case 'KEEP': {
          const at = now();
          const polls = a.pollCount + 1;
          db.update(paytmAttempts)
            .set({
              pollCount: polls,
              lastPolledAt: at,
              statusErrorCount: decision.transientError ? a.statusErrorCount + 1 : 0,
              lastResultStatus: last.status,
              lastResultCode: last.code,
              lastResultMessage: last.msg,
              // The service knows our transaction (it answered pending): the request did arrive.
              ...(a.state === 'SENDING' && result.kind === 'RESPONSE' ? { state: 'ACCEPTED' as const, acceptedAt: at } : {}),
              ...(a.state === 'UNKNOWN' ? {} : { nextPollAt: new Date(at.getTime() + nextPollDelayMs(polls, fastMs, slowMs)) }),
              updatedAt: at,
            })
            .where(eq(paytmAttempts.id, attemptId))
            .run();
          break;
        }
      }
      if (decision.type !== 'KEEP') db.update(paytmAttempts).set({ pollCount: a.pollCount + 1, lastPolledAt: now() }).where(eq(paytmAttempts.id, attemptId)).run();
      return getAttempt(attemptId);
    } finally {
      inflight.delete(attemptId);
    }
  }

  /** One round of the reconciler: check every payment that is due. Returns how many were checked. */
  async function tick(): Promise<number> {
    const due = db
      .select({ id: paytmAttempts.id })
      .from(paytmAttempts)
      .where(and(inArray(paytmAttempts.state, POLLED), or(isNull(paytmAttempts.nextPollAt), lte(paytmAttempts.nextPollAt, now()))))
      .orderBy(asc(paytmAttempts.nextPollAt))
      .limit(20)
      .all();
    await Promise.all(due.map((d) => pollOnce(d.id).catch((e) => console.error('Terminal payment check failed:', errText(e)))));
    return due.length;
  }

  /**
   * After a restart: pick up every unfinished payment where it was left. Called once at startup, before serving requests.
   * A payment that never reached the Sale call is failed (nothing was sent); the rest are checked at once.
   */
  function recover(): { resumed: number; failed: number } {
    let resumed = 0;
    let failed = 0;
    const open = db.select().from(paytmAttempts).where(inArray(paytmAttempts.state, OPEN)).all();
    for (const a of open) {
      if (a.state === 'CREATED' && a.saleSentAt === null) {
        log(db, a.id, 'RECOVERY', { note: 'Found unsent after a restart' });
        if (settleFailed(a.id, 'The payment was interrupted before it reached the terminal. The customer was not charged.', null)) failed++;
      } else {
        log(db, a.id, 'RECOVERY', { note: 'Resuming status checks after a restart' });
        db.update(paytmAttempts).set({ nextPollAt: now(), updatedAt: now() }).where(eq(paytmAttempts.id, a.id)).run();
        resumed++;
      }
    }
    return { resumed, failed };
  }

  // -- same-day void ----------------------------------------------------------

  function applyVoid(attemptId: number) {
    const out = db.transaction((tx) => {
      const a = tx.select().from(paytmAttempts).where(eq(paytmAttempts.id, attemptId)).get()!;
      const at = now();
      const r = tx.update(paytmAttempts).set({ voidState: 'VOIDED', voidMessage: 'Voided on the terminal', updatedAt: at }).where(and(eq(paytmAttempts.id, attemptId), or(isNull(paytmAttempts.voidState), inArray(paytmAttempts.voidState, ['REQUESTED', 'UNKNOWN'])))).run();
      if (r.changes !== 1) return [] as number[];
      const p = tx.select().from(payments).where(eq(payments.id, a.paymentId)).get()!;
      tx.update(payments).set({ status: 'REFUNDED', refundedAt: at, refundReason: 'Voided on the terminal (same-day void)', updatedAt: at }).where(and(eq(payments.id, p.id), eq(payments.status, 'SUCCEEDED'))).run();
      tx.update(bills).set({ status: 'REFUNDED', updatedAt: at }).where(eq(bills.id, p.billId)).run();
      const ids = kit.orderIdsOfBill(tx, p.billId, p.orderId);
      for (const id of ids) kit.touchOrder(tx, id);
      log(tx, attemptId, 'VOID', { note: 'Void confirmed' });
      return ids;
    });
    publishAll(out);
  }

  async function confirmVoid(attemptId: number): Promise<'VOIDED' | 'PENDING' | 'REJECTED'> {
    const a = getAttempt(attemptId)!;
    const request = { merchantTransactionId: a.merchantTransactionId, transactionDateTime: formatTerminalTime(a.createdAt), event: 'VOID' as const };
    let result: PaytmStatusResult;
    try {
      result = await withTimeout(client.status(request), statusTimeoutMs);
    } catch (e) {
      result = { kind: 'ERROR', resultMsg: errText(e) };
    }
    log(db, attemptId, 'VOID_STATUS', { request, response: result });
    if (result.kind === 'RESPONSE' && result.resultStatus === 'S' && result.merchantTransactionId === a.merchantTransactionId && result.mid === a.mid && result.tid === a.tid) {
      applyVoid(attemptId);
      return 'VOIDED';
    }
    return result.kind === 'RESPONSE' && result.resultStatus === 'F' ? 'REJECTED' : 'PENDING';
  }

  /** Superadmin: cancel a successful terminal payment on the day it was taken. */
  async function voidPayment(paymentId: number): Promise<TerminalAttemptDTO> {
    const p = getPayment(paymentId);
    const a = getByPayment(paymentId);
    if (!p || !a) throw notFound(`Terminal payment ${paymentId} not found`);
    if (p.status !== 'SUCCEEDED' || a.state !== 'SUCCEEDED') throw new AppError(409, 'NOT_VOIDABLE', 'Only a successful terminal payment can be voided.');
    if (a.voidState === 'VOIDED' || a.voidState === 'REQUESTED') throw new AppError(409, 'VOID_IN_PROGRESS', 'A void was already requested for this payment.');
    if (!p.completedAt || dayKey(p.completedAt) !== dayKey(now())) {
      throw new AppError(409, 'VOID_TOO_LATE', 'A void is only possible on the day of the payment. After that, refund it on the terminal itself.');
    }
    const at = now();
    const marked = db
      .update(paytmAttempts)
      .set({ voidState: 'REQUESTED', voidRequestedAt: at, voidMessage: 'Void requested', updatedAt: at })
      .where(and(eq(paytmAttempts.id, a.id), or(isNull(paytmAttempts.voidState), inArray(paytmAttempts.voidState, ['FAILED', 'UNKNOWN']))))
      .run();
    if (marked.changes !== 1) throw new AppError(409, 'VOID_IN_PROGRESS', 'A void was already requested for this payment.');

    const request = { merchantTransactionId: a.merchantTransactionId, transactionDateTime: formatTerminalTime(a.createdAt) };
    let result;
    try {
      result = await withTimeout(client.void(request), saleTimeoutMs);
    } catch (e) {
      log(db, a.id, 'VOID', { request, note: `No answer: ${errText(e)}` });
      db.update(paytmAttempts).set({ voidState: 'UNKNOWN', voidMessage: 'The void request got no answer. Check it with "Check now".', updatedAt: now() }).where(eq(paytmAttempts.id, a.id)).run();
      return toDTO(getAttempt(a.id)!);
    }
    log(db, a.id, 'VOID', { request, response: result });
    if (result.kind === 'REJECTED') {
      db.update(paytmAttempts).set({ voidState: 'FAILED', voidMessage: `The terminal did not accept the void (${result.resultCodeId}: ${result.resultMsg})`, updatedAt: now() }).where(eq(paytmAttempts.id, a.id)).run();
      throw new AppError(409, 'VOID_REJECTED', `The terminal did not accept the void: ${result.resultMsg}`);
    }
    const outcome = await confirmVoid(a.id);
    if (outcome === 'REJECTED') {
      db.update(paytmAttempts).set({ voidState: 'FAILED', voidMessage: 'The void did not go through.', updatedAt: now() }).where(eq(paytmAttempts.id, a.id)).run();
    } else if (outcome === 'PENDING') {
      db.update(paytmAttempts).set({ voidState: 'UNKNOWN', voidMessage: 'The void is not confirmed yet. Check it with "Check now".', updatedAt: now() }).where(eq(paytmAttempts.id, a.id)).run();
    }
    return toDTO(getAttempt(a.id)!);
  }

  // -- what the routes use ----------------------------------------------------

  return {
    enabled: true as const,
    mode: opts.mode,
    providerId: opts.providerId,

    async startForOrder(orderId: number, input: { idempotencyKey: string; expectedTotalPaise: number }): Promise<{ checkout: CheckoutDTO; payment: PaymentDTO; duplicate: boolean }> {
      const { row, duplicate } = await begin({ kind: 'order', orderId }, input);
      return { checkout: kit.checkout(orderId), payment: kit.toPaymentDTO(row), duplicate };
    },

    async startForTable(tableId: number, input: { idempotencyKey: string; expectedTotalPaise: number }): Promise<{ checkout: TableCheckoutDTO; payment: PaymentDTO; duplicate: boolean }> {
      const { row, duplicate } = await begin({ kind: 'table', tableId }, input);
      return { checkout: kit.checkoutTable(tableId), payment: kit.toPaymentDTO(row), duplicate };
    },

    summary(paymentId: number): TerminalAttemptDTO {
      const a = getByPayment(paymentId);
      if (!a) throw notFound(`No terminal payment for payment ${paymentId}`);
      return toDTO(a);
    },

    /** "Check now": asks the terminal service about this payment (held to a short gap between presses). */
    async check(paymentId: number): Promise<TerminalAttemptDTO> {
      const a = getByPayment(paymentId);
      if (!a) throw notFound(`No terminal payment for payment ${paymentId}`);
      const recently = a.lastPolledAt !== null && now().getTime() - a.lastPolledAt.getTime() < minManualGapMs;
      if (a.state === 'SUCCEEDED' && (a.voidState === 'REQUESTED' || a.voidState === 'UNKNOWN')) {
        await confirmVoid(a.id);
      } else if (!recently) {
        await pollOnce(a.id, { manual: true });
      }
      return toDTO(getByPayment(paymentId)!);
    },

    voidPayment,

    /** A person settled an unsure payment by hand (see billingService.resolvePayment): close the attempt to match. */
    hooks: {
      afterManualResolve(tx, payment, outcome) {
        if (payment.provider !== opts.providerId) return;
        const a = tx.select().from(paytmAttempts).where(eq(paytmAttempts.paymentId, payment.id)).get();
        if (!a || !(OPEN.includes(a.state) || a.state === 'UNKNOWN')) return;
        const at = now();
        tx.update(paytmAttempts).set({ state: outcome, finishedAt: at, nextPollAt: null, reviewNote: 'Settled by hand by the Superadmin', updatedAt: at }).where(eq(paytmAttempts.id, a.id)).run();
        log(tx, a.id, 'MANUAL', { note: `Settled by hand as ${outcome}` });
      },
    } satisfies PaymentHooks,

    capabilities() {
      return { enabled: true, mode: opts.mode, label: 'Paytm T9', practice: isMock };
    },

    /** Practice mode only: choose what the pretend terminal does with the next payments. */
    setMockScenario(s: MockScenario) {
      if (!(client instanceof MockPaytmClient)) throw new AppError(409, 'NOT_MOCK', 'Only the practice terminal can be scripted.');
      client.setDefault(s);
    },
    get mockScenario(): MockScenario | null {
      return client instanceof MockPaytmClient ? client.scenario : null;
    },

    tick,
    recover,
    pollOnce,

    /** Start the background checker (every second, looks for payments that are due). Call once after startup. */
    start() {
      if (timer) return;
      const r = recover();
      if (r.resumed + r.failed > 0) console.log(`Terminal payments: resumed ${r.resumed} unfinished, closed ${r.failed} that were never sent`);
      timer = setInterval(() => void tick().catch((e) => console.error('Terminal payment checker:', errText(e))), 1000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

export type PaytmPayments = ReturnType<typeof createPaytmPayments>;
