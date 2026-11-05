import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { menuItems } from '../src/db/schema';
import { dayKey } from '../src/services/analyticsService';
import { requestId, setupTestApp } from './helpers';

async function paidOrder(ctx: ReturnType<typeof setupTestApp>, name: string, quantity: number, table?: string) {
  const id = ctx.db.select().from(menuItems).where(eq(menuItems.name, name)).get()!.id;
  const order = (
    await ctx.api.post('/api/orders').send({ clientRequestId: requestId(), orderType: table ? 'DINE_IN' : 'TAKEAWAY', ...(table ? { tableNumber: table } : {}), items: [{ menuItemId: id, quantity }] })
  ).body.order;
  const bill = (await ctx.api.post(`/api/orders/${order.id}/bill`).send({})).body.bill;
  await ctx.api.post(`/api/orders/${order.id}/payments`).send({ method: 'CASH', idempotencyKey: requestId(), expectedTotalPaise: bill.totalPaise, tenderedPaise: bill.totalPaise });
  return { order, total: bill.totalPaise as number };
}

const today = () => dayKey(new Date());

describe('owner analytics', () => {
  it('summarises sales, items, tables and compares with the previous period', async () => {
    const ctx = setupTestApp();
    const a = await paidOrder(ctx, 'Paneer Tikka', 2, '4');
    const b = await paidOrder(ctx, 'Paneer Tikka', 1);
    const res = await ctx.api.get(`/api/reports/analytics?from=${today()}&to=${today()}`);
    expect(res.status).toBe(200);
    const d = res.body.analytics;
    expect(d.days).toBe(1);
    expect(d.totals.paidCount).toBe(2);
    expect(d.totals.netPaise).toBe(a.total + b.total);
    expect(d.totals.avgOrderPaise).toBe(Math.round((a.total + b.total) / 2));
    expect(d.totals.itemsSold).toBe(3);
    expect(d.topItems[0]).toMatchObject({ name: 'Paneer Tikka', quantity: 3 });
    expect(d.byTable).toEqual([{ table: '4', count: 1, totalPaise: a.total }]);
    expect(d.byType.TAKEAWAY.count).toBe(1);
    expect(d.byMethod.CASH.count).toBe(2);
    expect(d.byDay).toHaveLength(1);
    expect(d.byDay[0].netPaise).toBe(a.total + b.total);
    expect(d.byHour.reduce((s: number, h: { count: number }) => s + h.count, 0)).toBe(2);
    expect(d.previous.netPaise).toBe(0);
  });

  it('refunds reduce net sales and the order history is searchable', async () => {
    const ctx = setupTestApp();
    const a = await paidOrder(ctx, 'Paneer Tikka', 1);
    const pay = (await ctx.api.get(`/api/orders/${a.order.id}/checkout`)).body.payments[0];
    await ctx.api.post(`/api/payments/${pay.id}/refund`).send({ reason: 'customer left', confirmed: true });
    const d = (await ctx.api.get(`/api/reports/analytics?from=${today()}&to=${today()}`)).body.analytics;
    expect(d.totals.refundPaise).toBe(a.total);
    expect(d.totals.netPaise).toBe(0);

    const h = (await ctx.api.get(`/api/reports/history?from=${today()}&to=${today()}&q=tikka`)).body;
    expect(h.total).toBe(1);
    expect(h.rows[0]).toMatchObject({ orderNumber: a.order.orderNumber, paymentStatus: 'REFUNDED', itemCount: 1 });
    expect((await ctx.api.get(`/api/reports/history?from=${today()}&to=${today()}&q=nomatch`)).body.total).toBe(0);
    expect((await ctx.api.get(`/api/reports/history?from=${today()}&to=${today()}&payment=PAID`)).body.total).toBe(0);
  });

  it('is Superadmin only and validates the range', async () => {
    const ctx = setupTestApp();
    expect((await ctx.as('RECEPTION').get(`/api/reports/analytics?from=${today()}&to=${today()}`)).status).toBe(403);
    expect((await ctx.as('RECEPTION').get(`/api/reports/history?from=${today()}&to=${today()}`)).status).toBe(403);
    expect((await ctx.as('RECEPTION').get('/api/reports/daily')).status).toBe(200);
    expect((await ctx.api.get('/api/reports/analytics?from=2026-02-31&to=2026-03-01')).status).toBe(400);
    expect((await ctx.api.get('/api/reports/analytics?from=2026-03-05&to=2026-03-01')).status).toBe(400);
    expect((await ctx.api.get('/api/reports/analytics?from=2020-01-01&to=2026-03-01')).status).toBe(400);
  });
});
