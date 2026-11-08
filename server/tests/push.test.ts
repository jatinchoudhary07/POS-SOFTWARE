import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { pushSubscriptions } from '../src/db/schema';
import { alertPayload } from '../src/services/pushService';
import { PASSWORDS, requestId, setupTestApp, USERNAMES } from './helpers';

type Sub = { endpoint: string; keys: { p256dh: string; auth: string } };
const sub = (name: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } });

/** An app whose "push service" is a recorder: nothing goes over the internet. */
function setup() {
  const sent: { endpoint: string; payload: Record<string, string> }[] = [];
  const send = vi.fn(async (s: Sub, payload: string) => {
    sent.push({ endpoint: s.endpoint, payload: JSON.parse(payload) });
  });
  const ctx = setupTestApp({ push: { send } });
  return { ctx, sent, send };
}
const endpointsOf = (sent: { endpoint: string }[]) => sent.map((s) => s.endpoint.split('/').pop()).sort();
// Alerts are sent without waiting for the request that caused them, so give them a moment.
const settle = () => new Promise((r) => setTimeout(r, 30));

async function placeOrder(ctx: ReturnType<typeof setup>['ctx']) {
  const menu = (await ctx.api.get('/api/menu')).body.categories[0].items[0];
  const res = await ctx.api.post('/api/orders').send({ clientRequestId: requestId(), orderType: 'TAKEAWAY', items: [{ menuItemId: menu.id, quantity: 2 }] }).expect(201);
  return res.body.order as { id: number };
}

describe('alerts for locked phones (push)', () => {
  it('needs a login and only accepts real push service addresses', async () => {
    const { ctx } = setup();
    await ctx.anon.get('/api/push/key').expect(401);
    await ctx.anon.post('/api/push/subscribe').send(sub('x')).expect(401);
    expect((await ctx.as('KITCHEN').get('/api/push/key').expect(200)).body.enabled).toBe(true);
    await ctx.as('KITCHEN').post('/api/push/subscribe').send({ endpoint: 'https://evil.example.com/steal', keys: sub('x').keys }).expect(400);
    await ctx.as('KITCHEN').post('/api/push/subscribe').send({ endpoint: 'http://fcm.googleapis.com/x', keys: sub('x').keys }).expect(400);
    await ctx.as('KITCHEN').post('/api/push/subscribe').send({ endpoint: 'https://127.0.0.1/internal', keys: sub('x').keys }).expect(400);
    await ctx.as('KITCHEN').post('/api/push/subscribe').send(sub('chef-phone')).expect(201);
  });

  it('is switched off when the server has no keys', async () => {
    const ctx = setupTestApp();
    const res = await ctx.as('KITCHEN').get('/api/push/key').expect(200);
    expect(res.body).toEqual({ enabled: false, publicKey: '' });
  });

  it('tells the kitchen about new food, and reception and the owner when it is ready - never the wrong people', async () => {
    const { ctx, sent } = setup();
    await ctx.as('KITCHEN').post('/api/push/subscribe').send(sub('chef-phone')).expect(201);
    await ctx.as('RECEPTION').post('/api/push/subscribe').send(sub('front-phone')).expect(201);
    await ctx.as('SUPERADMIN').post('/api/push/subscribe').send(sub('owner-phone')).expect(201);

    const order = await placeOrder(ctx);
    await settle();
    expect(endpointsOf(sent)).toEqual(['chef-phone']);
    expect(sent[0].payload).toMatchObject({ kind: 'NEW_ORDER', url: '/kitchen' });
    expect(sent[0].payload.title).toMatch(/^New order #\d+/);
    sent.length = 0;

    // the kitchen starting to cook is nobody's alert
    await ctx.as('KITCHEN').patch(`/api/orders/${order.id}/status`).send({ status: 'PREPARING' }).expect(200);
    await settle();
    expect(sent).toHaveLength(0);

    // "prepared": reception and the owner hear it, the kitchen does not
    await ctx.as('KITCHEN').patch(`/api/orders/${order.id}/status`).send({ status: 'READY' }).expect(200);
    await settle();
    expect(endpointsOf(sent)).toEqual(['front-phone', 'owner-phone']);
    expect(sent[0].payload).toMatchObject({ kind: 'READY', url: '/orders' });
    expect(sent[0].payload.title).toMatch(/is ready/);
  });

  it('tells the kitchen when more items are added to a table, and when an order is cancelled', async () => {
    const { ctx, sent } = setup();
    await ctx.as('KITCHEN').post('/api/push/subscribe').send(sub('chef-phone')).expect(201);
    const table = (await ctx.api.post('/api/tables').send({ name: 'T9' }).expect(201)).body.table;
    const item = (await ctx.api.get('/api/menu')).body.categories[0].items[0];
    const dineIn = () => ctx.api.post('/api/orders').send({ clientRequestId: requestId(), orderType: 'DINE_IN', tableId: table.id, items: [{ menuItemId: item.id, quantity: 1 }] }).expect(201);

    const first = (await dineIn()).body.order;
    await settle();
    expect(sent.map((s) => s.payload.kind)).toEqual(['NEW_ORDER']);
    await dineIn(); // the same table orders again: added to the running order
    await settle();
    expect(sent.map((s) => s.payload.kind)).toEqual(['NEW_ORDER', 'ITEMS_ADDED']);
    await ctx.api.post(`/api/orders/${first.id}/cancel`).send({ reason: 'Customer left' }).expect(200);
    await settle();
    expect(sent.map((s) => s.payload.kind)).toEqual(['NEW_ORDER', 'ITEMS_ADDED', 'CANCELLED']);
    expect(sent[2].payload.body).toBe('Stop preparing it.');
  });

  it('never puts money in the alerts (kitchen phones get them too)', async () => {
    const { ctx, sent } = setup();
    await ctx.as('KITCHEN').post('/api/push/subscribe').send(sub('chef-phone')).expect(201);
    await placeOrder(ctx);
    await settle();
    const text = JSON.stringify(sent[0].payload);
    expect(text).not.toMatch(/₹|paise|price|total/i);
  });

  it('stops alerts to a phone as soon as that login signs out', async () => {
    const { ctx, sent } = setup();
    await ctx.as('KITCHEN').post('/api/push/subscribe').send(sub('chef-phone')).expect(201);
    await placeOrder(ctx);
    await settle();
    expect(sent).toHaveLength(1);

    await ctx.as('KITCHEN').post('/api/auth/logout').expect(200);
    expect(ctx.db.select().from(pushSubscriptions).all()).toHaveLength(0);
    sent.length = 0;
    await placeOrder(ctx);
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('stops alerts when the owner changes or turns off that login', async () => {
    const { ctx, sent } = setup();
    await ctx.as('KITCHEN').post('/api/push/subscribe').send(sub('chef-phone')).expect(201);
    const kitchenId = ctx.db.select().from((await import('../src/db/schema')).users).where(eq((await import('../src/db/schema')).users.username, USERNAMES.KITCHEN)).get()!.id;
    await ctx.api.put(`/api/auth/accounts/${kitchenId}`).send({ isActive: false, currentPassword: PASSWORDS.SUPERADMIN }).expect(200);
    expect(ctx.db.select().from(pushSubscriptions).all()).toHaveLength(0);
    await placeOrder(ctx);
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('lets a person mute (unsubscribe) their own phone only', async () => {
    const { ctx, sent } = setup();
    await ctx.as('KITCHEN').post('/api/push/subscribe').send(sub('chef-phone')).expect(201);
    await ctx.as('RECEPTION').post('/api/push/subscribe').send(sub('front-phone')).expect(201);
    // reception cannot remove the kitchen's phone
    await ctx.as('RECEPTION').post('/api/push/unsubscribe').send({ endpoint: sub('chef-phone').endpoint }).expect(200);
    expect(ctx.db.select().from(pushSubscriptions).all()).toHaveLength(2);
    await ctx.as('KITCHEN').post('/api/push/unsubscribe').send({ endpoint: sub('chef-phone').endpoint }).expect(200);
    expect(ctx.db.select().from(pushSubscriptions).all()).toHaveLength(1);
    await placeOrder(ctx);
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('forgets a phone the push service says is gone (410) and renews one that subscribes again', async () => {
    const sent: string[] = [];
    const send = vi.fn(async (s: Sub) => {
      sent.push(s.endpoint);
      throw Object.assign(new Error('gone'), { statusCode: 410 });
    });
    const ctx = setupTestApp({ push: { send } });
    await ctx.as('KITCHEN').post('/api/push/subscribe').send(sub('chef-phone')).expect(201);
    await ctx.as('KITCHEN').post('/api/push/subscribe').send(sub('chef-phone')).expect(201); // same phone again: one row
    expect(ctx.db.select().from(pushSubscriptions).all()).toHaveLength(1);
    await placeOrder(ctx as unknown as ReturnType<typeof setup>['ctx']);
    await settle();
    expect(sent).toHaveLength(1);
    expect(ctx.db.select().from(pushSubscriptions).all()).toHaveLength(0);
  });

  it('does not alert a phone whose subscription has lapsed', async () => {
    const { ctx, sent } = setup();
    await ctx.as('KITCHEN').post('/api/push/subscribe').send(sub('chef-phone')).expect(201);
    ctx.db.update(pushSubscriptions).set({ expiresAt: new Date(Date.now() - 1000) }).run();
    await placeOrder(ctx);
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('sends a test alert to the person\'s own phone only', async () => {
    const { ctx, sent } = setup();
    await ctx.as('KITCHEN').post('/api/push/subscribe').send(sub('chef-phone')).expect(201);
    await ctx.as('RECEPTION').post('/api/push/subscribe').send(sub('front-phone')).expect(201);
    const res = await ctx.as('RECEPTION').post('/api/push/test').expect(200);
    expect(res.body.sentTo).toBe(1);
    expect(endpointsOf(sent)).toEqual(['front-phone']);
    expect(sent[0].payload.kind).toBe('TEST');
  });

  it('builds readable alert text', () => {
    const order = { id: 7, orderNumber: '261108-012', orderType: 'DINE_IN', tableNumber: 'T1', items: [{ quantity: 2, itemName: 'Tea' }, { quantity: 1, itemName: 'Pizza' }, { quantity: 1, itemName: 'Fries' }, { quantity: 4, itemName: 'Coke' }] } as never;
    expect(alertPayload('NEW_ORDER', order)).toMatchObject({ title: 'New order #012 · Table T1', body: '2× Tea, 1× Pizza, 1× Fries +1 more', tag: 'order-7' });
    expect(alertPayload('READY', order).title).toBe('Order #012 · Table T1 is ready');
  });
});
