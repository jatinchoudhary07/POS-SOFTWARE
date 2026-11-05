import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { menuItems, USER_ROLES, type UserRole } from '../src/db/schema';
import { PASSWORDS, requestId, setupTestApp, type Api } from './helpers';

type Ctx = ReturnType<typeof setupTestApp>;

/** An order with a bill and a cash payment, so every endpoint has something real to act on. */
async function fixtures(ctx: Ctx) {
  const tikka = ctx.db.select().from(menuItems).where(eq(menuItems.name, 'Paneer Tikka')).get()!.id;
  const order = (await ctx.api.post('/api/orders').send({ clientRequestId: requestId(), orderType: 'TAKEAWAY', items: [{ menuItemId: tikka, quantity: 1 }] })).body.order;
  await ctx.api.post(`/api/orders/${order.id}/bill`).send({});
  const payment = (
    await ctx.api.post(`/api/orders/${order.id}/payments`).send({ method: 'CASH', idempotencyKey: requestId(), expectedTotalPaise: 24000, tenderedPaise: 24000 })
  ).body.payment;
  const open = (await ctx.api.post('/api/orders').send({ clientRequestId: requestId(), orderType: 'TAKEAWAY', items: [{ menuItemId: tikka, quantity: 1 }] })).body.order;
  return { tikka, orderId: order.id as number, paymentId: payment.id as number, openId: open.id as number };
}
type Fx = Awaited<ReturnType<typeof fixtures>>;

const S: UserRole = 'SUPERADMIN';
const R: UserRole = 'RECEPTION';
const K: UserRole = 'KITCHEN';

// [description, allowed roles, call]
const MATRIX: [string, UserRole[], (api: Api, fx: Fx) => ReturnType<Api['get']>][] = [
  ['GET menu', [S, R], (a) => a.get('/api/menu')],
  ['PATCH menu item', [S], (a, f) => a.patch(`/api/menu/items/${f.tikka}`).send({ isAvailable: true })],
  ['GET orders', [S, R], (a) => a.get('/api/orders')],
  ['GET order', [S, R], (a, f) => a.get(`/api/orders/${f.orderId}`)],
  ['POST order', [S, R], (a, f) => a.post('/api/orders').send({ clientRequestId: requestId(), orderType: 'TAKEAWAY', items: [{ menuItemId: f.tikka, quantity: 1 }] })],
  ['GET kitchen orders', [S, K], (a) => a.get('/api/kitchen/orders')],
  ['PATCH status -> PREPARING', [S, K], (a, f) => a.patch(`/api/orders/${f.openId}/status`).send({ status: 'PREPARING' })],
  ['PATCH status -> COMPLETED (served)', [S, R], (a, f) => a.patch(`/api/orders/${f.openId}/status`).send({ status: 'COMPLETED' })],
  ['GET checkout', [S, R], (a, f) => a.get(`/api/orders/${f.openId}/checkout`)],
  ['POST bill', [S, R], (a, f) => a.post(`/api/orders/${f.openId}/bill`).send({})],
  ['POST bill with discount', [S], (a, f) => a.post(`/api/orders/${f.openId}/bill`).send({ discount: { type: 'PERCENT', bps: 1000, reason: 'Friend' } })],
  ['POST cash payment', [S, R], (a, f) => a.post(`/api/orders/${f.openId}/payments`).send({ method: 'CASH', idempotencyKey: requestId(), expectedTotalPaise: 24000, tenderedPaise: 24000 })],
  ['POST UPI payment', [S, R], (a, f) => a.post(`/api/orders/${f.openId}/payments`).send({ method: 'UPI_MANUAL', idempotencyKey: requestId(), expectedTotalPaise: 24000, outcome: 'SUCCEEDED', manuallyVerified: true })],
  ['GET receipt', [S, R], (a, f) => a.get(`/api/orders/${f.orderId}/receipt`)],
  ['POST refund', [S], (a, f) => a.post(`/api/payments/${f.paymentId}/refund`).send({ reason: 'Test refund', confirmed: true })],
  ['POST resolve payment', [S], (a, f) => a.post(`/api/payments/${f.paymentId}/resolve`).send({ outcome: 'FAILED', note: 'Checked' })],
  ['GET settings', [S, R], (a) => a.get('/api/settings')],
  ['PUT settings', [S], (a) => a.put('/api/settings').send({ restaurantName: 'X', roundToRupee: false, taxes: [] })],
  ["GET today's sales", [S, R], (a) => a.get('/api/reports/daily')],
  ["GET another day's sales", [S], (a) => a.get('/api/reports/daily?date=2020-01-01')],
  ['GET logins', [S], (a) => a.get('/api/auth/accounts')],
  ['PUT login', [S], (a) => a.put('/api/auth/accounts/3').send({ password: 'whatever-1', currentPassword: PASSWORDS.SUPERADMIN })],
  ['GET me', [S, R, K], (a) => a.get('/api/auth/me')],
];

describe('server-side permission matrix', () => {
  for (const [name, allowed, call] of MATRIX) {
    it(`${name}: anonymous 401, allowed ${allowed.join('/')}, others 403`, async () => {
      const ctx = setupTestApp();
      const fx = await fixtures(ctx);
      expect((await call(ctx.anon, fx)).status).toBe(401);
      for (const role of USER_ROLES) {
        // Fresh app per role so one role's change can't affect the next check.
        const c = setupTestApp();
        const f = await fixtures(c);
        const res = await call(c.as(role), f);
        if (allowed.includes(role)) {
          expect([401, 403], `${role} should be allowed: ${JSON.stringify(res.body)}`).not.toContain(res.status);
        } else {
          expect(res.status, `${role} should be forbidden`).toBe(403);
          expect(res.body.error.code).toBe('FORBIDDEN');
        }
      }
    });
  }
});

describe('role-specific rules', () => {
  it('kitchen receives orders without prices or payment data', async () => {
    const ctx = setupTestApp();
    await fixtures(ctx);
    const res = await ctx.as('KITCHEN').get('/api/kitchen/orders').expect(200);
    expect(res.body.orders.length).toBeGreaterThan(0);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/Paise|payment|bill/i);
    expect(res.body.orders[0].items[0]).toEqual({ id: expect.any(Number), itemName: 'Paneer Tikka', quantity: 1, sent: false });
    // ...also in the response to its own status change.
    const upd = await ctx.as('KITCHEN').patch(`/api/orders/${res.body.orders[0].id}/status`).send({ status: 'PREPARING' }).expect(200);
    expect(JSON.stringify(upd.body)).not.toMatch(/Paise|payment/i);
  });

  it('kitchen and reception each move only their own steps of the workflow', async () => {
    const ctx = setupTestApp();
    const { openId } = await fixtures(ctx);
    const set = (role: UserRole, status: string) => ctx.as(role).patch(`/api/orders/${openId}/status`).send({ status });
    await set('RECEPTION', 'PREPARING').expect(403);
    await set('KITCHEN', 'PREPARING').expect(200);
    await set('KITCHEN', 'READY').expect(200);
    await set('KITCHEN', 'COMPLETED').expect(403);
    await set('RECEPTION', 'COMPLETED').expect(200);
    await set('KITCHEN', 'CANCELLED').expect(409); // invalid for everyone -> transition error, not 403
  });

  it('reception can bill and keep an existing discount, but not add, change or remove one', async () => {
    const ctx = setupTestApp();
    const { openId } = await fixtures(ctx);
    const reception = ctx.as('RECEPTION');
    await reception.post(`/api/orders/${openId}/bill`).send({}).expect(200);
    await reception.post(`/api/orders/${openId}/bill`).send({ discount: { type: 'AMOUNT', paise: 1000, reason: 'Friend' } }).expect(403);
    await ctx.api.post(`/api/orders/${openId}/bill`).send({ discount: { type: 'AMOUNT', paise: 1000, reason: 'Friend' } }).expect(200);
    // Re-generating with the same discount (what checkout does on open) is fine...
    const same = await reception.post(`/api/orders/${openId}/bill`).send({ discount: { type: 'AMOUNT', paise: 1000, reason: 'Friend' } }).expect(200);
    expect(same.body.bill.totalPaise).toBe(23000);
    // ...changing or removing it is not.
    await reception.post(`/api/orders/${openId}/bill`).send({ discount: { type: 'AMOUNT', paise: 2000, reason: 'Friend' } }).expect(403);
    await reception.post(`/api/orders/${openId}/bill`).send({ discount: { type: 'NONE' } }).expect(403);
    // And the bill is unchanged; reception can still take payment.
    await reception.post(`/api/orders/${openId}/payments`).send({ method: 'CASH', idempotencyKey: requestId(), expectedTotalPaise: 23000, tenderedPaise: 23000 }).expect(201);
  });

  it('a Day 3 payment taken by reception keeps all financial protections', async () => {
    const ctx = setupTestApp();
    const { openId } = await fixtures(ctx);
    const r = ctx.as('RECEPTION');
    await r.post(`/api/orders/${openId}/bill`).send({});
    const key = requestId();
    await r.post(`/api/orders/${openId}/payments`).send({ method: 'CASH', idempotencyKey: key, expectedTotalPaise: 24000, tenderedPaise: 23999 }).expect(400);
    await r.post(`/api/orders/${openId}/payments`).send({ method: 'CASH', idempotencyKey: key, expectedTotalPaise: 24000, tenderedPaise: 30000 }).expect(201);
    await r.post(`/api/orders/${openId}/payments`).send({ method: 'CASH', idempotencyKey: key, expectedTotalPaise: 24000, tenderedPaise: 30000 }).expect(200);
    await r.post(`/api/orders/${openId}/payments`).send({ method: 'CASH', idempotencyKey: requestId(), expectedTotalPaise: 24000, tenderedPaise: 30000 }).expect(409);
  });
});
