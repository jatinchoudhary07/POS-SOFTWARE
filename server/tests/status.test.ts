import request from 'supertest';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { orders, type OrderStatus } from '../src/db/schema';
import { requestId, setupTestApp } from './helpers';

type Ctx = ReturnType<typeof setupTestApp>;

async function createOrder(ctx: Ctx) {
  const res = await ctx.api
    .post('/api/orders')
    .send({ clientRequestId: requestId(), orderType: 'DINE_IN', tableNumber: '3', items: [{ menuItemId: 1, quantity: 2 }] })
    .expect(201);
  return res.body.order as { id: number; orderNumber: string; status: OrderStatus; subtotalPaise: number };
}

const setStatus = (ctx: Ctx, id: number | string, status: unknown) =>
  ctx.api.patch(`/api/orders/${id}/status`).send({ status });

const dbStatus = (ctx: Ctx, id: number) => ctx.db.select().from(orders).where(eq(orders.id, id)).get()?.status;

describe('PATCH /api/orders/:id/status', () => {
  let ctx: Ctx;
  let updates: { id: number; status: string }[];
  beforeEach(() => {
    ctx = setupTestApp();
    updates = [];
    ctx.events.on('order.updated', (o) => updates.push({ id: o.id, status: o.status }));
  });

  it('walks the full workflow NEW -> PREPARING -> READY -> COMPLETED and persists each step', async () => {
    const order = await createOrder(ctx);
    expect(order.status).toBe('NEW');
    for (const status of ['PREPARING', 'READY', 'COMPLETED'] as const) {
      const res = await setStatus(ctx, order.id, status).expect(200);
      expect(res.body.changed).toBe(true);
      expect(res.body.order.status).toBe(status);
      expect(dbStatus(ctx, order.id)).toBe(status);
    }
    expect(updates).toEqual([
      { id: order.id, status: 'PREPARING' },
      { id: order.id, status: 'READY' },
      { id: order.id, status: 'COMPLETED' },
    ]);
  });

  it('bumps updatedAt but never changes items, totals or creation time', async () => {
    const order = await createOrder(ctx);
    const before = (await ctx.api.get(`/api/orders/${order.id}`)).body.order;
    await new Promise((r) => setTimeout(r, 5));
    const after = (await setStatus(ctx, order.id, 'PREPARING').expect(200)).body.order;
    // the kitchen taking the order marks its lines as sent; nothing else about them changes
    expect(after.items).toEqual(before.items.map((i: object) => ({ ...i, sentToKitchen: true })));
    expect(after.subtotalPaise).toBe(before.subtotalPaise);
    expect(after.createdAt).toBe(before.createdAt);
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
  });

  it('treats a repeated request as a no-op: 200, changed=false, no second event', async () => {
    const order = await createOrder(ctx);
    await setStatus(ctx, order.id, 'PREPARING').expect(200);
    const again = await setStatus(ctx, order.id, 'PREPARING').expect(200);
    expect(again.body.changed).toBe(false);
    expect(again.body.order.status).toBe('PREPARING');
    expect(updates).toHaveLength(1);
    expect(ctx.db.select().from(orders).all()).toHaveLength(1);
  });

  it.each([
    ['NEW', 'READY'],
    ['NEW', 'COMPLETED'],
    ['NEW', 'CANCELLED'],
    ['PREPARING', 'NEW'],
    ['PREPARING', 'COMPLETED'],
    ['READY', 'PREPARING'],
    ['COMPLETED', 'READY'],
  ] as const)('rejects %s -> %s with 409 and leaves the order untouched', async (from, to) => {
    const order = await createOrder(ctx);
    const path: Record<string, string[]> = {
      NEW: [],
      PREPARING: ['PREPARING'],
      READY: ['PREPARING', 'READY'],
      COMPLETED: ['PREPARING', 'READY', 'COMPLETED'],
    };
    for (const step of path[from]) await setStatus(ctx, order.id, step).expect(200);
    updates = [];

    const res = await setStatus(ctx, order.id, to).expect(409);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
    expect(res.body.error.message).toContain(`#${order.orderNumber}`);
    expect(res.body.error.details).toEqual({ currentStatus: from, requestedStatus: to });
    expect(dbStatus(ctx, order.id)).toBe(from);
    expect(updates).toHaveLength(0);
  });

  it('validates the id and body strictly', async () => {
    const order = await createOrder(ctx);
    await setStatus(ctx, 99999, 'PREPARING').expect(404);
    await setStatus(ctx, 'abc', 'PREPARING').expect(400);
    await setStatus(ctx, order.id, 'DONE').expect(400);
    await setStatus(ctx, order.id, undefined).expect(400);
    // Extra fields (e.g. trying to change the total) are rejected, not ignored.
    const res = await ctx.api
      .patch(`/api/orders/${order.id}/status`)
      .send({ status: 'PREPARING', subtotalPaise: 1 })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(dbStatus(ctx, order.id)).toBe('NEW');
  });

  it('keeps orders independent of each other', async () => {
    const a = await createOrder(ctx);
    const b = await createOrder(ctx);
    await setStatus(ctx, a.id, 'PREPARING').expect(200);
    expect(dbStatus(ctx, a.id)).toBe('PREPARING');
    expect(dbStatus(ctx, b.id)).toBe('NEW');
  });
});

describe('GET /api/orders?status= (kitchen snapshot)', () => {
  it('accepts a comma-separated list of statuses and still accepts a single one', async () => {
    const ctx = setupTestApp();
    const a = await createOrder(ctx);
    const b = await createOrder(ctx);
    const c = await createOrder(ctx);
    await setStatus(ctx, b.id, 'PREPARING');
    for (const s of ['PREPARING', 'READY', 'COMPLETED']) await setStatus(ctx, c.id, s);

    const active = await ctx.api.get('/api/orders?status=NEW,PREPARING,READY&limit=200').expect(200);
    expect(active.body.orders.map((o: { id: number }) => o.id).sort()).toEqual([a.id, b.id].sort());

    const served = await ctx.api.get('/api/orders?status=COMPLETED').expect(200);
    expect(served.body.orders.map((o: { id: number }) => o.id)).toEqual([c.id]);

    await ctx.api.get('/api/orders?status=NEW,BOGUS').expect(400);
  });
});
