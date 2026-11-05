import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { menuItems } from '../src/db/schema';
import { requestId, setupTestApp } from './helpers';

const setup = () => {
  const ctx = setupTestApp();
  const find = (name: string) => ctx.db.select().from(menuItems).where(eq(menuItems.name, name)).get()!.id;
  const tikka = find('Paneer Tikka'); // 24000
  const roti = find('Tandoori Roti'); // 3000
  const R = ctx.as('RECEPTION');
  const takeaway = async (menuItemId = tikka, quantity = 1) =>
    (await R.post('/api/orders').send({ clientRequestId: requestId(), orderType: 'TAKEAWAY', items: [{ menuItemId, quantity }] }).expect(201)).body.order;
  /** Bill the order and put it on credit. */
  const onCredit = async (order: { id: number }, who: { customerName: string; customerPhone: string } = { customerName: 'Ramesh', customerPhone: '9876543210' }) => {
    const total = (await R.post(`/api/orders/${order.id}/bill`).send({}).expect(200)).body.bill.totalPaise as number;
    const res = await R.post(`/api/orders/${order.id}/payments`).send({ method: 'CREDIT', idempotencyKey: requestId(), expectedTotalPaise: total, ...who });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res;
  };
  const collect = (customerId: number, body: object) => R.post(`/api/credit/customers/${customerId}/collect`).send({ idempotencyKey: requestId(), ...body });
  return { ctx, R, tikka, roti, takeaway, onCredit, collect };
};

describe('putting a bill on credit', () => {
  it('needs a customer name and a 10-digit phone number', async () => {
    const { R, takeaway } = setup();
    const o = await takeaway();
    const total = (await R.post(`/api/orders/${o.id}/bill`).send({}).expect(200)).body.bill.totalPaise;
    const pay = (extra: object) => R.post(`/api/orders/${o.id}/payments`).send({ method: 'CREDIT', idempotencyKey: requestId(), expectedTotalPaise: total, ...extra });
    await pay({}).expect(400);
    await pay({ customerName: 'Ramesh' }).expect(400);
    await pay({ customerName: 'Ramesh', customerPhone: '12345' }).expect(400);
    await pay({ customerName: '', customerPhone: '9876543210' }).expect(400);
  });

  it('closes the bill like a payment, keeps a record of who owes what, and counts as a sale', async () => {
    const { ctx, R, takeaway, onCredit } = setup();
    const o = await takeaway();
    const res = await onCredit(o);
    expect(res.body.payment).toMatchObject({ method: 'CREDIT', status: 'SUCCEEDED', amountPaise: 24000 });
    expect(res.body.checkout.order).toMatchObject({ paymentStatus: 'PAID', paymentMethod: 'CREDIT' });
    // paying the same bill again is refused, as for any paid bill
    expect((await R.post(`/api/orders/${o.id}/payments`).send({ method: 'CASH', idempotencyKey: requestId(), expectedTotalPaise: 24000, tenderedPaise: 24000 }).expect(409)).body.error.code).toBe('ALREADY_PAID');

    const list = (await R.get('/api/credit/customers').expect(200)).body.customers;
    expect(list).toEqual([expect.objectContaining({ name: 'Ramesh', phone: '9876543210', outstandingPaise: 24000, openBills: 1 })]);

    const summary = (await ctx.api.get('/api/reports/daily').expect(200)).body.summary;
    expect(summary.byMethod.CREDIT).toEqual({ count: 1, totalPaise: 24000 });
    expect(summary.credit).toMatchObject({ givenPaise: 24000, givenCount: 1, collectedPaise: 0, outstandingPaise: 24000, owingCustomers: 1 });
    expect(summary.unpaidCount).toBe(0); // it is settled on the bill, just owed by the customer
  });

  it('cannot be refunded', async () => {
    const { ctx, takeaway, onCredit } = setup();
    const res = await onCredit(await takeaway());
    const refund = await ctx.api.post(`/api/payments/${res.body.payment.id}/refund`).send({ reason: 'Customer returned food', confirmed: true });
    expect(refund.status).toBe(409);
    expect(refund.body.error.code).toBe('NOT_REFUNDABLE');
  });

  it('puts every order of a table bill on one credit entry', async () => {
    const { ctx, R, tikka, roti, collect } = setup();
    const t = (await ctx.api.post('/api/tables').send({ name: 'T1' })).body.table;
    const place = async (menuItemId: number) =>
      (await R.post('/api/orders').send({ clientRequestId: requestId(), orderType: 'DINE_IN', tableId: t.id, items: [{ menuItemId, quantity: 1 }] }).expect(201)).body.order;
    const a = await place(tikka);
    // a failed attempt keeps the next order separate, so the table bill covers two orders
    await R.post(`/api/orders/${a.id}/bill`).send({});
    await R.post(`/api/orders/${a.id}/payments`).send({ method: 'UPI_MANUAL', idempotencyKey: requestId(), expectedTotalPaise: 24000, outcome: 'FAILED', failureReason: 'Declined' }).expect(201);
    const b = await place(roti);
    const bill = (await R.post(`/api/tables/${t.id}/bill`).send({}).expect(200)).body.bill;
    await R.post(`/api/tables/${t.id}/payments`).send({ method: 'CREDIT', idempotencyKey: requestId(), expectedTotalPaise: bill.totalPaise, customerName: 'Sunita', customerPhone: '9123456780' }).expect(201);

    const customer = (await R.get('/api/credit/customers').expect(200)).body.customers[0];
    expect(customer.outstandingPaise).toBe(27000);
    const detail = (await R.get(`/api/credit/customers/${customer.id}`).expect(200)).body;
    expect(detail.sales).toHaveLength(1);
    expect(detail.sales[0]).toMatchObject({ amountPaise: 27000, remainingPaise: 27000, tableName: 'T1' });
    expect(detail.sales[0].orderNumbers).toEqual([a.orderNumber, b.orderNumber]);
    expect(detail.sales[0].itemsSummary).toMatch(/Paneer Tikka.*Tandoori Roti/);
    expect(typeof collect).toBe('function');
  });
});

describe('collecting what customers owe', () => {
  it('takes part payments, shows what is left on each bill, and settles the customer', async () => {
    const { R, takeaway, onCredit, collect } = setup();
    const first = await takeaway();
    await onCredit(first);
    const customerId = (await R.get('/api/credit/customers')).body.customers[0].id;

    const part = await collect(customerId, { amountPaise: 10000, method: 'CASH' }).expect(201);
    expect(part.body.customer).toMatchObject({ outstandingPaise: 14000, collectedPaise: 10000, openBills: 1 });
    expect(part.body.sales[0]).toMatchObject({ amountPaise: 24000, paidPaise: 10000, remainingPaise: 14000 });
    expect(part.body.sales[0].receipts).toEqual([expect.objectContaining({ amountPaise: 10000, method: 'CASH' })]);

    await collect(customerId, { amountPaise: 14001, method: 'CASH' }).expect(400); // more than owed
    await collect(customerId, { amountPaise: 0, method: 'CASH' }).expect(400);
    await collect(customerId, { amountPaise: 14000, method: 'UPI_MANUAL' }).expect(400); // UPI must be confirmed
    const done = await collect(customerId, { amountPaise: 14000, method: 'UPI_MANUAL', manuallyVerified: true, providerReference: 'UTR123' }).expect(201);
    expect(done.body.customer).toMatchObject({ outstandingPaise: 0, openBills: 0 });
    expect((await R.get('/api/credit/customers')).body.customers).toEqual([]); // nobody owes anything
    expect((await R.get('/api/credit/customers?all=1')).body.customers).toHaveLength(1);
    await collect(customerId, { amountPaise: 100, method: 'CASH' }).expect(409);
  });

  it('pays the oldest bills first, or a chosen bill, and never records a retry twice', async () => {
    const { R, takeaway, onCredit, collect, tikka, roti } = setup();
    await onCredit(await takeaway(tikka)); // 24000 (older)
    await onCredit(await takeaway(roti)); // 3000
    const customerId = (await R.get('/api/credit/customers')).body.customers[0].id;
    expect((await R.get(`/api/credit/customers/${customerId}`)).body.customer.outstandingPaise).toBe(27000);

    const key = requestId();
    const r1 = await collect(customerId, { amountPaise: 25000, method: 'CASH', idempotencyKey: key }).expect(201);
    const retry = await collect(customerId, { amountPaise: 25000, method: 'CASH', idempotencyKey: key }).expect(200);
    expect(retry.body.duplicate).toBe(true);
    expect(retry.body.customer.collectedPaise).toBe(25000);
    // oldest bill (24000) cleared, the rest went to the next one
    const bySale = Object.fromEntries(r1.body.sales.map((s: any) => [s.amountPaise, s.remainingPaise]));
    expect(bySale).toEqual({ 24000: 0, 3000: 2000 });

    // a chosen bill only
    const chosen = r1.body.sales.find((s: any) => s.amountPaise === 3000).id;
    await collect(customerId, { amountPaise: 2500, method: 'CASH', creditSaleId: chosen }).expect(400); // only 2000 left on it
    const fin = await collect(customerId, { amountPaise: 2000, method: 'CASH', creditSaleId: chosen }).expect(201);
    expect(fin.body.customer.outstandingPaise).toBe(0);
  });

  it('keeps one customer per phone number and uses the newest name', async () => {
    const { R, takeaway, onCredit } = setup();
    await onCredit(await takeaway(), { customerName: 'Ramesh', customerPhone: '9876543210' });
    await onCredit(await takeaway(), { customerName: 'Ramesh Kumar', customerPhone: '9876543210' });
    await onCredit(await takeaway(), { customerName: 'Anita', customerPhone: '9000000001' });
    const list = (await R.get('/api/credit/customers')).body.customers;
    expect(list.map((c: any) => [c.name, c.outstandingPaise])).toEqual([['Ramesh Kumar', 48000], ['Anita', 24000]]);
    expect((await R.get('/api/credit/customers?q=anit')).body.customers).toHaveLength(1);
    expect((await R.get('/api/credit/customers?q=98765')).body.customers).toHaveLength(1);
    expect((await R.get('/api/credit/lookup?phone=9876543210')).body.customer).toMatchObject({ name: 'Ramesh Kumar', outstandingPaise: 48000 });
    expect((await R.get('/api/credit/lookup?phone=9999999999')).body.customer).toBeNull();
    await R.get('/api/credit/lookup?phone=123').expect(400);
  });

  it('shows collections in the sales figures and is limited to Superadmin and Reception', async () => {
    const { ctx, R, takeaway, onCredit, collect } = setup();
    await onCredit(await takeaway());
    const customerId = (await R.get('/api/credit/customers')).body.customers[0].id;
    await collect(customerId, { amountPaise: 5000, method: 'CASH' }).expect(201);
    await collect(customerId, { amountPaise: 2000, method: 'UPI_MANUAL', manuallyVerified: true }).expect(201);
    const day = (await ctx.api.get('/api/reports/daily').expect(200)).body.summary;
    expect(day.credit).toMatchObject({ givenPaise: 24000, collectedPaise: 7000, collectedCashPaise: 5000, collectedUpiPaise: 2000, outstandingPaise: 17000 });
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const a = (await ctx.api.get(`/api/reports/analytics?from=${key}&to=${key}`).expect(200)).body.analytics;
    expect(a.credit).toMatchObject({ givenPaise: 24000, collectedPaise: 7000, outstandingPaise: 17000 });
    expect(a.byMethod.CREDIT).toEqual({ count: 1, totalPaise: 24000 });
    const history = (await ctx.api.get(`/api/reports/history?from=${key}&to=${key}`).expect(200)).body.rows;
    expect(history[0]).toMatchObject({ paymentStatus: 'PAID', paymentMethod: 'CREDIT' });

    await ctx.as('KITCHEN').get('/api/credit/customers').expect(403);
    await ctx.anon.get('/api/credit/customers').expect(401);
    await ctx.as('KITCHEN').post(`/api/credit/customers/${customerId}/collect`).send({ amountPaise: 100, method: 'CASH', idempotencyKey: requestId() }).expect(403);
  });
});
