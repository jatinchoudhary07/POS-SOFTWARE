import { and, eq, gt, inArray, ne } from 'drizzle-orm';
import * as webpush from 'web-push';
import type { DB } from '../db/client';
import { pushSubscriptions, users, type UserRole } from '../db/schema';
import type { EventBus, OrderAlertKind } from '../events';
import type { OrderDTO } from './orderService';

export interface PushOptions {
  /** VAPID keys (see `npx web-push generate-vapid-keys`). Without them alerts for locked phones are switched off. */
  publicKey?: string;
  privateKey?: string;
  /** A https:// address or mailto: that identifies this server to the phone makers' push services. */
  subject?: string;
  /** How long a phone stays subscribed without opening the app again. */
  validMs?: number;
  now?: () => Date;
  /** Replaceable in tests so nothing goes over the internet. */
  send?: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<unknown>;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Same tag = the newer alert replaces the older one for that order. */
  tag: string;
  kind: OrderAlertKind | 'TEST';
  orderId?: number;
  url: string;
}

const place = (o: OrderDTO) => (o.tableNumber ? `Table ${o.tableNumber}` : o.orderType === 'DINE_IN' ? 'Dine-in' : 'Packing');
const shortNumber = (o: OrderDTO) => o.orderNumber.split('-').pop() ?? o.orderNumber;
const itemsLine = (o: OrderDTO) =>
  o.items
    .slice(0, 3)
    .map((i) => `${i.quantity}× ${i.itemName}`)
    .join(', ') + (o.items.length > 3 ? ` +${o.items.length - 3} more` : '');

/** Who hears what: the kitchen about food to cook, the front desk and owner about food that is ready. */
const AUDIENCE: Record<OrderAlertKind, UserRole[]> = {
  NEW_ORDER: ['KITCHEN'],
  ITEMS_ADDED: ['KITCHEN'],
  CHANGED: ['KITCHEN'],
  CANCELLED: ['KITCHEN'],
  READY: ['RECEPTION', 'SUPERADMIN'],
};

/** The words of each alert. Never includes prices: kitchen phones receive these too. */
export function alertPayload(kind: OrderAlertKind, order: OrderDTO): PushPayload {
  const where = `#${shortNumber(order)} · ${place(order)}`;
  const base = { tag: `order-${order.id}`, kind, orderId: order.id };
  switch (kind) {
    case 'NEW_ORDER':
      return { ...base, title: `New order ${where}`, body: itemsLine(order), url: '/kitchen' };
    case 'ITEMS_ADDED':
      return { ...base, title: `More items added to ${where}`, body: itemsLine(order), url: '/kitchen' };
    case 'CHANGED':
      return { ...base, title: `Order ${where} was changed`, body: itemsLine(order), url: '/kitchen' };
    case 'CANCELLED':
      return { ...base, title: `Order ${where} cancelled`, body: 'Stop preparing it.', url: '/kitchen' };
    case 'READY':
      return { ...base, title: `Order ${where} is ready`, body: order.items.length ? itemsLine(order) : 'Ready to serve', url: '/orders' };
  }
}

export function createPushService(db: DB, events: EventBus, opts: PushOptions = {}) {
  const now = opts.now ?? (() => new Date());
  const validMs = opts.validMs ?? 7 * 24 * 60 * 60_000;
  const enabled = !!(opts.publicKey && opts.privateKey) || !!opts.send;

  let send = opts.send;
  if (!send && opts.publicKey && opts.privateKey) {
    webpush.setVapidDetails(opts.subject || 'https://localhost', opts.publicKey, opts.privateKey);
    send = (sub, payload) => webpush.sendNotification(sub, payload, { TTL: 600, urgency: 'high' });
  }

  async function deliver(rows: { id: number; endpoint: string; p256dh: string; auth: string }[], payload: PushPayload) {
    if (!send || rows.length === 0) return;
    const text = JSON.stringify(payload);
    await Promise.allSettled(
      rows.map(async (r) => {
        try {
          await send!({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, text);
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          // The phone has removed this subscription (app deleted, permission withdrawn): forget it.
          if (status === 404 || status === 410) db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, r.id)).run();
          else console.warn(`Push to one device failed${status ? ` (${status})` : ''}: ${(e as Error).message}`);
        }
      }),
    );
  }

  async function sendToRoles(roles: UserRole[], payload: PushPayload) {
    const rows = db
      .select({ id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint, p256dh: pushSubscriptions.p256dh, auth: pushSubscriptions.auth })
      .from(pushSubscriptions)
      .innerJoin(users, eq(users.id, pushSubscriptions.userId))
      .where(and(inArray(users.role, roles), eq(users.isActive, true), gt(pushSubscriptions.expiresAt, now())))
      .all();
    await deliver(rows, payload);
  }

  const service = {
    enabled,
    publicKey: opts.publicKey ?? '',

    /** Remembers (or renews) a device for this sign-in. */
    async subscribe(input: { userId: number; sessionId: string; endpoint: string; p256dh: string; auth: string; userAgent?: string | null }) {
      const expiresAt = new Date(now().getTime() + validMs);
      const values = { userId: input.userId, sessionId: input.sessionId, endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth, userAgent: input.userAgent ?? null, expiresAt };
      db.insert(pushSubscriptions)
        .values(values)
        .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { ...values, updatedAt: now() } })
        .run();
    },

    /** Stops alerts to one device (muted, or the person turned them off). */
    async unsubscribe(userId: number, endpoint: string) {
      db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint))).run();
    },

    /** A test alert to this person's own devices, so they can check it reaches a locked phone. */
    async sendTest(userId: number) {
      const rows = db
        .select({ id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint, p256dh: pushSubscriptions.p256dh, auth: pushSubscriptions.auth })
        .from(pushSubscriptions)
        .where(and(eq(pushSubscriptions.userId, userId), gt(pushSubscriptions.expiresAt, now())))
        .all();
      await deliver(rows, { title: 'Test alert', body: 'Alerts reach this phone, even when it is locked.', tag: 'test', kind: 'TEST', url: '/' });
      return rows.length;
    },

    sendToRoles,

    /** Starts listening to the app's events. Failures are logged, never thrown into the request that caused the event. */
    start() {
      if (!enabled) return;
      events.on('order.alert', ({ kind, order }) => {
        void sendToRoles(AUDIENCE[kind], alertPayload(kind, order)).catch((e) => console.warn(`Push failed: ${(e as Error).message}`));
      });
      // Signing out (or a login being changed / turned off / deleted) ends alerts to that device right away.
      events.on('auth.revoked', ({ userId, keepSessionId, onlySessionId }) => {
        const where = onlySessionId
          ? eq(pushSubscriptions.sessionId, onlySessionId)
          : keepSessionId
            ? and(eq(pushSubscriptions.userId, userId), ne(pushSubscriptions.sessionId, keepSessionId))
            : eq(pushSubscriptions.userId, userId);
        try {
          db.delete(pushSubscriptions).where(where).run();
        } catch (e) {
          console.warn(`Push cleanup failed: ${(e as Error).message}`);
        }
      });
    },
  };
  return service;
}

export type PushService = ReturnType<typeof createPushService>;
