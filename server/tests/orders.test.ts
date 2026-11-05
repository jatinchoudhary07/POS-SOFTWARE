import request from 'supertest';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { menuItems, orderItems, orders } from '../src/db/schema';
import { requestId, setupTestApp } from './helpers';

type Ctx = ReturnType<typeof setupTestApp>;

function itemByName(ctx: Ctx, name: string) {
  const item = ctx.db.select().from(menuItems).where(eq(menuItems.name, name)).get();
  if (!item) throw new Error(`Seed item ${name} missing`);
  return item;
}

describe('GET /api/menu', () => {
  it('returns categories with items, prices and availability', async () => {
    const ctx = setupTestApp();
    const res = await ctx.api.get('/api/menu').expect(200);
    expect(res.body.categories.length).toBeGreaterThan(0);
    const starters = res.body.categories.find((c: { name: string }) => c.name === 'Starters');
    expect(starters.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Paneer Tikka', pricePaise: 24000, isAvailable: true }),
        expect.objectContaining({ name: 'Fish Amritsari', isAvailable: false }),
      ]),
    );
  });
});

describe('POST /api/orders', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupTestApp();
  });

  it('creates an order, computes totals from DB prices and persists items', async () => {
    const tikka = itemByName(ctx, 'Paneer Tikka'); // ₹240
    const naan = itemByName(ctx, 'Butter Naan'); // ₹50
    const res = await ctx.api
      .post('/api/orders')
      .send({
        clientRequestId: requestId(),
        orderType: 'DINE_IN',
        tableNumber: ' 7 ',
        notes: 'Less spicy',
        items: [
          { menuItemId: tikka.id, quantity: 2 },
          { menuItemId: naan.id, quantity: 4 },
        ],
      })
      .expect(201);

    const order = res.body.order;
    expect(order.orderNumber).toMatch(/^\d{6}-\d{3}$/);
    expect(order.status).toBe('NEW');
    expect(order.tableNumber).toBe('7');
    expect(order.notes).toBe('Less spicy');
    expect(order.subtotalPaise).toBe(2 * 24000 + 4 * 5000);
    expect(order.itemCount).toBe(6);
    expect(order.items).toHaveLength(2);

    // Persistence: rows are really in SQLite.
    const row = ctx.db.select().from(orders).where(eq(orders.id, order.id)).get();
    expect(row?.subtotalPaise).toBe(68000);
    const lines = ctx.db.select().from(orderItems).where(eq(orderItems.orderId, order.id)).all();
    expect(lines.map((l) => [l.itemName, l.unitPricePaise, l.quantity, l.lineTotalPaise])).toEqual(
      expect.arrayContaining([
        ['Paneer Tikka', 24000, 2, 48000],
        ['Butter Naan', 5000, 4, 20000],
      ]),
    );

    // And readable through the API.
    const fetched = await ctx.api.get(`/api/orders/${order.id}`).expect(200);
    expect(fetched.body.order).toEqual(order);
  });

  it('ignores any price sent by the client', async () => {
    const tikka = itemByName(ctx, 'Paneer Tikka');
    const res = await ctx.api
      .post('/api/orders')
      .send({
        clientRequestId: requestId(),
        orderType: 'TAKEAWAY',
        subtotalPaise: 1,
        items: [{ menuItemId: tikka.id, quantity: 1, unitPricePaise: 1 }],
      })
      .expect(201);
    expect(res.body.order.subtotalPaise).toBe(24000);
  });

  it('snapshots name and price so later menu changes do not alter old orders', async () => {
    const tikka = itemByName(ctx, 'Paneer Tikka');
    const created = await ctx.api
      .post('/api/orders')
      .send({ clientRequestId: requestId(), orderType: 'TAKEAWAY', items: [{ menuItemId: tikka.id, quantity: 1 }] })
      .expect(201);

    await ctx.api
      .patch(`/api/menu/items/${tikka.id}`)
      
      .send({ name: 'Paneer Tikka Deluxe', pricePaise: 99900 })
      .expect(200);

    const res = await ctx.api.get(`/api/orders/${created.body.order.id}`).expect(200);
    expect(res.body.order.items[0]).toMatchObject({ itemName: 'Paneer Tikka', unitPricePaise: 24000 });
    expect(res.body.order.subtotalPaise).toBe(24000);
  });

  it('merges repeated lines for the same item', async () => {
    const naan = itemByName(ctx, 'Butter Naan');
    const res = await ctx.api
      .post('/api/orders')
      .send({
        clientRequestId: requestId(),
        orderType: 'TAKEAWAY',
        items: [
          { menuItemId: naan.id, quantity: 2 },
          { menuItemId: naan.id, quantity: 3 },
        ],
      })
      .expect(201);
    expect(res.body.order.items).toHaveLength(1);
    expect(res.body.order.items[0].quantity).toBe(5);
  });

  it('generates sequential, unique order numbers per day', async () => {
    const fixed = new Date(2026, 9, 21, 12, 0, 0);
    ctx = setupTestApp({ now: () => fixed });
    const naan = itemByName(ctx, 'Butter Naan');
    const numbers: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await ctx.api
        .post('/api/orders')
        .send({ clientRequestId: requestId(), orderType: 'TAKEAWAY', items: [{ menuItemId: naan.id, quantity: 1 }] })
        .expect(201);
      numbers.push(res.body.order.orderNumber);
    }
    expect(numbers).toEqual(['261021-001', '261021-002', '261021-003']);
  });

  it('restarts the order counter on a new day', async () => {
    let current = new Date(2026, 9, 21, 23, 59);
    ctx = setupTestApp({ now: () => current });
    const naan = itemByName(ctx, 'Butter Naan');
    const send = () =>
      ctx.api
        .post('/api/orders')
        .send({ clientRequestId: requestId(), orderType: 'TAKEAWAY', items: [{ menuItemId: naan.id, quantity: 1 }] });
    expect((await send()).body.order.orderNumber).toBe('261021-001');
    current = new Date(2026, 9, 22, 0, 1);
    expect((await send()).body.order.orderNumber).toBe('261022-001');
  });

  it('does not create a duplicate when the same submission is sent twice', async () => {
    const naan = itemByName(ctx, 'Butter Naan');
    const body = { clientRequestId: requestId(), orderType: 'TAKEAWAY', items: [{ menuItemId: naan.id, quantity: 1 }] };
    const first = await ctx.api.post('/api/orders').send(body).expect(201);
    const second = await ctx.api.post('/api/orders').send(body).expect(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.order.id).toBe(first.body.order.id);
    expect(ctx.db.select().from(orders).all()).toHaveLength(1);
  });

  it('emits an order.created event (used by Socket.IO on Day 2)', async () => {
    const naan = itemByName(ctx, 'Butter Naan');
    const seen: string[] = [];
    ctx.events.on('order.created', (o) => seen.push(o.orderNumber));
    const res = await ctx.api
      .post('/api/orders')
      .send({ clientRequestId: requestId(), orderType: 'TAKEAWAY', items: [{ menuItemId: naan.id, quantity: 1 }] })
      .expect(201);
    expect(seen).toEqual([res.body.order.orderNumber]);
  });

  describe('validation', () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['empty order', { orderType: 'TAKEAWAY', items: [] }, 'at least one item'],
      ['missing items', { orderType: 'TAKEAWAY' }, 'items'],
      ['zero quantity', { orderType: 'TAKEAWAY', items: [{ menuItemId: 1, quantity: 0 }] }, 'at least 1'],
      ['negative quantity', { orderType: 'TAKEAWAY', items: [{ menuItemId: 1, quantity: -2 }] }, 'at least 1'],
      ['fractional quantity', { orderType: 'TAKEAWAY', items: [{ menuItemId: 1, quantity: 1.5 }] }, 'whole number'],
      ['huge quantity', { orderType: 'TAKEAWAY', items: [{ menuItemId: 1, quantity: 1000 }] }, 'at most 99'],
      ['string quantity', { orderType: 'TAKEAWAY', items: [{ menuItemId: 1, quantity: '2' }] }, 'number'],
      ['bad order type', { orderType: 'DELIVERY', items: [{ menuItemId: 1, quantity: 1 }] }, 'DINE_IN or TAKEAWAY'],
      ['table on takeaway', { orderType: 'TAKEAWAY', tableNumber: '5', items: [{ menuItemId: 1, quantity: 1 }] }, 'only allowed for dine-in'],
      ['long notes', { orderType: 'TAKEAWAY', notes: 'x'.repeat(501), items: [{ menuItemId: 1, quantity: 1 }] }, 'at most 500'],
    ];

    it.each(cases)('rejects %s with 400', async (_name, body, message) => {
      const res = await ctx.api
        .post('/api/orders')
        .send({ clientRequestId: requestId(), ...body })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain(message);
      expect(ctx.db.select().from(orders).all()).toHaveLength(0);
    });

    it('rejects merged duplicate lines exceeding the max quantity', async () => {
      const res = await ctx.api
        .post('/api/orders')
        .send({
          clientRequestId: requestId(),
          orderType: 'TAKEAWAY',
          items: [
            { menuItemId: 1, quantity: 60 },
            { menuItemId: 1, quantity: 60 },
          ],
        })
        .expect(400);
      expect(res.body.error.message).toContain('at most 99');
    });

    it('rejects missing clientRequestId', async () => {
      await ctx.api
        .post('/api/orders')
        .send({ orderType: 'TAKEAWAY', items: [{ menuItemId: 1, quantity: 1 }] })
        .expect(400);
    });

    it('rejects malformed JSON', async () => {
      const res = await ctx.api
        .post('/api/orders')
        .set('Content-Type', 'application/json')
        .send('{"items": [')
        .expect(400);
      expect(res.body.error.code).toBe('INVALID_JSON');
    });

    it('rejects unknown menu items', async () => {
      const res = await ctx.api
        .post('/api/orders')
        .send({ clientRequestId: requestId(), orderType: 'TAKEAWAY', items: [{ menuItemId: 99999, quantity: 1 }] })
        .expect(400);
      expect(res.body.error.code).toBe('ITEM_NOT_FOUND');
    });

    it('rejects unavailable items with 409 and creates nothing', async () => {
      const fish = itemByName(ctx, 'Fish Amritsari'); // seeded unavailable
      const naan = itemByName(ctx, 'Butter Naan');
      const res = await ctx.api
        .post('/api/orders')
        .send({
          clientRequestId: requestId(),
          orderType: 'TAKEAWAY',
          items: [
            { menuItemId: naan.id, quantity: 1 },
            { menuItemId: fish.id, quantity: 1 },
          ],
        })
        .expect(409);
      expect(res.body.error.code).toBe('ITEM_UNAVAILABLE');
      expect(res.body.error.details.menuItemIds).toEqual([fish.id]);
      expect(ctx.db.select().from(orders).all()).toHaveLength(0);
      expect(ctx.db.select().from(orderItems).all()).toHaveLength(0);
    });
  });
});

describe('GET /api/orders', () => {
  it('lists saved orders newest first with status, and filters by status', async () => {
    let t = new Date(2026, 9, 21, 10, 0);
    const ctx = setupTestApp({ now: () => t });
    const naan = itemByName(ctx, 'Butter Naan');
    for (let i = 0; i < 2; i++) {
      await ctx.api
        .post('/api/orders')
        .send({ clientRequestId: requestId(), orderType: 'TAKEAWAY', items: [{ menuItemId: naan.id, quantity: 1 }] })
        .expect(201);
      t = new Date(t.getTime() + 60_000);
    }
    const res = await ctx.api.get('/api/orders').expect(200);
    expect(res.body.orders.map((o: { orderNumber: string }) => o.orderNumber)).toEqual(['261021-002', '261021-001']);
    expect(res.body.orders[0].status).toBe('NEW');

    const ready = await ctx.api.get('/api/orders?status=READY').expect(200);
    expect(ready.body.orders).toHaveLength(0);
    await ctx.api.get('/api/orders?status=BOGUS').expect(400);
  });

  it('returns 404 for a missing order and 400 for a bad id', async () => {
    const ctx = setupTestApp();
    await ctx.api.get('/api/orders/12345').expect(404);
    await ctx.api.get('/api/orders/abc').expect(400);
  });
});

describe('server errors', () => {
  it('returns a generic 500 without leaking internals', async () => {
    const ctx = setupTestApp();
    ctx.sqlite.close(); // simulate the database becoming unusable
    const res = await ctx.api.get('/api/orders').expect(500);
    expect(res.body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Something went wrong on the server' });
  });
});

describe('database constraints', () => {
  it('rejects an order item with a non-positive quantity even if the API is bypassed', () => {
    const ctx = setupTestApp();
    const order = ctx.db
      .insert(orders)
      .values({ orderNumber: 'X-1', clientRequestId: 'direct-1', orderType: 'TAKEAWAY', subtotalPaise: 0 })
      .returning()
      .get();
    expect(() =>
      ctx.db
        .insert(orderItems)
        .values({ orderId: order.id, itemName: 'X', unitPricePaise: 100, quantity: 0, lineTotalPaise: 0 })
        .run(),
    ).toThrow(/CHECK constraint/);
  });

  it('rejects a duplicate order number', () => {
    const ctx = setupTestApp();
    const values = { orderNumber: 'X-1', orderType: 'TAKEAWAY' as const, subtotalPaise: 0 };
    ctx.db.insert(orders).values({ ...values, clientRequestId: 'a-1' }).run();
    expect(() => ctx.db.insert(orders).values({ ...values, clientRequestId: 'a-2' }).run()).toThrow(/UNIQUE/);
  });
});

describe('PATCH /api/menu/items/:id', () => {
  it('toggles availability and validates input', async () => {
    const ctx = setupTestApp();
    const naan = itemByName(ctx, 'Butter Naan');
    const patch = (path: string) => ctx.api.patch(path);
    const res = await patch(`/api/menu/items/${naan.id}`).send({ isAvailable: false }).expect(200);
    expect(res.body.item.isAvailable).toBe(false);
    await patch(`/api/menu/items/${naan.id}`).send({ pricePaise: 10.5 }).expect(400);
    await patch(`/api/menu/items/${naan.id}`).send({}).expect(400);
    await patch('/api/menu/items/99999').send({ isAvailable: true }).expect(404);
  });

  it('is Superadmin-only (menu prices are configuration, not a cashier action)', async () => {
    const ctx = setupTestApp();
    const naan = itemByName(ctx, 'Butter Naan');
    await ctx.anon.patch(`/api/menu/items/${naan.id}`).send({ pricePaise: 1 }).expect(401);
    for (const role of ['RECEPTION', 'KITCHEN'] as const) {
      const res = await ctx.as(role).patch(`/api/menu/items/${naan.id}`).send({ pricePaise: 1 }).expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    // The old Day 3 admin-token header grants nothing any more.
    await ctx.anon.patch(`/api/menu/items/${naan.id}`).set('X-Admin-Token', 'anything').send({ pricePaise: 1 }).expect(401);
    expect(itemByName(ctx, 'Butter Naan').pricePaise).toBe(5000);
  });
});
