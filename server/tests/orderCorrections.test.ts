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
  const K = ctx.as('KITCHEN');
  const takeaway = async (lines: { menuItemId: number; quantity: number }[] = [{ menuItemId: tikka, quantity: 1 }]) =>
    (await R.post('/api/orders').send({ clientRequestId: requestId(), orderType: 'TAKEAWAY', items: lines }).expect(201)).body.order;
  return { ctx, tikka, roti, R, K, takeaway };
};

describe('dine-in needs a table', () => {
  it('refuses a dine-in order with no table, accepts one with a table', async () => {
    const { ctx, tikka } = setup();
    const body = { clientRequestId: requestId(), orderType: 'DINE_IN', items: [{ menuItemId: tikka, quantity: 1 }] };
    expect((await ctx.api.post('/api/orders').send(body).expect(400)).body.error.code).toBe('TABLE_REQUIRED');
    await ctx.api.post('/api/orders').send({ ...body, clientRequestId: requestId(), tableNumber: '5' }).expect(201);
  });
});

describe('cancelling an order', () => {
  it('cancels an unpaid order, needs a reason, and takes it off the kitchen screen and the unpaid totals', async () => {
    const { ctx, R, K, takeaway } = setup();
    const o = await takeaway();
    await R.post(`/api/orders/${o.id}/cancel`).send({}).expect(400);
    await R.post(`/api/orders/${o.id}/cancel`).send({ reason: 'x' }).expect(400);
    const res = await R.post(`/api/orders/${o.id}/cancel`).send({ reason: 'Customer left' }).expect(200);
    expect(res.body.order).toMatchObject({ status: 'CANCELLED', cancelReason: 'Customer left' });
    expect((await K.get('/api/kitchen/orders')).body.orders).toHaveLength(0);
    const today = (await ctx.api.get('/api/reports/daily')).body.summary;
    expect(today.unpaidCount).toBe(0);
    await R.post(`/api/orders/${o.id}/bill`).send({}).expect(409); // cancelled orders cannot be billed
    await R.post(`/api/orders/${o.id}/cancel`).send({ reason: 'Customer left' }).expect(200); // repeating is harmless
  });

  it('cannot cancel once the kitchen has started, for anyone', async () => {
    const { ctx, R, K, takeaway } = setup();
    const o = await takeaway();
    await K.patch(`/api/orders/${o.id}/status`).send({ status: 'PREPARING' }).expect(200);
    for (const who of [R, ctx.api]) {
      expect((await who.post(`/api/orders/${o.id}/cancel`).send({ reason: 'Changed mind' }).expect(409)).body.error.code).toBe('ORDER_STARTED');
    }
    await K.post(`/api/orders/${o.id}/cancel`).send({ reason: 'Changed mind' }).expect(403); // kitchen never cancels
    // cancelled before it started: a kitchen screen that still shows the ticket gets a clear message when it taps Start
    const early = await takeaway();
    await R.post(`/api/orders/${early.id}/cancel`).send({ reason: 'Customer left' }).expect(200);
    const late = await K.patch(`/api/orders/${early.id}/status`).send({ status: 'PREPARING' }).expect(409);
    expect(late.body.error).toMatchObject({ code: 'ORDER_CANCELLED', message: expect.stringContaining('was cancelled') });
  });

  it('refuses to cancel paid or served orders', async () => {
    const { ctx, R, takeaway } = setup();
    const paid = await takeaway();
    await R.post(`/api/orders/${paid.id}/bill`).send({});
    await R.post(`/api/orders/${paid.id}/payments`).send({ method: 'CASH', idempotencyKey: requestId(), expectedTotalPaise: 24000, tenderedPaise: 24000 }).expect(201);
    expect((await R.post(`/api/orders/${paid.id}/cancel`).send({ reason: 'Oops' }).expect(409)).body.error.code).toBe('ORDER_HAS_PAYMENT');

    const served = await takeaway();
    for (const status of ['PREPARING', 'READY', 'COMPLETED']) await ctx.api.patch(`/api/orders/${served.id}/status`).send({ status }).expect(200);
    expect((await R.post(`/api/orders/${served.id}/cancel`).send({ reason: 'Oops' }).expect(409)).body.error.code).toBe('ORDER_STARTED');
  });

  it("takes a cancelled order off its table: nothing left to pay, table not blocked", async () => {
    const { ctx, R, tikka } = setup();
    const table = (await ctx.api.post('/api/tables').send({ name: 'T1' })).body.table;
    const o = (await R.post('/api/orders').send({ clientRequestId: requestId(), orderType: 'DINE_IN', tableId: table.id, items: [{ menuItemId: tikka, quantity: 1 }] }).expect(201)).body.order;
    await R.post(`/api/tables/${table.id}/bill`).send({}).expect(200);
    await R.post(`/api/orders/${o.id}/cancel`).send({ reason: 'Wrong table' }).expect(200);
    const tile = (await R.get('/api/tables/overview')).body.tables.find((t: any) => t.id === table.id);
    expect(tile).toMatchObject({ status: 'AVAILABLE', tableStatus: 'BLANK', runningTotalPaise: 0 });
    // a new customer can sit down and order normally
    const again = await R.post('/api/orders').send({ clientRequestId: requestId(), orderType: 'DINE_IN', tableId: table.id, items: [{ menuItemId: tikka, quantity: 1 }] }).expect(201);
    expect(again.body.merged).toBe(false);
    expect(again.body.order.id).not.toBe(o.id);
  });
});

describe('changing the items of an order', () => {
  it('replaces items and price while the kitchen has not started', async () => {
    const { R, tikka, roti, takeaway } = setup();
    const o = await takeaway();
    const res = await R.put(`/api/orders/${o.id}/items`).send({ items: [{ menuItemId: tikka, quantity: 2 }, { menuItemId: roti, quantity: 3 }], notes: 'extra spicy' }).expect(200);
    expect(res.body.order).toMatchObject({ subtotalPaise: 57000, itemCount: 5, notes: 'extra spicy' });
    await R.put(`/api/orders/${o.id}/items`).send({ items: [] }).expect(400);
  });

  it('throws away an old bill so the new total is what gets charged', async () => {
    const { R, tikka, takeaway } = setup();
    const o = await takeaway();
    await R.post(`/api/orders/${o.id}/bill`).send({}).expect(200); // total 24000
    await R.put(`/api/orders/${o.id}/items`).send({ items: [{ menuItemId: tikka, quantity: 2 }] }).expect(200);
    // the old bill is gone, so paying the old total is refused until a new bill exists
    expect((await R.post(`/api/orders/${o.id}/payments`).send({ method: 'CASH', idempotencyKey: requestId(), expectedTotalPaise: 24000, tenderedPaise: 24000 }).expect(409)).body.error.code).toBe('BILL_REQUIRED');
    expect((await R.post(`/api/orders/${o.id}/bill`).send({}).expect(200)).body.bill.totalPaise).toBe(48000);
  });

  it('is refused once cooking started, after a payment attempt, or for an item that is off the menu', async () => {
    const { ctx, R, K, tikka, takeaway } = setup();
    const cooking = await takeaway();
    await K.patch(`/api/orders/${cooking.id}/status`).send({ status: 'PREPARING' }).expect(200);
    expect((await R.put(`/api/orders/${cooking.id}/items`).send({ items: [{ menuItemId: tikka, quantity: 2 }] }).expect(409)).body.error.code).toBe('ORDER_LOCKED');

    const tried = await takeaway();
    await R.post(`/api/orders/${tried.id}/bill`).send({});
    await R.post(`/api/orders/${tried.id}/payments`).send({ method: 'UPI_MANUAL', idempotencyKey: requestId(), expectedTotalPaise: 24000, outcome: 'FAILED', failureReason: 'Customer bank declined' }).expect(201);
    expect((await R.put(`/api/orders/${tried.id}/items`).send({ items: [{ menuItemId: tikka, quantity: 2 }] }).expect(409)).body.error.code).toBe('ORDER_HAS_PAYMENT');

    const fresh = await takeaway();
    await ctx.api.patch(`/api/menu/items/${tikka}`).send({ isAvailable: false });
    await R.put(`/api/orders/${fresh.id}/items`).send({ items: [{ menuItemId: tikka, quantity: 1 }] }).expect(409);
  });
});

describe('table housekeeping', () => {
  it('shows a renamed table on its unpaid open orders but not on paid ones', async () => {
    const { ctx, R, tikka } = setup();
    const table = (await ctx.api.post('/api/tables').send({ name: 'T9' })).body.table;
    const place = async () => (await R.post('/api/orders').send({ clientRequestId: requestId(), orderType: 'DINE_IN', tableId: table.id, items: [{ menuItemId: tikka, quantity: 1 }] }).expect(201)).body.order;
    const paid = await place();
    await R.post(`/api/orders/${paid.id}/bill`).send({});
    await R.post(`/api/orders/${paid.id}/payments`).send({ method: 'CASH', idempotencyKey: requestId(), expectedTotalPaise: 24000, tenderedPaise: 24000 }).expect(201);
    const unpaid = await place(); // the first one is paid, so this starts a new order
    expect(unpaid.id).not.toBe(paid.id);
    await ctx.api.patch(`/api/tables/${table.id}`).send({ name: 'Window 1' }).expect(200);
    expect((await R.get(`/api/orders/${unpaid.id}`)).body.order.tableNumber).toBe('Window 1');
    expect((await R.get(`/api/orders/${paid.id}`)).body.order.tableNumber).toBe('T9');
  });
});

describe('more food ordered at a table that already has an order', () => {
  const tableSetup = async () => {
    const s = setup();
    const table = (await s.ctx.api.post('/api/tables').send({ name: 'T1' })).body.table;
    const other = (await s.ctx.api.post('/api/tables').send({ name: 'T2' })).body.table;
    const send = (tableId: number, lines: { menuItemId: number; quantity: number }[], extra: object = {}) =>
      s.R.post('/api/orders').send({ clientRequestId: requestId(), orderType: 'DINE_IN', tableId, items: lines, ...extra });
    return { ...s, table, other, send };
  };

  it('adds the new items to the existing order instead of making a second one', async () => {
    const { R, K, table, other, tikka, roti, send } = await tableSetup();
    const first = (await send(table.id, [{ menuItemId: tikka, quantity: 1 }], { notes: 'less spicy' }).expect(201)).body;
    expect(first.merged).toBe(false);
    const second = (await send(table.id, [{ menuItemId: tikka, quantity: 1 }, { menuItemId: roti, quantity: 2 }], { notes: 'extra napkins' }).expect(201)).body;
    expect(second.merged).toBe(true);
    expect(second.order.id).toBe(first.order.id);
    // still NEW, so the same item just adds up
    expect(second.order.items.map((i: any) => [i.itemName, i.quantity])).toEqual([['Paneer Tikka', 2], ['Tandoori Roti', 2]]);
    expect(second.order.subtotalPaise).toBe(54000);
    expect(second.order.notes).toBe('less spicy | extra napkins');
    expect((await K.get('/api/kitchen/orders')).body.orders).toHaveLength(1);
    // another table, and takeaway, are never merged
    expect((await send(other.id, [{ menuItemId: roti, quantity: 1 }]).expect(201)).body.merged).toBe(false);
    expect((await R.post('/api/orders').send({ clientRequestId: requestId(), orderType: 'TAKEAWAY', items: [{ menuItemId: roti, quantity: 1 }] }).expect(201)).body.merged).toBe(false);
  });

  it('puts dishes added while the kitchen is cooking on their own ticket, and leaves the cooking order alone', async () => {
    const { R, K, table, tikka, roti, send } = await tableSetup();
    const o = (await send(table.id, [{ menuItemId: tikka, quantity: 1 }]).expect(201)).body.order;
    await K.patch(`/api/orders/${o.id}/status`).send({ status: 'PREPARING' }).expect(200);
    const added = (await send(table.id, [{ menuItemId: tikka, quantity: 1 }, { menuItemId: roti, quantity: 1 }]).expect(201)).body;
    expect(added.merged).toBe(false);
    expect(added.order.id).not.toBe(o.id);
    expect(added.order).toMatchObject({ status: 'NEW', tableId: table.id });
    // the cooking order keeps its stage and its dishes
    const cooking = (await R.get(`/api/orders/${o.id}`)).body.order;
    expect(cooking.status).toBe('PREPARING');
    expect(cooking.items.map((i: any) => [i.itemName, i.quantity])).toEqual([['Paneer Tikka', 1]]);
    // the kitchen sees two tickets, one in each stage
    const tickets = (await K.get('/api/kitchen/orders')).body.orders;
    expect(tickets.map((t: any) => [t.id, t.status]).sort()).toEqual([[o.id, 'PREPARING'], [added.order.id, 'NEW']].sort());
    expect(JSON.stringify(tickets)).not.toMatch(/Paise/);
    // still one table, one bill: the table total covers both tickets
    const detail = (await R.get(`/api/tables/${table.id}`)).body;
    expect(detail.runningTotalPaise).toBe(24000 + 24000 + 3000);
    expect(detail.orders).toHaveLength(2);
  });

  it('keeps adding to the new ticket while it is still NEW, then starts another once it is cooking', async () => {
    const { K, table, tikka, roti, send } = await tableSetup();
    const first = (await send(table.id, [{ menuItemId: tikka, quantity: 1 }]).expect(201)).body.order;
    await K.patch(`/api/orders/${first.id}/status`).send({ status: 'PREPARING' }).expect(200);
    const second = (await send(table.id, [{ menuItemId: roti, quantity: 1 }]).expect(201)).body.order;
    const third = (await send(table.id, [{ menuItemId: roti, quantity: 1 }]).expect(201)).body;
    expect(third.merged).toBe(true); // same stage as the second ticket: together
    expect(third.order.id).toBe(second.id);
    expect(third.order.items.map((i: any) => [i.itemName, i.quantity])).toEqual([['Tandoori Roti', 2]]);
    await K.patch(`/api/orders/${second.id}/status`).send({ status: 'PREPARING' }).expect(200);
    const fourth = (await send(table.id, [{ menuItemId: roti, quantity: 1 }]).expect(201)).body;
    expect(fourth.merged).toBe(false);
    expect([first.id, second.id]).not.toContain(fourth.order.id);
  });

  it('puts dessert after the meal on its own ticket when the first order was already served but not paid', async () => {
    const { ctx, table, roti, tikka, send } = await tableSetup();
    const o = (await send(table.id, [{ menuItemId: tikka, quantity: 1 }]).expect(201)).body.order;
    for (const status of ['PREPARING', 'READY', 'COMPLETED']) await ctx.api.patch(`/api/orders/${o.id}/status`).send({ status }).expect(200);
    const more = (await send(table.id, [{ menuItemId: roti, quantity: 1 }]).expect(201)).body.order;
    expect(more.id).not.toBe(o.id);
    expect(more.status).toBe('NEW');
    expect((await ctx.api.get(`/api/orders/${o.id}`)).body.order.status).toBe('COMPLETED'); // the served order stays served
  });

  it('one table bill covers every ticket, and a bill made earlier is redone when a ticket is added', async () => {
    const { R, K, table, tikka, roti, send } = await tableSetup();
    const o = (await send(table.id, [{ menuItemId: tikka, quantity: 1 }]).expect(201)).body.order;
    await K.patch(`/api/orders/${o.id}/status`).send({ status: 'PREPARING' }).expect(200);
    expect((await R.post(`/api/tables/${table.id}/bill`).send({}).expect(200)).body.bill.totalPaise).toBe(24000);
    await send(table.id, [{ menuItemId: roti, quantity: 1 }]).expect(201);
    const pay = await R.post(`/api/tables/${table.id}/payments`).send({ method: 'CASH', idempotencyKey: requestId(), expectedTotalPaise: 24000, tenderedPaise: 24000 });
    expect(pay.status).toBe(409); // the old bill (first ticket only) is gone
    const bill = (await R.post(`/api/tables/${table.id}/bill`).send({}).expect(200)).body.bill;
    expect(bill.totalPaise).toBe(27000);
    await R.post(`/api/tables/${table.id}/payments`).send({ method: 'CASH', idempotencyKey: requestId(), expectedTotalPaise: 27000, tenderedPaise: 27000 }).expect(201);
    for (const id of [o.id]) expect((await R.get(`/api/orders/${id}`)).body.order.paymentStatus).toBe('PAID');
  });

  it('throws away an already-printed bill so the new total is charged', async () => {
    const { R, table, tikka, roti, send } = await tableSetup();
    const o = (await send(table.id, [{ menuItemId: tikka, quantity: 1 }]).expect(201)).body.order;
    expect((await R.post(`/api/tables/${table.id}/bill`).send({}).expect(200)).body.bill.totalPaise).toBe(24000);
    await send(table.id, [{ menuItemId: roti, quantity: 1 }]).expect(201);
    const pay = await R.post(`/api/tables/${table.id}/payments`).send({ method: 'CASH', idempotencyKey: requestId(), expectedTotalPaise: 24000, tenderedPaise: 24000 });
    expect(pay.status).toBe(409); // the old bill is gone
    expect((await R.post(`/api/orders/${o.id}/bill`).send({}).expect(200)).body.bill.totalPaise).toBe(27000);
  });

  it('starts a fresh order once the table has been paid, and after a failed payment attempt', async () => {
    const { R, table, other, tikka, roti, send } = await tableSetup();
    const paid = (await send(table.id, [{ menuItemId: tikka, quantity: 1 }]).expect(201)).body.order;
    await R.post(`/api/orders/${paid.id}/bill`).send({});
    await R.post(`/api/orders/${paid.id}/payments`).send({ method: 'CASH', idempotencyKey: requestId(), expectedTotalPaise: 24000, tenderedPaise: 24000 }).expect(201);
    const next = (await send(table.id, [{ menuItemId: roti, quantity: 1 }]).expect(201)).body;
    expect(next.merged).toBe(false);
    expect(next.order.id).not.toBe(paid.id);

    const tried = (await send(other.id, [{ menuItemId: tikka, quantity: 1 }]).expect(201)).body.order;
    await R.post(`/api/orders/${tried.id}/bill`).send({});
    await R.post(`/api/orders/${tried.id}/payments`).send({ method: 'UPI_MANUAL', idempotencyKey: requestId(), expectedTotalPaise: 24000, outcome: 'FAILED', failureReason: 'Bank declined' }).expect(201);
    expect((await send(other.id, [{ menuItemId: roti, quantity: 1 }]).expect(201)).body.merged).toBe(false);
  });

  it('never adds the same submission twice when the phone retries', async () => {
    const { R, table, tikka, roti, send } = await tableSetup();
    await send(table.id, [{ menuItemId: tikka, quantity: 1 }]).expect(201);
    const key = requestId();
    const body = { clientRequestId: key, orderType: 'DINE_IN', tableId: table.id, items: [{ menuItemId: roti, quantity: 1 }] };
    const a = await R.post('/api/orders').send(body).expect(201);
    const b = await R.post('/api/orders').send(body).expect(200);
    expect(b.body).toMatchObject({ duplicate: true, merged: true });
    expect(b.body.order.items.find((i: any) => i.itemName === 'Tandoori Roti').quantity).toBe(1);
    expect(a.body.order.subtotalPaise).toBe(27000);
  });
});

describe('"Printed" only after printing', () => {
  const tile = async (ctx: ReturnType<typeof setup>['ctx'], id: number) => (await ctx.api.get('/api/tables/overview')).body.tables.find((t: any) => t.id === id);

  it('a table is Running until its bill or receipt is actually printed', async () => {
    const { ctx, R, tikka } = setup();
    const t = (await ctx.api.post('/api/tables').send({ name: 'T1' })).body.table;
    const o = (await R.post('/api/orders').send({ clientRequestId: requestId(), orderType: 'DINE_IN', tableId: t.id, items: [{ menuItemId: tikka, quantity: 1 }] }).expect(201)).body.order;
    expect((await tile(ctx, t.id)).tableStatus).toBe('RUNNING_KOT');
    await R.post(`/api/tables/${t.id}/bill`).send({}).expect(200); // opening Settle calculates a bill: still not printed
    expect((await tile(ctx, t.id)).tableStatus).toBe('RUNNING_KOT');
    await R.get(`/api/tables/${t.id}/receipt`).expect(200); // the Print button
    expect((await tile(ctx, t.id)).tableStatus).toBe('PRINTED');
    // adding food changes the bill, so it needs printing again
    await R.post('/api/orders').send({ clientRequestId: requestId(), orderType: 'DINE_IN', tableId: t.id, items: [{ menuItemId: tikka, quantity: 1 }] }).expect(201);
    expect((await tile(ctx, t.id)).tableStatus).toBe('RUNNING_KOT');
    expect(o.id).toBeGreaterThan(0);
  });

  it('a bill left over from a cancelled order does not make the next customer\'s table look printed', async () => {
    const { ctx, R, tikka } = setup();
    const t = (await ctx.api.post('/api/tables').send({ name: 'T1' })).body.table;
    const put = async () => (await R.post('/api/orders').send({ clientRequestId: requestId(), orderType: 'DINE_IN', tableId: t.id, items: [{ menuItemId: tikka, quantity: 1 }] }).expect(201)).body.order;
    const first = await put();
    await R.get(`/api/tables/${t.id}/receipt`).expect(200);
    expect((await tile(ctx, t.id)).tableStatus).toBe('PRINTED');
    await R.post(`/api/orders/${first.id}/cancel`).send({ reason: 'Customer left' }).expect(200);
    await put();
    expect((await tile(ctx, t.id)).tableStatus).toBe('RUNNING_KOT');
    const receipt = (await R.get(`/api/tables/${t.id}/receipt`)).body;
    expect(receipt.orders).toHaveLength(1);
    expect(receipt.bill.totalPaise).toBe(24000);
  });
});

describe('optional customer name and phone', () => {
  it('saves them on the order, rejects a bad phone number, and fills them in when more food is added', async () => {
    const { ctx, R, tikka, roti } = setup();
    const t = (await ctx.api.post('/api/tables').send({ name: 'T1' })).body.table;
    const body = { orderType: 'DINE_IN', tableId: t.id, items: [{ menuItemId: tikka, quantity: 1 }] };
    for (const bad of ['abc', '98765', '98765432101', '+919876543210', '98765 43210']) {
      expect((await R.post('/api/orders').send({ ...body, clientRequestId: requestId(), customerPhone: bad }).expect(400)).body.error.message).toMatch(/10 digits/);
    }
    const plain = (await R.post('/api/orders').send({ ...body, clientRequestId: requestId() }).expect(201)).body.order;
    expect(plain).toMatchObject({ customerName: null, customerPhone: null });
    const more = (await R.post('/api/orders').send({ ...body, clientRequestId: requestId(), items: [{ menuItemId: roti, quantity: 1 }], customerName: '  Asha ', customerPhone: '9876543210' }).expect(201)).body.order;
    expect(more).toMatchObject({ id: plain.id, customerName: 'Asha', customerPhone: '9876543210' });
    const takeaway = (await R.post('/api/orders').send({ clientRequestId: requestId(), orderType: 'TAKEAWAY', items: [{ menuItemId: tikka, quantity: 1 }], customerName: 'Ravi', customerPhone: '' }).expect(201)).body.order;
    expect(takeaway).toMatchObject({ customerName: 'Ravi', customerPhone: null });
  });
});

describe('orders paid through a table bill', () => {
  it('show as Paid in sales history and are not counted as unpaid', async () => {
    const { ctx, R, tikka, roti } = setup();
    const t = (await ctx.api.post('/api/tables').send({ name: 'T1' })).body.table;
    const place = async (menuItemId: number) =>
      (await R.post('/api/orders').send({ clientRequestId: requestId(), orderType: 'DINE_IN', tableId: t.id, items: [{ menuItemId, quantity: 1 }] }).expect(201)).body;
    const a = (await place(tikka)).order;
    // a failed attempt on the first order keeps the next order separate, so the table has two orders
    await R.post(`/api/orders/${a.id}/bill`).send({});
    await R.post(`/api/orders/${a.id}/payments`).send({ method: 'UPI_MANUAL', idempotencyKey: requestId(), expectedTotalPaise: 24000, outcome: 'FAILED', failureReason: 'Declined' }).expect(201);
    const bBody = await place(roti);
    expect(bBody.merged).toBe(false);

    const bill = (await R.post(`/api/tables/${t.id}/bill`).send({}).expect(200)).body.bill;
    expect(bill.totalPaise).toBe(27000);
    await R.post(`/api/tables/${t.id}/payments`).send({ method: 'CASH', idempotencyKey: requestId(), expectedTotalPaise: 27000, tenderedPaise: 27000 }).expect(201);

    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const history = (await ctx.api.get(`/api/reports/history?from=${key}&to=${key}`).expect(200)).body.rows;
    expect(history.map((r: any) => r.paymentStatus)).toEqual(['PAID', 'PAID']);
    expect(history.every((r: any) => r.paymentMethod === 'CASH')).toBe(true);
    expect((await ctx.api.get(`/api/reports/history?from=${key}&to=${key}&payment=UNPAID`).expect(200)).body.total).toBe(0);
    const day = (await ctx.api.get('/api/reports/daily').expect(200)).body.summary;
    expect(day).toMatchObject({ unpaidCount: 0, unpaidTotalPaise: 0, grossSalesPaise: 27000 });
  });
});
