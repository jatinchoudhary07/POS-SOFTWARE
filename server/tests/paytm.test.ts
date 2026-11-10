import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { bills, menuItems, orders, paytmAttempts, paytmEvents, payments } from '../src/db/schema';
import { MockPaytmClient, type MockScenario } from '../src/payments/paytm/mock';
import type { PaytmOptions } from '../src/payments/paytm/service';
import { requestId, setupTestApp } from './helpers';

/**
 * Terminal payments against the PRACTICE terminal only. No network, no credentials: every "Paytm" answer here is scripted.
 */
function paytmCtx(scenario: MockScenario = { kind: 'SUCCESS', afterPolls: 2 }, extra: Partial<PaytmOptions> = {}) {
  let clock = new Date();
  const mock = new MockPaytmClient({ defaultScenario: scenario, now: () => clock });
  const options: PaytmOptions = { client: mock, providerId: 'PAYTM_MOCK', txnPrefix: 'MOCK', mode: 'mock', pollFastMs: 0, pollSlowMs: 0, minManualCheckGapMs: 0, ...extra };
  const ctx = setupTestApp({ now: () => clock, paytm: options });
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  return { ctx, mock, paytm: ctx.paytm!, options, advance, now: () => clock };
}
type Ctx = ReturnType<typeof paytmCtx>['ctx'];

const itemId = (ctx: Ctx, name: string) => ctx.db.select().from(menuItems).where(eq(menuItems.name, name)).get()!.id;

/** An order with a bill, ready to be paid: returns its id and the bill total in paise. */
async function readyOrder(ctx: Ctx, lines: [string, number][] = [['Paneer Tikka', 1]]) {
  const o = (
    await ctx.api
      .post('/api/orders')
      .send({ clientRequestId: requestId(), orderType: 'DINE_IN', tableNumber: '4', items: lines.map(([n, q]) => ({ menuItemId: itemId(ctx, n), quantity: q })) })
      .expect(201)
  ).body.order as { id: number };
  const total = (await ctx.api.post(`/api/orders/${o.id}/bill`).send({}).expect(200)).body.bill.totalPaise as number;
  return { id: o.id, total };
}

const startPay = (ctx: Ctx, orderId: number, total: number, key = requestId()) =>
  ctx.api.post(`/api/orders/${orderId}/payments`).send({ method: 'TERMINAL', idempotencyKey: key, expectedTotalPaise: total });
const attemptOf = (ctx: Ctx, paymentId: number) => ctx.db.select().from(paytmAttempts).where(eq(paytmAttempts.paymentId, paymentId)).get()!;
const paymentOf = (ctx: Ctx, id: number) => ctx.db.select().from(payments).where(eq(payments.id, id)).get()!;
const billOf = (ctx: Ctx, orderId: number) => ctx.db.select().from(bills).where(eq(bills.orderId, orderId)).get()!;
const orderPayState = async (ctx: Ctx, id: number) => (await ctx.api.get(`/api/orders/${id}`)).body.order.paymentStatus as string;
const eventKinds = (ctx: Ctx, attemptId: number) => ctx.db.select().from(paytmEvents).where(eq(paytmEvents.attemptId, attemptId)).all().map((e) => e.kind);
const ticks = async (p: { tick(): Promise<number> }, n: number) => {
  for (let i = 0; i < n; i++) await p.tick();
};

describe('terminal payments are OFF unless switched on', () => {
  it('shows no terminal and refuses a terminal payment, exactly as before', async () => {
    const ctx = setupTestApp(); // no `paytm` option = the default
    expect((await ctx.as('RECEPTION').get('/api/settings/payments').expect(200)).body).toEqual({ terminal: { enabled: false } });
    expect(ctx.paytm).toBeUndefined();
    const o = await (async () => {
      const r = (await ctx.api.post('/api/orders').send({ clientRequestId: requestId(), orderType: 'TAKEAWAY', items: [{ menuItemId: itemId(ctx as never, 'Paneer Tikka'), quantity: 1 }] }).expect(201)).body.order;
      const total = (await ctx.api.post(`/api/orders/${r.id}/bill`).send({}).expect(200)).body.bill.totalPaise;
      return { id: r.id as number, total: total as number };
    })();
    const res = await ctx.api.post(`/api/orders/${o.id}/payments`).send({ method: 'TERMINAL', idempotencyKey: requestId(), expectedTotalPaise: o.total }).expect(400);
    expect(res.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');
    await ctx.api.get('/api/payments/1/terminal').expect(409);
  });

  it('tells the screens (without any secret) when the practice terminal is on', async () => {
    const { ctx } = paytmCtx();
    const res = await ctx.as('RECEPTION').get('/api/settings/payments').expect(200);
    expect(res.body).toEqual({ terminal: { enabled: true, mode: 'mock', label: 'Paytm T9', practice: true } });
    await ctx.anon.get('/api/settings/payments').expect(401);
    await ctx.as('KITCHEN').get('/api/settings/payments').expect(403);
  });
});

describe('a successful terminal payment', () => {
  it('stays unpaid after the Sale is accepted, and is paid only when status enquiry confirms it', async () => {
    const { ctx, mock, paytm } = paytmCtx({ kind: 'SUCCESS', afterPolls: 3 });
    const o = await readyOrder(ctx);
    const res = await startPay(ctx, o.id, o.total).expect(201);
    const pid = res.body.payment.id as number;

    // Sale accepted (ACCEPTED_SUCCESS) -- the customer has not paid yet
    expect(res.body.payment).toMatchObject({ method: 'TERMINAL', status: 'PENDING', provider: 'PAYTM_MOCK', amountPaise: o.total });
    expect(res.body.checkout.order.paymentStatus).toBe('UNCERTAIN');
    expect(attemptOf(ctx, pid).state).toBe('ACCEPTED');
    expect(billOf(ctx, o.id).status).toBe('OPEN');

    // several checks answer "pending": still unpaid
    await ticks(paytm, 2);
    expect(paymentOf(ctx, pid).status).toBe('PENDING');
    expect(billOf(ctx, o.id).status).toBe('OPEN');
    expect(await orderPayState(ctx, o.id)).toBe('UNCERTAIN');

    // the final check confirms it
    await paytm.tick();
    expect(paymentOf(ctx, pid)).toMatchObject({ status: 'SUCCEEDED', method: 'TERMINAL', amountPaise: o.total });
    expect(paymentOf(ctx, pid).providerReference).toMatch(/^RRN/);
    expect(attemptOf(ctx, pid)).toMatchObject({ state: 'SUCCEEDED', rrn: expect.stringMatching(/^RRN/), payMethod: 'UPI' });
    expect(billOf(ctx, o.id).status).toBe('PAID');
    expect(await orderPayState(ctx, o.id)).toBe('PAID');

    // one Sale only; the rest were status checks
    expect(mock.calls.sale).toHaveLength(1);
    expect(mock.calls.status).toHaveLength(3);
    expect(eventKinds(ctx, attemptOf(ctx, pid).id)).toEqual(['MANUAL', 'SALE', 'STATUS', 'STATUS', 'STATUS', 'SETTLED']);
  });

  it('sends a valid, unique, clearly-marked transaction id, and the exact bill amount (never the client\'s)', async () => {
    const { ctx, mock } = paytmCtx({ kind: 'ACCEPTED_NO_RESULT' });
    const o = await readyOrder(ctx);
    await startPay(ctx, o.id, o.total).expect(201);
    const sent = mock.calls.sale[0];
    expect(sent.merchantTransactionId).toMatch(/^MOCK[0-9]{8}[0-9A-F]{6}$/); // alphanumeric, 8-32, never a real-looking id
    expect(sent.amountPaise).toBe(o.total);
    expect(sent.transactionDateTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // a stale total from the screen is refused before anything is sent
    const stale = await startPay(ctx, o.id, o.total + 100).expect(409);
    expect(['BILL_CHANGED', 'PAYMENT_UNCERTAIN']).toContain(stale.body.error.code);
    expect(mock.calls.sale).toHaveLength(1);
  });

  it('reports where it stands to the screen, and lets staff (not the kitchen) look', async () => {
    const { ctx } = paytmCtx({ kind: 'ACCEPTED_NO_RESULT' });
    const o = await readyOrder(ctx);
    const pid = (await startPay(ctx, o.id, o.total).expect(201)).body.payment.id;
    const t = (await ctx.as('RECEPTION').get(`/api/payments/${pid}/terminal`).expect(200)).body.terminal;
    expect(t).toMatchObject({ paymentId: pid, paymentStatus: 'PENDING', state: 'ACCEPTED', mock: true, needsReview: false, message: expect.stringContaining('Waiting for the customer') });
    expect(JSON.stringify(t)).not.toMatch(/merchantKey|checksum|secret/i);
    await ctx.as('KITCHEN').get(`/api/payments/${pid}/terminal`).expect(403);
    await ctx.anon.get(`/api/payments/${pid}/terminal`).expect(401);
    await ctx.as('KITCHEN').post(`/api/orders/${o.id}/payments`).send({ method: 'TERMINAL', idempotencyKey: requestId(), expectedTotalPaise: o.total }).expect(403);
  });
});

describe('payments that do not complete', () => {
  it('customer cancels on the terminal: failed, bill still unpaid, a new attempt gets a new transaction', async () => {
    const { ctx, mock, paytm } = paytmCtx({ kind: 'CUSTOMER_CANCEL', afterPolls: 2 });
    const o = await readyOrder(ctx);
    const pid = (await startPay(ctx, o.id, o.total).expect(201)).body.payment.id;
    await ticks(paytm, 2);
    expect(paymentOf(ctx, pid)).toMatchObject({ status: 'FAILED', failureReason: expect.stringContaining('not charged') });
    expect(attemptOf(ctx, pid).state).toBe('FAILED');
    expect(billOf(ctx, o.id).status).toBe('OPEN');
    expect(await orderPayState(ctx, o.id)).toBe('FAILED');

    mock.setDefault({ kind: 'SUCCESS', afterPolls: 1 });
    const second = (await startPay(ctx, o.id, o.total).expect(201)).body.payment;
    expect(second.id).not.toBe(pid);
    await paytm.tick();
    expect(paymentOf(ctx, second.id).status).toBe('SUCCEEDED');
    expect(new Set(mock.calls.sale.map((s) => s.merchantTransactionId)).size).toBe(2); // never reused
  });

  it('bank rejection: failed with a clear reason, nothing paid', async () => {
    const { ctx, paytm } = paytmCtx({ kind: 'BANK_REJECT', afterPolls: 1 });
    const o = await readyOrder(ctx);
    const pid = (await startPay(ctx, o.id, o.total).expect(201)).body.payment.id;
    await paytm.tick();
    expect(paymentOf(ctx, pid).status).toBe('FAILED');
    expect(attemptOf(ctx, pid)).toMatchObject({ state: 'FAILED', lastResultCode: '0011' });
    expect(billOf(ctx, o.id).status).toBe('OPEN');
  });

  it('terminal offline: refused up front, failed immediately, nothing waits', async () => {
    const { ctx, mock } = paytmCtx({ kind: 'TERMINAL_OFFLINE' });
    const o = await readyOrder(ctx);
    const res = await startPay(ctx, o.id, o.total).expect(201);
    expect(res.body.payment).toMatchObject({ status: 'FAILED', failureReason: expect.stringMatching(/offline/i) });
    expect(attemptOf(ctx, res.body.payment.id)).toMatchObject({ state: 'FAILED', lastResultCode: '0007' });
    expect(mock.calls.status).toHaveLength(0);
  });

  it('invalid checksum: failed as a setup problem, no retry', async () => {
    const { ctx, mock } = paytmCtx({ kind: 'INVALID_CHECKSUM' });
    const o = await readyOrder(ctx);
    const res = await startPay(ctx, o.id, o.total).expect(201);
    expect(res.body.payment).toMatchObject({ status: 'FAILED', failureReason: expect.stringMatching(/signature|setup/i) });
    expect(mock.calls.sale).toHaveLength(1);
  });

  it('another payment already running on the terminal (the service says so): failed, try again later', async () => {
    const { ctx } = paytmCtx({ kind: 'TERMINAL_BUSY' });
    const o = await readyOrder(ctx);
    const res = await startPay(ctx, o.id, o.total).expect(201);
    expect(res.body.payment).toMatchObject({ status: 'FAILED', failureReason: expect.stringMatching(/Another payment/) });
  });
});

describe('uncertain outcomes are never guessed', () => {
  it('Sale request times out but the terminal got it: found by status checks, paid exactly once', async () => {
    const { ctx, mock, paytm } = paytmCtx({ kind: 'SALE_TIMEOUT', thenCompletes: 'SUCCESS', afterPolls: 2 });
    const o = await readyOrder(ctx);
    const res = await startPay(ctx, o.id, o.total).expect(201);
    const pid = res.body.payment.id;
    expect(res.body.payment.status).toBe('PENDING'); // not "failed": we do not know
    expect(attemptOf(ctx, pid).state).toBe('SENDING');
    await ticks(paytm, 2);
    expect(paymentOf(ctx, pid).status).toBe('SUCCEEDED');
    expect(billOf(ctx, o.id).status).toBe('PAID');
    expect(mock.calls.sale).toHaveLength(1); // the Sale was NOT sent a second time
    expect(ctx.db.select().from(payments).where(eq(payments.orderId, o.id)).all()).toHaveLength(1);
  });

  it('Sale request times out and the terminal never got it: unknown (not failed) after the grace period', async () => {
    const { ctx, paytm, advance } = paytmCtx({ kind: 'SALE_TIMEOUT' });
    const o = await readyOrder(ctx);
    const pid = (await startPay(ctx, o.id, o.total).expect(201)).body.payment.id;
    await ticks(paytm, 2);
    expect(attemptOf(ctx, pid).state).toBe('SENDING'); // still waiting inside the grace period
    advance(61_000);
    await paytm.tick();
    expect(attemptOf(ctx, pid).state).toBe('UNKNOWN');
    expect(paymentOf(ctx, pid).status).toBe('UNKNOWN');
    expect(billOf(ctx, o.id).status).toBe('OPEN');
    expect(await orderPayState(ctx, o.id)).toBe('UNCERTAIN');
  });

  it('accepted but no final result ever: unknown after the waiting time; blocks new attempts; never marked paid', async () => {
    const { ctx, mock, paytm, advance } = paytmCtx({ kind: 'ACCEPTED_NO_RESULT' }, { maxWaitMs: 10 * 60_000 });
    const o = await readyOrder(ctx);
    const pid = (await startPay(ctx, o.id, o.total).expect(201)).body.payment.id;
    await ticks(paytm, 5);
    expect(paymentOf(ctx, pid).status).toBe('PENDING'); // acceptance alone never pays
    expect(billOf(ctx, o.id).status).toBe('OPEN');

    advance(11 * 60_000);
    await paytm.tick();
    expect(paymentOf(ctx, pid)).toMatchObject({ status: 'UNKNOWN', failureReason: expect.stringContaining('No final result') });
    expect(attemptOf(ctx, pid).state).toBe('UNKNOWN');
    expect(billOf(ctx, o.id).status).toBe('OPEN');

    // no second attempt, by terminal or by cash, until a person settles it
    expect((await startPay(ctx, o.id, o.total).expect(409)).body.error.code).toBe('PAYMENT_UNCERTAIN');
    const cash = await ctx.api.post(`/api/orders/${o.id}/payments`).send({ method: 'CASH', idempotencyKey: requestId(), expectedTotalPaise: o.total, tenderedPaise: o.total }).expect(409);
    expect(cash.body.error.code).toBe('PAYMENT_UNCERTAIN');
    expect(mock.calls.sale).toHaveLength(1);

    // the Superadmin checks the terminal and settles it
    await ctx.as('RECEPTION').post(`/api/payments/${pid}/resolve`).send({ outcome: 'FAILED', note: 'Checked terminal' }).expect(403);
    await ctx.api.post(`/api/payments/${pid}/resolve`).send({ outcome: 'FAILED', note: 'Checked the terminal: nothing there' }).expect(200);
    expect(paymentOf(ctx, pid).status).toBe('FAILED');
    expect(attemptOf(ctx, pid)).toMatchObject({ state: 'FAILED', reviewNote: expect.stringContaining('by hand') });
  });

  it('a late success after "unknown" is picked up by "Check now" and pays exactly once', async () => {
    const { ctx, mock, paytm, advance } = paytmCtx({ kind: 'ACCEPTED_NO_RESULT' });
    const o = await readyOrder(ctx);
    const pid = (await startPay(ctx, o.id, o.total).expect(201)).body.payment.id;
    advance(11 * 60_000);
    await paytm.tick();
    expect(attemptOf(ctx, pid).state).toBe('UNKNOWN');

    mock.finishOnDevice(attemptOf(ctx, pid).merchantTransactionId, 'SUCCESS'); // the customer finally paid
    const t = (await ctx.as('RECEPTION').post(`/api/payments/${pid}/terminal-check`).send({}).expect(200)).body.terminal;
    expect(t).toMatchObject({ state: 'SUCCEEDED', paymentStatus: 'SUCCEEDED' });
    expect(billOf(ctx, o.id).status).toBe('PAID');
    await ctx.api.post(`/api/payments/${pid}/terminal-check`).send({}).expect(200); // pressing it again changes nothing
    expect(ctx.db.select().from(payments).where(eq(payments.orderId, o.id)).all().filter((p) => p.status === 'SUCCEEDED')).toHaveLength(1);
  });

  it('duplicate transaction id (0233): not failed; the existing transaction is looked up, and paid once', async () => {
    const { ctx, mock, paytm } = paytmCtx({ kind: 'DUPLICATE_ID', existing: 'SUCCESS' });
    const o = await readyOrder(ctx);
    const res = await startPay(ctx, o.id, o.total).expect(201);
    const pid = res.body.payment.id;
    expect(res.body.payment.status).toBe('PENDING');
    expect(attemptOf(ctx, pid)).toMatchObject({ state: 'SENDING', lastResultCode: '0233' });
    await paytm.tick();
    expect(paymentOf(ctx, pid).status).toBe('SUCCEEDED');
    expect(billOf(ctx, o.id).status).toBe('PAID');
    expect(mock.calls.sale).toHaveLength(1);
  });

  it('duplicate transaction id (0233) with nothing behind it: unknown, handed to a person', async () => {
    const { ctx, paytm, advance } = paytmCtx({ kind: 'DUPLICATE_ID', existing: 'NOT_FOUND' });
    const o = await readyOrder(ctx);
    const pid = (await startPay(ctx, o.id, o.total).expect(201)).body.payment.id;
    advance(61_000);
    await paytm.tick();
    expect(attemptOf(ctx, pid).state).toBe('UNKNOWN');
    expect(billOf(ctx, o.id).status).toBe('OPEN');
  });

  it('status checks that error (0012) are simply retried', async () => {
    const { ctx, paytm } = paytmCtx({ kind: 'STATUS_ERRORS', errors: 3, then: { kind: 'SUCCESS', afterPolls: 0 } });
    const o = await readyOrder(ctx);
    const pid = (await startPay(ctx, o.id, o.total).expect(201)).body.payment.id;
    await ticks(paytm, 3);
    expect(paymentOf(ctx, pid).status).toBe('PENDING');
    expect(attemptOf(ctx, pid).statusErrorCount).toBe(3);
    await ticks(paytm, 2);
    expect(paymentOf(ctx, pid).status).toBe('SUCCEEDED');
  });

  it.each([
    ['amount', { kind: 'MISMATCH', field: 'amount', afterPolls: 1 }],
    ['merchant id', { kind: 'MISMATCH', field: 'mid', afterPolls: 1 }],
    ['terminal id', { kind: 'MISMATCH', field: 'tid', afterPolls: 1 }],
    ['transaction id', { kind: 'MISMATCH', field: 'transactionId', afterPolls: 1 }],
  ] as [string, MockScenario][])('a "success" with a different %s is NOT recorded as paid and is flagged for review', async (_n, scenario) => {
    const { ctx, paytm } = paytmCtx(scenario);
    const o = await readyOrder(ctx);
    const pid = (await startPay(ctx, o.id, o.total).expect(201)).body.payment.id;
    await paytm.tick();
    expect(paymentOf(ctx, pid).status).toBe('UNKNOWN');
    expect(attemptOf(ctx, pid)).toMatchObject({ state: 'UNKNOWN', needsReview: true, reviewNote: expect.stringContaining('NOT recorded as paid') });
    expect(billOf(ctx, o.id).status).toBe('OPEN');
    expect(await orderPayState(ctx, o.id)).toBe('UNCERTAIN');
    expect(ctx.db.select().from(paytmEvents).where(eq(paytmEvents.attemptId, attemptOf(ctx, pid).id)).all().map((e) => e.kind)).toContain('UNKNOWN');
  });
});

describe('exactly once', () => {
  it('a repeated successful status answer (and repeated "Check now") never records a second payment', async () => {
    const { ctx, paytm } = paytmCtx({ kind: 'SUCCESS', afterPolls: 1 });
    const o = await readyOrder(ctx);
    const pid = (await startPay(ctx, o.id, o.total).expect(201)).body.payment.id;
    await paytm.tick();
    const a = attemptOf(ctx, pid);
    expect(a.state).toBe('SUCCEEDED');
    const before = paymentOf(ctx, pid);
    for (let i = 0; i < 3; i++) {
      await paytm.pollOnce(a.id, { manual: true });
      await ctx.api.post(`/api/payments/${pid}/terminal-check`).send({}).expect(200);
      await paytm.tick();
    }
    expect(paymentOf(ctx, pid)).toEqual(before);
    expect(ctx.db.select().from(payments).where(eq(payments.orderId, o.id)).all()).toHaveLength(1);
    expect(eventKinds(ctx, a.id).filter((k) => k === 'SETTLED')).toHaveLength(1);
  });

  it('the same payment request id pressed many times at once sends ONE Sale and makes ONE payment', async () => {
    const { ctx, mock } = paytmCtx({ kind: 'ACCEPTED_NO_RESULT' });
    const o = await readyOrder(ctx);
    const key = requestId();
    const results = await Promise.all(Array.from({ length: 6 }, () => startPay(ctx, o.id, o.total, key)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.body.payment.id)).size).toBe(1);
    expect(mock.calls.sale).toHaveLength(1);
    expect(ctx.db.select().from(payments).where(eq(payments.orderId, o.id)).all()).toHaveLength(1);
    expect(ctx.db.select().from(paytmAttempts).all()).toHaveLength(1);
  });

  it('two different request ids for the same bill at once: one wins, the other is refused, one Sale', async () => {
    const { ctx, mock } = paytmCtx({ kind: 'ACCEPTED_NO_RESULT' });
    const o = await readyOrder(ctx);
    const results = await Promise.all([startPay(ctx, o.id, o.total), startPay(ctx, o.id, o.total)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(mock.calls.sale).toHaveLength(1);
    expect(ctx.db.select().from(payments).where(eq(payments.orderId, o.id)).all()).toHaveLength(1);
  });

  it('two different bills at once on ONE terminal: one wins, the other is refused before anything is sent', async () => {
    const { ctx, mock } = paytmCtx({ kind: 'ACCEPTED_NO_RESULT' });
    const a = await readyOrder(ctx);
    const b = await readyOrder(ctx, [['Butter Naan', 1]]);
    const results = await Promise.all([startPay(ctx, a.id, a.total), startPay(ctx, b.id, b.total)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const refused = results.find((r) => r.status === 409)!;
    expect(refused.body.error.code).toBe('TERMINAL_BUSY');
    expect(mock.calls.sale).toHaveLength(1);
    // the refused bill has no payment row left behind
    const loserOrder = refused === results[0] ? a.id : b.id;
    expect(ctx.db.select().from(payments).where(eq(payments.orderId, loserOrder)).all()).toHaveLength(0);
    expect(ctx.db.select().from(paytmAttempts).all()).toHaveLength(1);
  });

  it('once the first payment finishes, the terminal is free for the next bill', async () => {
    const { ctx, paytm } = paytmCtx({ kind: 'SUCCESS', afterPolls: 1 });
    const a = await readyOrder(ctx);
    const b = await readyOrder(ctx, [['Butter Naan', 1]]);
    const pa = (await startPay(ctx, a.id, a.total).expect(201)).body.payment.id;
    expect((await startPay(ctx, b.id, b.total).expect(409)).body.error.code).toBe('TERMINAL_BUSY');
    await paytm.tick();
    expect(paymentOf(ctx, pa).status).toBe('SUCCEEDED');
    await startPay(ctx, b.id, b.total).expect(201);
  });

  it('several checks of the same payment at the same moment settle it once', async () => {
    const { ctx, paytm } = paytmCtx({ kind: 'SUCCESS', afterPolls: 1 });
    const o = await readyOrder(ctx);
    const pid = (await startPay(ctx, o.id, o.total).expect(201)).body.payment.id;
    const a = attemptOf(ctx, pid);
    await Promise.all([paytm.pollOnce(a.id), paytm.pollOnce(a.id, { manual: true }), paytm.tick(), paytm.tick(), ctx.api.post(`/api/payments/${pid}/terminal-check`).send({})]);
    expect(paymentOf(ctx, pid).status).toBe('SUCCEEDED');
    expect(ctx.db.select().from(payments).where(eq(payments.orderId, o.id)).all().filter((p) => p.status === 'SUCCEEDED')).toHaveLength(1);
    expect(eventKinds(ctx, a.id).filter((k) => k === 'SETTLED')).toHaveLength(1);
  });
});

describe('restart recovery', () => {
  it('a payment waiting on the terminal when the server restarts is picked up and finished', async () => {
    const { ctx, mock, options, now } = paytmCtx({ kind: 'SUCCESS', afterPolls: 4 });
    const o = await readyOrder(ctx);
    const pid = (await startPay(ctx, o.id, o.total).expect(201)).body.payment.id;
    await ticks(ctx.paytm!, 2);
    expect(paymentOf(ctx, pid).status).toBe('PENDING');

    // "restart": a brand-new app on the same database file; the terminal itself (the mock) carries on regardless
    const second = createApp({ db: ctx.db, now, paytm: options });
    expect(second.paytm).toBeDefined();
    expect(second.paytm!.recover()).toEqual({ resumed: 1, failed: 0 });
    await ticks(second.paytm!, 3);
    expect(paymentOf(ctx, pid).status).toBe('SUCCEEDED');
    expect(billOf(ctx, o.id).status).toBe('PAID');
    expect(mock.calls.sale).toHaveLength(1); // recovery never re-sends the Sale
    expect(eventKinds(ctx, attemptOf(ctx, pid).id)).toContain('RECOVERY');
  });

  it('a payment that never reached the terminal (crash before the Sale) is failed safely, never sent', async () => {
    const { ctx, mock, options, now } = paytmCtx();
    const o = await readyOrder(ctx);
    const bill = billOf(ctx, o.id);
    const pay = ctx.db.insert(payments).values({ orderId: o.id, billId: bill.id, method: 'TERMINAL', status: 'PENDING', amountPaise: bill.totalPaise, idempotencyKey: requestId(), provider: 'PAYTM_MOCK' }).returning().get();
    const at = now();
    ctx.db.insert(paytmAttempts).values({ paymentId: pay.id, merchantTransactionId: 'MOCK99999999ABCDEF', provider: 'PAYTM_MOCK', mid: mock.mid, tid: mock.tid, amountPaise: bill.totalPaise, state: 'CREATED', deadlineAt: new Date(at.getTime() + 600_000) }).run();

    const second = createApp({ db: ctx.db, now, paytm: options });
    expect(second.paytm!.recover()).toEqual({ resumed: 0, failed: 1 });
    expect(paymentOf(ctx, pay.id)).toMatchObject({ status: 'FAILED', failureReason: expect.stringContaining('before it reached the terminal') });
    expect(mock.calls.sale).toHaveLength(0);
    expect(billOf(ctx, o.id).status).toBe('OPEN');
  });

  it('a payment sent but unanswered at the crash is resumed by status checks, not failed and not re-sent', async () => {
    const { ctx, mock, options, now, advance } = paytmCtx();
    const o = await readyOrder(ctx);
    const bill = billOf(ctx, o.id);
    const pay = ctx.db.insert(payments).values({ orderId: o.id, billId: bill.id, method: 'TERMINAL', status: 'PENDING', amountPaise: bill.totalPaise, idempotencyKey: requestId(), provider: 'PAYTM_MOCK' }).returning().get();
    const at = now();
    ctx.db.insert(paytmAttempts).values({ paymentId: pay.id, merchantTransactionId: 'MOCK99999999FEDCBA', provider: 'PAYTM_MOCK', mid: mock.mid, tid: mock.tid, amountPaise: bill.totalPaise, state: 'SENDING', saleSentAt: at, deadlineAt: new Date(at.getTime() + 600_000) }).run();

    const second = createApp({ db: ctx.db, now, paytm: options });
    expect(second.paytm!.recover()).toEqual({ resumed: 1, failed: 0 });
    await second.paytm!.tick();
    expect(paymentOf(ctx, pay.id).status).toBe('PENDING'); // the service has no record yet: wait, do not fail
    advance(61_000);
    await second.paytm!.tick();
    expect(paymentOf(ctx, pay.id).status).toBe('UNKNOWN'); // then a person decides
    expect(mock.calls.sale).toHaveLength(0);
  });

  it('start() recovers, then the background checker settles payments by itself; stop() ends it', async () => {
    const { ctx, paytm } = paytmCtx({ kind: 'SUCCESS', afterPolls: 1 }, { pollFastMs: 0, pollSlowMs: 0 });
    const o = await readyOrder(ctx);
    const pid = (await startPay(ctx, o.id, o.total).expect(201)).body.payment.id;
    paytm.start();
    paytm.start(); // calling it twice is harmless
    await new Promise((r) => setTimeout(r, 1300)); // the checker runs every second
    paytm.stop();
    expect(paymentOf(ctx, pid).status).toBe('SUCCEEDED');
  });
});

describe('table checkout', () => {
  async function tableWithTwoOrders(ctx: Ctx) {
    const table = (await ctx.api.post('/api/tables').send({ name: 'T7' })).body.table;
    const send = async (name: string) =>
      (await ctx.api.post('/api/orders').send({ clientRequestId: requestId(), orderType: 'DINE_IN', tableId: table.id, items: [{ menuItemId: itemId(ctx, name), quantity: 1 }] }).expect(201)).body.order as { id: number };
    const first = await send('Paneer Tikka');
    await ctx.as('KITCHEN').patch(`/api/orders/${first.id}/status`).send({ status: 'PREPARING' }).expect(200); // so the next dish becomes its own order
    const second = await send('Butter Naan');
    expect(second.id).not.toBe(first.id);
    const total = (await ctx.api.post(`/api/tables/${table.id}/bill`).send({}).expect(200)).body.bill.totalPaise as number;
    return { table, first, second, total };
  }

  it('one terminal payment settles every order on the table bill, once', async () => {
    const { ctx, mock, paytm } = paytmCtx({ kind: 'SUCCESS', afterPolls: 2 });
    const t = await tableWithTwoOrders(ctx);
    const key = requestId();
    const res = await ctx.api.post(`/api/tables/${t.table.id}/payments`).send({ method: 'TERMINAL', idempotencyKey: key, expectedTotalPaise: t.total }).expect(201);
    const pid = res.body.payment.id;
    expect(res.body.payment).toMatchObject({ status: 'PENDING', amountPaise: t.total, provider: 'PAYTM_MOCK' });
    expect(mock.calls.sale[0].amountPaise).toBe(t.total);

    // pressed again: the same payment, no second Sale
    const again = await ctx.api.post(`/api/tables/${t.table.id}/payments`).send({ method: 'TERMINAL', idempotencyKey: key, expectedTotalPaise: t.total }).expect(200);
    expect(again.body.payment.id).toBe(pid);
    expect(mock.calls.sale).toHaveLength(1);

    await ticks(paytm, 2);
    expect(paymentOf(ctx, pid).status).toBe('SUCCEEDED');
    expect(await orderPayState(ctx, t.first.id)).toBe('PAID');
    expect(await orderPayState(ctx, t.second.id)).toBe('PAID');
    expect(ctx.db.select().from(bills).all().every((b) => b.status === 'PAID')).toBe(true);
  });

  it('a different bill cannot reuse the same request id', async () => {
    const { ctx } = paytmCtx({ kind: 'ACCEPTED_NO_RESULT' });
    const t = await tableWithTwoOrders(ctx);
    const key = requestId();
    await ctx.api.post(`/api/tables/${t.table.id}/payments`).send({ method: 'TERMINAL', idempotencyKey: key, expectedTotalPaise: t.total }).expect(201);
    const other = await readyOrder(ctx, [['Butter Naan', 1]]);
    const res = await startPay(ctx, other.id, other.total, key).expect(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('is refused with a clear message when terminal payments are off (it used to be a server error)', async () => {
    const ctx = setupTestApp();
    const table = (await ctx.api.post('/api/tables').send({ name: 'T1' })).body.table;
    await ctx.api.post('/api/orders').send({ clientRequestId: requestId(), orderType: 'DINE_IN', tableId: table.id, items: [{ menuItemId: ctx.db.select().from(menuItems).where(eq(menuItems.name, 'Paneer Tikka')).get()!.id, quantity: 1 }] }).expect(201);
    const total = (await ctx.api.post(`/api/tables/${table.id}/bill`).send({}).expect(200)).body.bill.totalPaise;
    const res = await ctx.api.post(`/api/tables/${table.id}/payments`).send({ method: 'TERMINAL', idempotencyKey: requestId(), expectedTotalPaise: total }).expect(400);
    expect(res.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');
  });
});

describe('same-day void (practice terminal only)', () => {
  async function paidByTerminal(p: ReturnType<typeof paytmCtx>) {
    const o = await readyOrder(p.ctx);
    const pid = (await startPay(p.ctx, o.id, o.total).expect(201)).body.payment.id as number;
    await ticks(p.paytm, 2);
    expect(paymentOf(p.ctx, pid).status).toBe('SUCCEEDED');
    return { o, pid };
  }

  it('the Superadmin can void a terminal payment taken today; the bill is reopened as refunded and the sale is netted out', async () => {
    const p = paytmCtx({ kind: 'SUCCESS', afterPolls: 1 });
    const { o, pid } = await paidByTerminal(p);
    await p.ctx.as('RECEPTION').post(`/api/payments/${pid}/terminal-void`).send({}).expect(403);
    const res = await p.ctx.api.post(`/api/payments/${pid}/terminal-void`).send({}).expect(200);
    expect(res.body.terminal).toMatchObject({ voidState: 'VOIDED', state: 'SUCCEEDED' });
    expect(paymentOf(p.ctx, pid)).toMatchObject({ status: 'REFUNDED', refundReason: expect.stringContaining('Voided') });
    expect(billOf(p.ctx, o.id).status).toBe('REFUNDED');
    expect(await orderPayState(p.ctx, o.id)).toBe('REFUNDED');
    expect(p.mock.calls.void).toHaveLength(1);
    // a second void is refused: the payment is no longer a successful one
    expect((await p.ctx.api.post(`/api/payments/${pid}/terminal-void`).send({}).expect(409)).body.error.code).toBe('NOT_VOIDABLE');
  });

  it('a void is refused the next day, and for payments that did not succeed', async () => {
    const p = paytmCtx({ kind: 'SUCCESS', afterPolls: 1 });
    const { pid } = await paidByTerminal(p);
    p.advance(24 * 3600_000);
    expect((await p.ctx.api.post(`/api/payments/${pid}/terminal-void`).send({}).expect(409)).body.error.code).toBe('VOID_TOO_LATE');
    expect(p.mock.calls.void).toHaveLength(0);

    const q = paytmCtx({ kind: 'CUSTOMER_CANCEL', afterPolls: 1 });
    const o = await readyOrder(q.ctx);
    const failed = (await startPay(q.ctx, o.id, o.total).expect(201)).body.payment.id;
    await q.paytm.tick();
    expect((await q.ctx.api.post(`/api/payments/${failed}/terminal-void`).send({}).expect(409)).body.error.code).toBe('NOT_VOIDABLE');
  });

  it('terminal refunds stay OFF: the existing refund route still refuses a terminal payment', async () => {
    const p = paytmCtx({ kind: 'SUCCESS', afterPolls: 1 });
    const { pid } = await paidByTerminal(p);
    const res = await p.ctx.api.post(`/api/payments/${pid}/refund`).send({ reason: 'Customer changed mind', confirmed: true }).expect(409);
    expect(res.body.error.code).toBe('NOT_REFUNDABLE');
    expect(paymentOf(p.ctx, pid).status).toBe('SUCCEEDED');
  });

  it('the void goes unconfirmed is shown as unknown, and "Check now" finishes it', async () => {
    const p = paytmCtx({ kind: 'SUCCESS', afterPolls: 1 });
    const { o, pid } = await paidByTerminal(p);
    // simulate a void whose confirmation was lost: requested, state unknown
    p.ctx.db.update(paytmAttempts).set({ voidState: 'UNKNOWN', voidMessage: 'not confirmed' }).where(eq(paytmAttempts.paymentId, pid)).run();
    // the terminal really did void it
    await p.mock.void({ merchantTransactionId: attemptOf(p.ctx, pid).merchantTransactionId, transactionDateTime: '2026-01-01 00:00:00' });
    const t = (await p.ctx.api.post(`/api/payments/${pid}/terminal-check`).send({}).expect(200)).body.terminal;
    expect(t.voidState).toBe('VOIDED');
    expect(paymentOf(p.ctx, pid).status).toBe('REFUNDED');
    expect(billOf(p.ctx, o.id).status).toBe('REFUNDED');
  });
});

describe('settling by hand stays consistent', () => {
  it('a Superadmin marking an unsure terminal payment as received pays the bill and closes the attempt', async () => {
    const { ctx, paytm, advance } = paytmCtx({ kind: 'ACCEPTED_NO_RESULT' });
    const o = await readyOrder(ctx);
    const pid = (await startPay(ctx, o.id, o.total).expect(201)).body.payment.id;
    advance(11 * 60_000);
    await paytm.tick();
    await ctx.api.post(`/api/payments/${pid}/resolve`).send({ outcome: 'SUCCEEDED', note: 'Saw it in the Paytm app', providerReference: 'BANK-1' }).expect(200);
    expect(billOf(ctx, o.id).status).toBe('PAID');
    expect(attemptOf(ctx, pid)).toMatchObject({ state: 'SUCCEEDED', reviewNote: expect.stringContaining('by hand') });
    await paytm.tick(); // the checker does not touch it again
    expect(ctx.db.select().from(payments).where(eq(payments.orderId, o.id)).all()).toHaveLength(1);
  });

  it('money that arrives after a person marked the payment failed is flagged, never double-recorded', async () => {
    const { ctx, mock, paytm, advance } = paytmCtx({ kind: 'ACCEPTED_NO_RESULT' });
    const o = await readyOrder(ctx);
    const pid = (await startPay(ctx, o.id, o.total).expect(201)).body.payment.id;
    advance(11 * 60_000);
    await paytm.tick();
    await ctx.api.post(`/api/payments/${pid}/resolve`).send({ outcome: 'FAILED', note: 'Terminal showed nothing' }).expect(200);
    mock.finishOnDevice(attemptOf(ctx, pid).merchantTransactionId, 'SUCCESS');
    await ctx.api.post(`/api/payments/${pid}/terminal-check`).send({}).expect(200);
    expect(paymentOf(ctx, pid).status).toBe('FAILED'); // unchanged: no automatic reversal of a person's decision
    expect(billOf(ctx, o.id).status).toBe('OPEN');
  });
});

describe('everything else is unchanged while the terminal is on', () => {
  it('cash, manual UPI and credit still work, and cash is blocked only while a terminal payment is open', async () => {
    const { ctx, paytm } = paytmCtx({ kind: 'ACCEPTED_NO_RESULT' });
    const a = await readyOrder(ctx);
    await ctx.api.post(`/api/orders/${a.id}/payments`).send({ method: 'CASH', idempotencyKey: requestId(), expectedTotalPaise: a.total, tenderedPaise: a.total + 1000 }).expect(201);
    expect(billOf(ctx, a.id).status).toBe('PAID');

    const b = await readyOrder(ctx, [['Butter Naan', 1]]);
    await ctx.api.post(`/api/orders/${b.id}/payments`).send({ method: 'UPI_MANUAL', idempotencyKey: requestId(), expectedTotalPaise: b.total, outcome: 'SUCCEEDED', manuallyVerified: true }).expect(201);

    const c = await readyOrder(ctx, [['Butter Naan', 2]]);
    await ctx.api.post(`/api/orders/${c.id}/payments`).send({ method: 'CREDIT', idempotencyKey: requestId(), expectedTotalPaise: c.total, customerName: 'Asha', customerPhone: '9876543210' }).expect(201);

    // a terminal payment in progress on another bill does not stop cash on this one
    const d = await readyOrder(ctx, [['Paneer Tikka', 2]]);
    await startPay(ctx, d.id, d.total).expect(201);
    const e = await readyOrder(ctx, [['Butter Naan', 3]]);
    await ctx.api.post(`/api/orders/${e.id}/payments`).send({ method: 'CASH', idempotencyKey: requestId(), expectedTotalPaise: e.total, tenderedPaise: e.total }).expect(201);
    // ...but cash on the SAME bill is blocked until the terminal payment is settled
    await ctx.api.post(`/api/orders/${d.id}/payments`).send({ method: 'CASH', idempotencyKey: requestId(), expectedTotalPaise: d.total, tenderedPaise: d.total }).expect(409);
    expect(paytm.enabled).toBe(true);
  });
});

describe('the practice terminal picker (Superadmin, practice mode only)', () => {
  it('changes what the next payments do, and is closed to everyone else', async () => {
    const { ctx } = paytmCtx({ kind: 'SUCCESS', afterPolls: 1 });
    await ctx.as('RECEPTION').put('/api/settings/payments/mock-scenario').send({ scenario: 'TERMINAL_OFFLINE' }).expect(403);
    await ctx.anon.put('/api/settings/payments/mock-scenario').send({ scenario: 'TERMINAL_OFFLINE' }).expect(401);
    await ctx.api.put('/api/settings/payments/mock-scenario').send({ scenario: 'NOT_A_THING' }).expect(400);
    await ctx.api.put('/api/settings/payments/mock-scenario').send({ scenario: 'TERMINAL_OFFLINE' }).expect(200);
    const o = await readyOrder(ctx);
    const res = await startPay(ctx, o.id, o.total).expect(201);
    expect(res.body.payment.status).toBe('FAILED');
  });

  it('does not exist when the terminal is off', async () => {
    const ctx = setupTestApp();
    const res = await ctx.api.put('/api/settings/payments/mock-scenario').send({ scenario: 'SUCCESS' }).expect(409);
    expect(res.body.error.code).toBe('NOT_MOCK');
  });
});

describe('the audit log and secrets', () => {
  it('records every exchange without any signature or key, and the order screens show none of it', async () => {
    const { ctx, paytm } = paytmCtx({ kind: 'SUCCESS', afterPolls: 1 });
    const o = await readyOrder(ctx);
    const res = await startPay(ctx, o.id, o.total).expect(201);
    await paytm.tick();
    const rows = ctx.db.select().from(paytmEvents).all();
    expect(rows.map((r) => r.kind)).toEqual(expect.arrayContaining(['SALE', 'STATUS', 'SETTLED']));
    expect(JSON.stringify(rows)).not.toMatch(/checksum|merchantKey|MERCHANT_KEY|secret/i);
    expect(JSON.stringify(res.body)).not.toMatch(/checksum|merchantKey|MERCHANT_KEY|secret/i);
    expect(JSON.stringify((await ctx.api.get(`/api/orders/${o.id}/checkout`).expect(200)).body)).not.toMatch(/paytm_attempts|paytm_events|checksum|merchantKey/i);
  });

  it('keeps the new tables and constraints in place (migration 0014)', async () => {
    const { ctx } = paytmCtx();
    const idx = (ctx.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'paytm%'").all() as { name: string }[]).map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(['paytm_attempts_payment_unique', 'paytm_attempts_txn_unique', 'paytm_one_open_per_terminal', 'paytm_attempts_poll_idx', 'paytm_events_attempt_idx']));
    const o = await readyOrder(ctx);
    await startPay(ctx, o.id, o.total).expect(201);
    expect(() => ctx.sqlite.prepare("UPDATE paytm_attempts SET state = 'BOGUS'").run()).toThrow(/CHECK/);
    expect(() => ctx.sqlite.prepare('UPDATE paytm_attempts SET amount_paise = 0').run()).toThrow(/CHECK/);
    // the existing payment tables are untouched
    const cols = (ctx.sqlite.prepare('PRAGMA table_info(payments)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['order_id', 'bill_id', 'method', 'status', 'amount_paise', 'idempotency_key', 'provider', 'provider_reference']));
    expect(ctx.db.select().from(orders).all().length).toBeGreaterThan(0);
  });
});
