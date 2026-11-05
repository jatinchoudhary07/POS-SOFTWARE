import request from 'supertest';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { bills, menuItems, payments } from '../src/db/schema';
import type { PaymentProvider, ProviderOutcome } from '../src/payments/provider';
import { requestId, setupTestApp } from './helpers';

type Ctx = ReturnType<typeof setupTestApp>;

const itemId = (ctx: Ctx, name: string) => ctx.db.select().from(menuItems).where(eq(menuItems.name, name)).get()!.id;

/** Paneer Tikka ₹240 × 2 + Butter Naan ₹50 × 3 = ₹630.00 */
async function createOrder(ctx: Ctx, lines: [string, number][] = [['Paneer Tikka', 2], ['Butter Naan', 3]]) {
  const res = await ctx.api
    .post('/api/orders')
    .send({
      clientRequestId: requestId(),
      orderType: 'DINE_IN',
      tableNumber: '4',
      items: lines.map(([n, q]) => ({ menuItemId: itemId(ctx, n), quantity: q })),
    })
    .expect(201);
  return res.body.order as { id: number; orderNumber: string; subtotalPaise: number };
}

const setSettings = (ctx: Ctx, body: Record<string, unknown>) =>
  ctx.api
    .put('/api/settings')
    
    .send({ restaurantName: 'Test Dhaba', roundToRupee: false, taxes: [], ...body });

const bill = (ctx: Ctx, id: number, body: object = {}) => ctx.api.post(`/api/orders/${id}/bill`).send(body);
const pay = (ctx: Ctx, id: number, body: Record<string, unknown>) =>
  ctx.api.post(`/api/orders/${id}/payments`).send({ idempotencyKey: requestId(), ...body });
const cash = (ctx: Ctx, id: number, expectedTotalPaise: number, tenderedPaise: number, key = requestId()) =>
  pay(ctx, id, { method: 'CASH', expectedTotalPaise, tenderedPaise, idempotencyKey: key });
const paymentRows = (ctx: Ctx, orderId: number) => ctx.db.select().from(payments).where(eq(payments.orderId, orderId)).all();

describe('settings', () => {
  it('are public to read, admin-only to change, and validated', async () => {
    const ctx = setupTestApp();
    const res = await ctx.api.get('/api/settings').expect(200);
    expect(res.body.settings).toMatchObject({ restaurantName: 'My Restaurant', taxes: [], configured: false });

    await ctx.anon.put('/api/settings').send({ restaurantName: 'X', roundToRupee: false, taxes: [] }).expect(401);
    await ctx.as('RECEPTION').put('/api/settings').send({ restaurantName: 'X', roundToRupee: false, taxes: [] }).expect(403);
    await setSettings(ctx, { taxes: [{ name: 'GST', rateBps: 2.5 }] }).expect(400); // must be whole bps
    await setSettings(ctx, { taxes: [{ name: 'GST', rateBps: 10001 }] }).expect(400);
    await setSettings(ctx, { totalOverride: 1 }).expect(400); // unknown fields rejected
    const dup = await setSettings(ctx, { taxes: [{ name: 'CGST', rateBps: 250 }, { name: 'cgst', rateBps: 250 }] }).expect(400);
    expect(dup.body.error.message).toMatch(/different name/);

    const saved = await setSettings(ctx, { phone: '98765 43210', taxes: [{ name: 'CGST', rateBps: 250 }, { name: 'SGST', rateBps: 250 }] }).expect(200);
    expect(saved.body.settings).toMatchObject({ restaurantName: 'Test Dhaba', phone: '98765 43210', configured: true });
    expect(saved.body.settings.taxes).toEqual([{ name: 'CGST', rateBps: 250 }, { name: 'SGST', rateBps: 250 }]);
  });

});

describe('bill calculation (server side)', () => {
  it('uses the stored order subtotal, current taxes and a validated discount', async () => {
    const ctx = setupTestApp();
    await setSettings(ctx, { taxes: [{ name: 'CGST', rateBps: 250 }, { name: 'SGST', rateBps: 250 }] }).expect(200);
    const order = await createOrder(ctx);

    const plain = (await bill(ctx, order.id).expect(200)).body.bill;
    expect(plain).toMatchObject({ subtotalPaise: 63000, taxablePaise: 63000, taxPaise: 3150, totalPaise: 66150, status: 'OPEN' });
    expect(plain.taxLines).toEqual([
      { name: 'CGST', rateBps: 250, amountPaise: 1575 },
      { name: 'SGST', rateBps: 250, amountPaise: 1575 },
    ]);

    const discounted = (await bill(ctx, order.id, { discount: { type: 'PERCENT', bps: 1000, reason: 'Regular customer' } }).expect(200)).body.bill;
    expect(discounted.discount).toEqual({ type: 'PERCENT', value: 1000, reason: 'Regular customer', paise: 6300 });
    expect(discounted.totalPaise).toBe(56700 + 1418 + 1418); // 56700 × 2.5% = 1417.5 -> 1418
  });

  it('rejects client attempts to set totals or prices, and bad discounts', async () => {
    const ctx = setupTestApp();
    const order = await createOrder(ctx);
    await bill(ctx, order.id, { totalPaise: 1 }).expect(400);
    await bill(ctx, order.id, { discount: { type: 'AMOUNT', paise: 63000, reason: 'free' } }).expect(400); // = subtotal
    await bill(ctx, order.id, { discount: { type: 'PERCENT', bps: 1000 } }).expect(400); // no reason
    await bill(ctx, order.id, { discount: { type: 'AMOUNT', paise: 10.5, reason: 'x y z' } }).expect(400);
    await bill(ctx, 99999).expect(404);
    expect(ctx.db.select().from(bills).all()).toHaveLength(0);
  });

  it('applies the round-to-rupee setting', async () => {
    const ctx = setupTestApp();
    await setSettings(ctx, { roundToRupee: true, taxes: [{ name: 'GST', rateBps: 500 }] }).expect(200);
    const order = await createOrder(ctx, [['Masala Chai', 1]]); // ₹40.00 + 5% = ₹42.00
    const b = (await bill(ctx, order.id).expect(200)).body.bill;
    expect(b).toMatchObject({ taxPaise: 200, roundOffPaise: 0, totalPaise: 4200 });
    await bill(ctx, order.id, { discount: { type: 'AMOUNT', paise: 1, reason: 'test round' } }).expect(200);
    const b2 = (await ctx.api.get(`/api/orders/${order.id}/checkout`)).body.bill;
    // 3999 + 200 (199.95 -> 200) = 4199 -> rounds to 4200 (+1)
    expect(b2).toMatchObject({ taxablePaise: 3999, taxPaise: 200, roundOffPaise: 1, totalPaise: 4200 });
  });
});

describe('cash payments', () => {
  it('records payment, change due, closes the bill and keeps kitchen status unchanged', async () => {
    const ctx = setupTestApp();
    const order = await createOrder(ctx);
    await bill(ctx, order.id).expect(200);
    const res = await cash(ctx, order.id, 63000, 70000).expect(201);
    expect(res.body.payment).toMatchObject({ method: 'CASH', status: 'SUCCEEDED', amountPaise: 63000, tenderedPaise: 70000, changePaise: 7000 });
    expect(res.body.payment.reference).toMatch(/^PAY-\d{6}$/);
    expect(res.body.checkout.order).toMatchObject({ paymentStatus: 'PAID', paymentMethod: 'CASH', status: 'NEW', billTotalPaise: 63000 });
    expect(res.body.checkout.bill.status).toBe('PAID');

    // Kitchen workflow continues independently of payment.
    const kitchen = await ctx.api.patch(`/api/orders/${order.id}/status`).send({ status: 'PREPARING' }).expect(200);
    expect(kitchen.body.order).toMatchObject({ status: 'PREPARING', paymentStatus: 'PAID' });
  });

  it('accepts the exact amount (zero change)', async () => {
    const ctx = setupTestApp();
    const order = await createOrder(ctx);
    await bill(ctx, order.id);
    const res = await cash(ctx, order.id, 63000, 63000).expect(201);
    expect(res.body.payment.changePaise).toBe(0);
  });

  it('rejects an underpayment and records nothing', async () => {
    const ctx = setupTestApp();
    const order = await createOrder(ctx);
    await bill(ctx, order.id);
    const res = await cash(ctx, order.id, 63000, 62999).expect(400);
    expect(res.body.error.code).toBe('UNDERPAYMENT');
    expect(res.body.error.message).toContain('₹629.99');
    expect(paymentRows(ctx, order.id)).toHaveLength(0);
    expect((await ctx.api.get(`/api/orders/${order.id}`)).body.order.paymentStatus).toBe('UNPAID');
  });

  it('treats a repeated submission (same idempotency key) as the same payment', async () => {
    const ctx = setupTestApp();
    const order = await createOrder(ctx);
    await bill(ctx, order.id);
    const key = requestId();
    const first = await cash(ctx, order.id, 63000, 100000, key).expect(201);
    const again = await cash(ctx, order.id, 63000, 100000, key).expect(200);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.payment.id).toBe(first.body.payment.id);
    expect(paymentRows(ctx, order.id)).toHaveLength(1);
  });

  it('refuses a second payment for an already-paid order', async () => {
    const ctx = setupTestApp();
    const order = await createOrder(ctx);
    await bill(ctx, order.id);
    await cash(ctx, order.id, 63000, 63000).expect(201);
    const second = await pay(ctx, order.id, { method: 'UPI_MANUAL', outcome: 'SUCCEEDED', manuallyVerified: true, expectedTotalPaise: 63000 }).expect(409);
    expect(second.body.error.code).toBe('ALREADY_PAID');
    expect(paymentRows(ctx, order.id)).toHaveLength(1);
    // ...and its bill can no longer be changed.
    await bill(ctx, order.id, { discount: { type: 'PERCENT', bps: 5000, reason: 'after the fact' } }).expect(409);
  });

  it('refuses payment without a bill, or if the bill changed since it was shown', async () => {
    const ctx = setupTestApp();
    const order = await createOrder(ctx);
    expect((await cash(ctx, order.id, 63000, 63000).expect(409)).body.error.code).toBe('BILL_REQUIRED');
    await bill(ctx, order.id);
    await bill(ctx, order.id, { discount: { type: 'AMOUNT', paise: 3000, reason: 'Late food' } });
    const res = await cash(ctx, order.id, 63000, 63000).expect(409);
    expect(res.body.error).toMatchObject({ code: 'BILL_CHANGED', details: { totalPaise: 60000 } });
    await cash(ctx, order.id, 60000, 60000).expect(201);
  });

  it('validates the request body strictly', async () => {
    const ctx = setupTestApp();
    const order = await createOrder(ctx);
    await bill(ctx, order.id);
    await pay(ctx, order.id, { method: 'CASH', expectedTotalPaise: 63000 }).expect(400); // no tendered
    await pay(ctx, order.id, { method: 'CASH', expectedTotalPaise: 63000, tenderedPaise: 630.5 }).expect(400);
    await pay(ctx, order.id, { method: 'CASH', expectedTotalPaise: 63000, tenderedPaise: 63000, amountPaise: 1 }).expect(400);
    await pay(ctx, order.id, { method: 'CARD', expectedTotalPaise: 63000 }).expect(400);
    await ctx.api.post(`/api/orders/${order.id}/payments`).send({ method: 'CASH', expectedTotalPaise: 63000, tenderedPaise: 63000 }).expect(400); // no key
    expect(paymentRows(ctx, order.id)).toHaveLength(0);
  });
});

describe('manual UPI', () => {
  it('requires explicit manual verification and stores the UPI reference', async () => {
    const ctx = setupTestApp();
    const order = await createOrder(ctx);
    await bill(ctx, order.id);
    const unverified = await pay(ctx, order.id, { method: 'UPI_MANUAL', outcome: 'SUCCEEDED', expectedTotalPaise: 63000 }).expect(400);
    expect(unverified.body.error.message).toMatch(/Confirm that you checked/);
    const res = await pay(ctx, order.id, {
      method: 'UPI_MANUAL',
      outcome: 'SUCCEEDED',
      manuallyVerified: true,
      providerReference: '412345678901',
      expectedTotalPaise: 63000,
    }).expect(201);
    expect(res.body.payment).toMatchObject({
      method: 'UPI_MANUAL',
      status: 'SUCCEEDED',
      provider: 'MANUAL',
      providerReference: '412345678901',
      tenderedPaise: null,
      changePaise: null,
    });
    expect(res.body.payment.note).toMatch(/Manually verified/);
  });

  it('records a failed attempt (not revenue) and still allows paying afterwards', async () => {
    const ctx = setupTestApp();
    const order = await createOrder(ctx);
    await bill(ctx, order.id);
    await pay(ctx, order.id, { method: 'UPI_MANUAL', outcome: 'FAILED', expectedTotalPaise: 63000 }).expect(400); // reason needed
    const failed = await pay(ctx, order.id, { method: 'UPI_MANUAL', outcome: 'FAILED', failureReason: 'Customer bank declined', expectedTotalPaise: 63000 }).expect(201);
    expect(failed.body.payment.status).toBe('FAILED');
    expect(failed.body.checkout.order.paymentStatus).toBe('FAILED');
    expect(failed.body.checkout.bill.status).toBe('OPEN');
    await cash(ctx, order.id, 63000, 63000).expect(201);
    expect(paymentRows(ctx, order.id).map((p) => p.status)).toEqual(['FAILED', 'SUCCEEDED']);
  });
});

describe('integrity', () => {
  it('rolls back the whole payment if any write in the transaction fails', async () => {
    const ctx = setupTestApp();
    const order = await createOrder(ctx);
    await bill(ctx, order.id);
    const seen: string[] = [];
    ctx.events.on('order.updated', (o) => seen.push(o.paymentStatus));
    // Make the "close the bill" step fail after the payment row was inserted.
    ctx.sqlite.exec(`CREATE TRIGGER fail_bill BEFORE UPDATE ON bills BEGIN SELECT RAISE(ABORT, 'simulated disk error'); END;`);
    const res = await cash(ctx, order.id, 63000, 63000).expect(500);
    expect(res.body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Something went wrong on the server' });
    expect(paymentRows(ctx, order.id)).toHaveLength(0); // the inserted payment was rolled back
    expect(ctx.db.select().from(bills).get()?.status).toBe('OPEN');
    expect(seen).toEqual([]); // nothing broadcast for a failed transaction
    ctx.sqlite.exec('DROP TRIGGER fail_bill');
    await cash(ctx, order.id, 63000, 63000).expect(201);
  });

  it('the database itself refuses a second successful payment for one order', async () => {
    const ctx = setupTestApp();
    const order = await createOrder(ctx);
    const { body } = await bill(ctx, order.id);
    await cash(ctx, order.id, 63000, 63000).expect(201);
    expect(() =>
      ctx.db
        .insert(payments)
        .values({ orderId: order.id, billId: body.bill.id, method: 'CASH', status: 'SUCCEEDED', amountPaise: 63000, idempotencyKey: 'direct-insert-1', provider: 'MANUAL' })
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('broadcasts exactly one order.updated per payment, after commit, with the payment status', async () => {
    const ctx = setupTestApp();
    const order = await createOrder(ctx);
    await bill(ctx, order.id);
    const seen: { paymentStatus: string; updatedAt: string }[] = [];
    ctx.events.on('order.updated', (o) => seen.push({ paymentStatus: o.paymentStatus, updatedAt: o.updatedAt }));
    await bill(ctx, order.id); // identical bill again: no change, no event
    await cash(ctx, order.id, 63000, 1).expect(400); // underpayment: no event
    const key = requestId();
    await cash(ctx, order.id, 63000, 63000, key).expect(201);
    await cash(ctx, order.id, 63000, 63000, key).expect(200); // duplicate: no event
    expect(seen.map((s) => s.paymentStatus)).toEqual(['PAID']);
  });

  it('keeps the bill and receipt unchanged after menu prices and tax settings change', async () => {
    const ctx = setupTestApp();
    await setSettings(ctx, { taxes: [{ name: 'GST', rateBps: 500 }] });
    const order = await createOrder(ctx);
    await bill(ctx, order.id);
    await cash(ctx, order.id, 66150, 70000).expect(201);
    const before = (await ctx.api.get(`/api/orders/${order.id}/receipt`)).body;

    await ctx.api.patch(`/api/menu/items/${itemId(ctx, 'Paneer Tikka')}`).send({ pricePaise: 99900 }).expect(200);
    await setSettings(ctx, { taxes: [{ name: 'GST', rateBps: 1800 }] });

    const after = (await ctx.api.get(`/api/orders/${order.id}/receipt`)).body;
    expect(after.bill).toEqual(before.bill);
    expect(after.order.items).toEqual(before.order.items);
    expect(after.bill).toMatchObject({ totalPaise: 66150, taxLines: [{ name: 'GST', rateBps: 500, amountPaise: 3150 }] });
  });
});

describe('receipt', () => {
  it('contains exactly what was billed and paid', async () => {
    const ctx = setupTestApp();
    await setSettings(ctx, { addressLine: '12 MG Road', phone: '080-1234', receiptFooter: 'Thank you!', taxes: [{ name: 'CGST', rateBps: 250 }, { name: 'SGST', rateBps: 250 }] });
    const order = await createOrder(ctx);
    await ctx.api.get(`/api/orders/${order.id}/receipt`).expect(409); // no bill yet
    await bill(ctx, order.id, { discount: { type: 'AMOUNT', paise: 3000, reason: 'Birthday' } });
    const unpaid = (await ctx.api.get(`/api/orders/${order.id}/receipt`).expect(200)).body;
    expect(unpaid.paymentStatus).toBe('UNPAID');
    expect(unpaid.payment).toBeNull();

    const paid = await cash(ctx, order.id, 63000, 70000).expect(201);
    const r = (await ctx.api.get(`/api/orders/${order.id}/receipt`).expect(200)).body;
    expect(r.restaurant).toEqual({ restaurantName: 'Test Dhaba', addressLine: '12 MG Road', phone: '080-1234', taxId: null, receiptFooter: 'Thank you!' });
    expect(r.order).toMatchObject({ orderNumber: order.orderNumber, orderType: 'DINE_IN', tableNumber: '4' });
    expect(r.order.items.map((i: { itemName: string; quantity: number; unitPricePaise: number; lineTotalPaise: number }) => [i.itemName, i.quantity, i.unitPricePaise, i.lineTotalPaise])).toEqual([
      ['Paneer Tikka', 2, 24000, 48000],
      ['Butter Naan', 3, 5000, 15000],
    ]);
    expect(r.bill).toMatchObject({ subtotalPaise: 63000, discount: { paise: 3000, reason: 'Birthday' }, taxablePaise: 60000, taxPaise: 3000, totalPaise: 63000 });
    expect(r.paymentStatus).toBe('PAID');
    expect(r.payment).toMatchObject({ reference: paid.body.payment.reference, method: 'CASH', tenderedPaise: 70000, changePaise: 7000 });
    // Internal consistency: the lines add up to the subtotal, and the bill parts add up to the total.
    const lineSum = r.order.items.reduce((s: number, i: { lineTotalPaise: number }) => s + i.lineTotalPaise, 0);
    expect(lineSum).toBe(r.bill.subtotalPaise);
    expect(r.bill.taxablePaise + r.bill.taxPaise + r.bill.roundOffPaise).toBe(r.bill.totalPaise);
  });
});

describe('refunds (Superadmin)', () => {
  it('records a full refund once, closes the order for payment, and is Superadmin-only', async () => {
    const ctx = setupTestApp();
    const order = await createOrder(ctx);
    await bill(ctx, order.id);
    const { body } = await cash(ctx, order.id, 63000, 63000).expect(201);
    const pid = body.payment.id;

    await ctx.as('RECEPTION').post(`/api/payments/${pid}/refund`).send({ reason: 'Wrong order', confirmed: true }).expect(403);
    await ctx.api.post(`/api/payments/${pid}/refund`).send({ reason: 'Wrong order' }).expect(400); // not confirmed
    const r = await ctx.api.post(`/api/payments/${pid}/refund`).send({ reason: 'Wrong order', confirmed: true }).expect(200);
    expect(r.body).toMatchObject({ changed: true, payment: { status: 'REFUNDED', refundReason: 'Wrong order' } });
    expect(r.body.checkout.order.paymentStatus).toBe('REFUNDED');
    expect(r.body.checkout.bill.status).toBe('REFUNDED');

    const again = await ctx.api.post(`/api/payments/${pid}/refund`).send({ reason: 'Wrong order', confirmed: true }).expect(200);
    expect(again.body.changed).toBe(false);
    expect((await cash(ctx, order.id, 63000, 63000).expect(409)).body.error.code).toBe('ALREADY_REFUNDED');
  });

  it('refuses to refund a payment that did not succeed', async () => {
    const ctx = setupTestApp();
    const order = await createOrder(ctx);
    await bill(ctx, order.id);
    const { body } = await pay(ctx, order.id, { method: 'UPI_MANUAL', outcome: 'FAILED', failureReason: 'Timed out', expectedTotalPaise: 63000 });
    const res = await ctx.api.post(`/api/payments/${body.payment.id}/refund`).send({ reason: 'oops', confirmed: true }).expect(409);
    expect(res.body.error.code).toBe('NOT_REFUNDABLE');
  });
});

describe('payment providers (future terminal) — tested with a test double only', () => {
  it('is not available until a real provider is configured', async () => {
    const ctx = setupTestApp();
    const order = await createOrder(ctx);
    await bill(ctx, order.id);
    const res = await pay(ctx, order.id, { method: 'TERMINAL', expectedTotalPaise: 63000 }).expect(400);
    expect(res.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(paymentRows(ctx, order.id)).toHaveLength(0);
  });

  const fakeProvider = (impl: () => Promise<ProviderOutcome>): PaymentProvider => ({ id: 'TEST_TERMINAL', methods: ['TERMINAL'], collect: impl });

  it('records the provider outcome: success', async () => {
    const ctx = setupTestApp({ paymentProviders: [fakeProvider(async () => ({ outcome: 'SUCCEEDED', reference: 'T-1' }))] });
    const order = await createOrder(ctx);
    await bill(ctx, order.id);
    const res = await pay(ctx, order.id, { method: 'TERMINAL', expectedTotalPaise: 63000 }).expect(201);
    expect(res.body.payment).toMatchObject({ status: 'SUCCEEDED', provider: 'TEST_TERMINAL', providerReference: 'T-1' });
    expect(res.body.checkout.order.paymentStatus).toBe('PAID');
  });

  it('records a definite failure as FAILED (bill stays open)', async () => {
    const ctx = setupTestApp({ paymentProviders: [fakeProvider(async () => ({ outcome: 'FAILED', reason: 'Card declined' }))] });
    const order = await createOrder(ctx);
    await bill(ctx, order.id);
    const res = await pay(ctx, order.id, { method: 'TERMINAL', expectedTotalPaise: 63000 }).expect(201);
    expect(res.body.payment).toMatchObject({ status: 'FAILED', failureReason: 'Card declined' });
    expect(res.body.checkout.bill.status).toBe('OPEN');
  });

  it.each([
    ['throws', () => Promise.reject(new Error('socket hang up'))],
    ['times out', () => new Promise<ProviderOutcome>(() => {})],
    ['reports unknown', () => Promise.resolve<ProviderOutcome>({ outcome: 'UNKNOWN', reason: 'Ambiguous response' })],
  ])('marks the attempt UNKNOWN when the provider %s, blocks new attempts, and allows admin resolution', async (_n, impl) => {
    const ctx = setupTestApp({ paymentProviders: [fakeProvider(impl)], providerTimeoutMs: 50 });
    const order = await createOrder(ctx);
    await bill(ctx, order.id);
    const res = await pay(ctx, order.id, { method: 'TERMINAL', expectedTotalPaise: 63000 }).expect(201);
    expect(res.body.payment.status).toBe('UNKNOWN');
    expect(res.body.checkout.order.paymentStatus).toBe('UNCERTAIN');

    // No blind retry: another payment (any method) is refused until someone checks.
    const blocked = await cash(ctx, order.id, 63000, 63000).expect(409);
    expect(blocked.body.error.code).toBe('PAYMENT_UNCERTAIN');
    await bill(ctx, order.id, { discount: { type: 'AMOUNT', paise: 100, reason: 'change it' } }).expect(409);

    const pid = res.body.payment.id;
    await ctx.as('RECEPTION').post(`/api/payments/${pid}/resolve`).send({ outcome: 'FAILED', note: 'Checked terminal log' }).expect(403);
    const resolved = await ctx.api
      .post(`/api/payments/${pid}/resolve`)
      
      .send({ outcome: 'FAILED', note: 'Terminal shows no transaction' })
      .expect(200);
    expect(resolved.body.payment).toMatchObject({ status: 'FAILED', note: 'Terminal shows no transaction' });
    await cash(ctx, order.id, 63000, 63000).expect(201); // now allowed
  });

  it('resolving an uncertain attempt as SUCCEEDED marks the order paid', async () => {
    const ctx = setupTestApp({ paymentProviders: [fakeProvider(() => Promise.reject(new Error('timeout')))] });
    const order = await createOrder(ctx);
    await bill(ctx, order.id);
    const { body } = await pay(ctx, order.id, { method: 'TERMINAL', expectedTotalPaise: 63000 });
    const r = await ctx.api
      .post(`/api/payments/${body.payment.id}/resolve`)
      
      .send({ outcome: 'SUCCEEDED', providerReference: 'BANK-99', note: 'Seen in settlement report' })
      .expect(200);
    expect(r.body.checkout.order.paymentStatus).toBe('PAID');
    expect(r.body.checkout.bill.status).toBe('PAID');
  });
});

describe('daily sales summary', () => {
  it('counts only completed payments, splits by method, subtracts refunds on the refund day, and reconciles', async () => {
    let now = new Date(2026, 9, 21, 12, 0);
    const ctx = setupTestApp({ now: () => now });
    // Day 1 (21 Oct): 4 orders
    const a = await createOrder(ctx); // cash ₹630
    const b = await createOrder(ctx, [['Masala Chai', 2]]); // UPI ₹80
    const c = await createOrder(ctx, [['Butter Naan', 1]]); // failed UPI, then unpaid
    const d = await createOrder(ctx, [['Kulfi', 1]]); // never billed: unpaid ₹95 (estimate)
    for (const o of [a, b, c]) await bill(ctx, o.id);
    await cash(ctx, a.id, 63000, 70000).expect(201);
    const upi = await pay(ctx, b.id, { method: 'UPI_MANUAL', outcome: 'SUCCEEDED', manuallyVerified: true, expectedTotalPaise: 8000 }).expect(201);
    await pay(ctx, c.id, { method: 'UPI_MANUAL', outcome: 'FAILED', failureReason: 'declined', expectedTotalPaise: 5000 }).expect(201);

    const day1 = (await ctx.api.get('/api/reports/daily?date=2026-10-21').expect(200)).body.summary;
    expect(day1).toMatchObject({
      orderCount: 4,
      grossSalesPaise: 71000,
      paidCount: 2,
      refundCount: 0,
      refundTotalPaise: 0,
      netSalesPaise: 71000,
      unpaidCount: 2,
      unpaidTotalPaise: 5000 + 9500,
      failedAttemptCount: 1,
      uncertainAttemptCount: 0,
    });
    expect(day1.byMethod.CASH).toEqual({ count: 1, totalPaise: 63000 });
    expect(day1.byMethod.UPI_MANUAL).toEqual({ count: 1, totalPaise: 8000 });
    // Reconciliation: the method totals add up to gross sales, which equals the sum of
    // successful payment rows in the database.
    const methodSum = Object.values(day1.byMethod as Record<string, { totalPaise: number }>).reduce((s, m) => s + m.totalPaise, 0);
    expect(methodSum).toBe(day1.grossSalesPaise);
    const dbSum = ctx.db.select().from(payments).where(eq(payments.status, 'SUCCEEDED')).all().reduce((s, p) => s + p.amountPaise, 0);
    expect(dbSum).toBe(day1.grossSalesPaise);
    expect(day1.payments).toHaveLength(3);

    // Day 2 (22 Oct, just after midnight): yesterday's UPI sale is refunded.
    now = new Date(2026, 9, 22, 0, 5);
    await ctx.api.post(`/api/payments/${upi.body.payment.id}/refund`).send({ reason: 'Complaint', confirmed: true }).expect(200);
    const day2 = (await ctx.api.get('/api/reports/daily?date=2026-10-22').expect(200)).body.summary;
    expect(day2).toMatchObject({ orderCount: 0, grossSalesPaise: 0, refundCount: 1, refundTotalPaise: 8000, netSalesPaise: -8000 });

    // The original day's gross sales are not rewritten by a later refund.
    const day1Again = (await ctx.api.get('/api/reports/daily?date=2026-10-21')).body.summary;
    expect(day1Again.grossSalesPaise).toBe(71000);
    expect(day1Again.refundTotalPaise).toBe(0);
  });

  it('uses local midnight as the day boundary and validates the date', async () => {
    let now = new Date(2026, 9, 21, 23, 59, 59);
    const ctx = setupTestApp({ now: () => now });
    const late = await createOrder(ctx);
    await bill(ctx, late.id);
    now = new Date(2026, 9, 22, 0, 0, 1);
    await cash(ctx, late.id, 63000, 63000).expect(201); // paid after midnight

    const d21 = (await ctx.api.get('/api/reports/daily?date=2026-10-21')).body.summary;
    const d22 = (await ctx.api.get('/api/reports/daily?date=2026-10-22')).body.summary;
    expect(d21).toMatchObject({ orderCount: 1, grossSalesPaise: 0, unpaidCount: 0 }); // ordered on 21st, paid on 22nd
    expect(d22).toMatchObject({ orderCount: 0, grossSalesPaise: 63000 });
    expect(new Date(d21.from).getHours()).toBe(0);

    await ctx.api.get('/api/reports/daily?date=2026-13-01').expect(400);
    await ctx.api.get('/api/reports/daily?date=21-10-2026').expect(400);
  });
});

describe('seed --reset', () => {
  it('also clears bills and payments (foreign keys) but keeps settings and taxes', async () => {
    const { seed } = await import('../src/db/seed');
    const { restaurantSettings, taxRates, orders } = await import('../src/db/schema');
    const ctx = setupTestApp();
    await setSettings(ctx, { taxes: [{ name: 'GST', rateBps: 500 }] });
    const order = await createOrder(ctx);
    await bill(ctx, order.id);
    await cash(ctx, order.id, 66150, 70000).expect(201);
    expect(() => seed(ctx.db, { reset: true })).not.toThrow();
    expect(ctx.db.select().from(payments).all()).toHaveLength(0);
    expect(ctx.db.select().from(bills).all()).toHaveLength(0);
    expect(ctx.db.select().from(orders).all()).toHaveLength(0);
    expect(ctx.db.select().from(restaurantSettings).all()).toHaveLength(1);
    expect(ctx.db.select().from(taxRates).all()).toHaveLength(1);
  });
});
