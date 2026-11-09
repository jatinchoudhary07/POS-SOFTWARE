import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { menuItems, sessions, type UserRole } from '../src/db/schema';
import { attachRealtime } from '../src/realtime';
import type { OrderDTO } from '../src/services/orderService';
import { PASSWORDS, requestId, setupTestApp, USERNAMES } from './helpers';

/** A real HTTP server on a random port with Socket.IO attached, like src/index.ts. */
async function startServer(opts: { sessionCheckMs?: number } = {}) {
  const ctx = setupTestApp();
  const server = http.createServer(ctx.app);
  const realtime = attachRealtime(server, ctx.events, ctx.auth, { corsOrigins: [], ...opts });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const tikka = ctx.db.select().from(menuItems).where(eq(menuItems.name, 'Paneer Tikka')).get()!.id;

  const api = async (method: string, path: string, body?: unknown, role: UserRole | null = 'SUPERADMIN') => {
    const res = await fetch(url + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(role ? { Cookie: ctx.cookies[role] } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  const createOrder = async (clientRequestId = requestId()) =>
    (await api('POST', '/api/orders', { clientRequestId, orderType: 'TAKEAWAY', items: [{ menuItemId: tikka, quantity: 1 }] }, 'RECEPTION'))
      .body.order as OrderDTO;

  const close = async () => {
    await realtime.close();
    ctx.sqlite.close();
  };
  return { url, api, createOrder, close, ctx };
}

type Srv = Awaited<ReturnType<typeof startServer>>;
let srv: Srv | undefined;
const sockets: Socket[] = [];

afterEach(async () => {
  sockets.splice(0).forEach((s) => s.disconnect());
  await srv?.close();
  srv = undefined;
});

function client(url: string, cookie: string | null, opts: Parameters<typeof connect>[1] = {}) {
  const s = connect(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnectionDelay: 50,
    extraHeaders: cookie ? { Cookie: cookie } : {},
    ...opts,
  });
  sockets.push(s);
  return s;
}
const as = (role: UserRole, opts: Parameters<typeof connect>[1] = {}) => client(srv!.url, srv!.ctx.cookies[role], opts);
const connected = (s: Socket) =>
  new Promise<void>((resolve, reject) => {
    if (s.connected) return resolve();
    s.once('connect', () => resolve());
    s.once('connect_error', reject);
  });
const disconnected = (s: Socket) => new Promise<string>((resolve) => s.once('disconnect', (reason) => resolve(reason)));
/** Collects events of one name so tests can assert on exact counts. */
function collect(s: Socket, event: 'order.created' | 'order.updated') {
  const seen: Record<string, unknown>[] = [];
  s.on(event, (p: { order: Record<string, unknown> }) => seen.push(p.order));
  return seen;
}
const waitFor = async (cond: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const settle = () => new Promise((r) => setTimeout(r, 150));

describe('Socket.IO real-time updates', () => {
  it('delivers order.created to every signed-in screen with the server-side order data', async () => {
    srv = await startServer();
    const kitchen = as('KITCHEN');
    const reception = as('RECEPTION');
    await Promise.all([connected(kitchen), connected(reception)]);
    const kSeen = collect(kitchen, 'order.created');
    const rSeen = collect(reception, 'order.created');

    const order = await srv.createOrder();
    await waitFor(() => kSeen.length === 1 && rSeen.length === 1);
    expect(rSeen[0]).toEqual(order);
    expect(rSeen[0].subtotalPaise).toBe(24000); // price from the DB
    expect(kSeen[0].orderNumber).toBe(order.orderNumber);
  });

  it('emits exactly one event per mutation (duplicate submissions and repeated status requests emit nothing)', async () => {
    srv = await startServer();
    const s = as('SUPERADMIN');
    await connected(s);
    const created = collect(s, 'order.created');
    const updated = collect(s, 'order.updated');

    const id = requestId();
    const order = await srv.createOrder(id);
    await srv.createOrder(id); // same clientRequestId -> duplicate
    await srv.api('PATCH', `/api/orders/${order.id}/status`, { status: 'PREPARING' }, 'KITCHEN');
    await srv.api('PATCH', `/api/orders/${order.id}/status`, { status: 'PREPARING' }, 'KITCHEN'); // repeat
    await srv.api('PATCH', `/api/orders/${order.id}/status`, { status: 'COMPLETED' }, 'RECEPTION'); // invalid move
    await settle();

    expect(created).toHaveLength(1);
    expect(updated.map((o) => o.status)).toEqual(['PREPARING']);
  });

  it('broadcasts each status change so reception sees what the kitchen did', async () => {
    srv = await startServer();
    const reception = as('RECEPTION');
    await connected(reception);
    const updated = collect(reception, 'order.updated');
    const order = await srv.createOrder();

    expect((await srv.api('PATCH', `/api/orders/${order.id}/status`, { status: 'PREPARING' }, 'KITCHEN')).status).toBe(200);
    expect((await srv.api('PATCH', `/api/orders/${order.id}/status`, { status: 'READY' }, 'KITCHEN')).status).toBe(200);
    expect((await srv.api('PATCH', `/api/orders/${order.id}/status`, { status: 'COMPLETED' }, 'RECEPTION')).status).toBe(200);
    await waitFor(() => updated.length === 3);
    expect(updated.map((o) => o.status)).toEqual(['PREPARING', 'READY', 'COMPLETED']);
    const persisted = await srv.api('GET', `/api/orders/${order.id}`);
    expect(updated[2]).toEqual(persisted.body.order);
  });

  it('ignores events sent by clients — sockets cannot change data', async () => {
    srv = await startServer();
    const order = await srv.createOrder();
    const attacker = as('KITCHEN');
    await connected(attacker);
    const echoes = collect(attacker, 'order.updated');
    attacker.emit('order.updated', { order: { ...order, status: 'COMPLETED', subtotalPaise: 1 } });
    attacker.emit('updateStatus', { id: order.id, status: 'COMPLETED' });
    await settle();

    const res = await srv.api('GET', `/api/orders/${order.id}`);
    expect(res.body.order.status).toBe('NEW');
    expect(res.body.order.subtotalPaise).toBe(24000);
    expect(echoes).toHaveLength(0);
  });

  it('a reconnecting screen recovers missed changes from the REST snapshot', async () => {
    srv = await startServer();
    const kitchen = as('KITCHEN');
    await connected(kitchen);
    const a = await srv.createOrder();

    kitchen.disconnect();
    const b = await srv.createOrder();
    await srv.api('PATCH', `/api/orders/${a.id}/status`, { status: 'PREPARING' }, 'KITCHEN');
    const missed = collect(kitchen, 'order.created');

    kitchen.connect();
    await connected(kitchen);
    await settle();
    expect(missed).toHaveLength(0); // events are not replayed...

    // ...so the client re-fetches its snapshot on every (re)connect.
    const snap = await srv.api('GET', '/api/kitchen/orders', undefined, 'KITCHEN');
    const byId = new Map(snap.body.orders.map((o: OrderDTO) => [o.id, o.status]));
    expect(byId.get(a.id)).toBe('PREPARING');
    expect(byId.get(b.id)).toBe('NEW');

    const live = collect(kitchen, 'order.updated');
    await srv.api('PATCH', `/api/orders/${b.id}/status`, { status: 'PREPARING' }, 'KITCHEN');
    await waitFor(() => live.length === 1);
  });

  it('rejects socket connections from a foreign website origin but allows same-origin ones', async () => {
    srv = await startServer();
    const host = new URL(srv.url).host;
    const foreign = as('SUPERADMIN', { extraHeaders: { Cookie: srv.ctx.cookies.SUPERADMIN, Origin: 'http://evil.example' }, reconnection: false });
    await expect(connected(foreign)).rejects.toBeTruthy();
    const same = as('SUPERADMIN', { extraHeaders: { Cookie: srv.ctx.cookies.SUPERADMIN, Origin: `http://${host}` } });
    await connected(same);
    expect(same.connected).toBe(true);
  });
});

describe('Socket.IO authentication and rooms', () => {
  it('refuses connections without a valid session', async () => {
    srv = await startServer();
    const anon = client(srv.url, null, { reconnection: false });
    await expect(connected(anon)).rejects.toThrow('UNAUTHENTICATED');
    const forged = client(srv.url, 'pos_session=made-up-token', { reconnection: false });
    await expect(connected(forged)).rejects.toThrow('UNAUTHENTICATED');
    // A client-supplied role means nothing.
    const claimsRole = client(srv.url, null, { reconnection: false, auth: { role: 'SUPERADMIN' }, query: { role: 'SUPERADMIN' } });
    await expect(connected(claimsRole)).rejects.toThrow('UNAUTHENTICATED');
  });

  it('kitchen gets only kitchen data (no prices, no payment status) and no billing/payment events', async () => {
    srv = await startServer();
    const kitchen = as('KITCHEN');
    const staff = as('RECEPTION');
    await Promise.all([connected(kitchen), connected(staff)]);
    const kCreated = collect(kitchen, 'order.created');
    const kUpdated = collect(kitchen, 'order.updated');
    const sUpdated = collect(staff, 'order.updated');

    const order = await srv.createOrder();
    await waitFor(() => kCreated.length === 1);
    expect(Object.keys(kCreated[0]).sort()).toEqual(
      ['createdAt', 'id', 'itemCount', 'items', 'notes', 'orderNumber', 'orderType', 'status', 'tableNumber', 'updatedAt'].sort(),
    );
    expect(kCreated[0].items).toEqual([{ id: expect.any(Number), itemName: 'Paneer Tikka', quantity: 1, sent: false, packed: false }]);
    expect(JSON.stringify(kCreated[0])).not.toMatch(/Paise|payment/i);

    // Billing + payment: staff are told, the kitchen is not.
    await srv.api('POST', `/api/orders/${order.id}/bill`, {}, 'RECEPTION');
    await srv.api('POST', `/api/orders/${order.id}/payments`, { method: 'CASH', idempotencyKey: requestId(), expectedTotalPaise: 24000, tenderedPaise: 24000 }, 'RECEPTION');
    await waitFor(() => sUpdated.some((o) => o.paymentStatus === 'PAID'));
    await settle();
    expect(kUpdated).toHaveLength(0);

    // A kitchen status change reaches the kitchen, still without prices.
    await srv.api('PATCH', `/api/orders/${order.id}/status`, { status: 'PREPARING' }, 'KITCHEN');
    await waitFor(() => kUpdated.length === 1);
    expect(kUpdated[0].status).toBe('PREPARING');
    expect(JSON.stringify(kUpdated[0])).not.toMatch(/Paise|payment/i);
  });

  it('disconnects a screen when its session is logged out', async () => {
    srv = await startServer();
    // A real login, so the cookie comes from the server.
    const login = await srv.api('POST', '/api/auth/login', { username: USERNAMES.KITCHEN, password: PASSWORDS.KITCHEN }, null);
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const s = client(srv.url, cookie, { reconnection: false });
    await connected(s);
    const gone = disconnected(s);
    await fetch(srv.url + '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } });
    expect(await gone).toBe('io server disconnect');
    const again = client(srv.url, cookie, { reconnection: false });
    await expect(connected(again)).rejects.toThrow('UNAUTHENTICATED');
  });

  it("disconnects a login's screens when the Superadmin changes its password", async () => {
    srv = await startServer();
    const kitchen = as('KITCHEN', { reconnection: false });
    const owner = as('SUPERADMIN', { reconnection: false });
    await Promise.all([connected(kitchen), connected(owner)]);
    const gone = disconnected(kitchen);
    const res = await srv.api('PUT', '/api/auth/accounts/3', { password: 'new-kitchen-pass', currentPassword: PASSWORDS.SUPERADMIN });
    expect(res.status).toBe(200);
    expect(await gone).toBe('io server disconnect');
    await settle();
    expect(owner.connected).toBe(true); // other logins are unaffected
  });

  it('disconnects screens whose session has expired', async () => {
    srv = await startServer({ sessionCheckMs: 50 });
    const s = as('RECEPTION', { reconnection: false });
    await connected(s);
    const gone = disconnected(s);
    srv.ctx.db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).run();
    expect(await gone).toBe('io server disconnect');
  });
});
