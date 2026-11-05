import type http from 'node:http';
import { Server } from 'socket.io';
import type { UserRole } from './db/schema';
import type { EventBus } from './events';
import { parseCookies, SESSION_COOKIE } from './lib/cookies';
import type { AuthService } from './services/authService';
import { toKitchenOrder, type KitchenOrderDTO, type OrderDTO } from './services/orderService';

/**
 * Real-time updates over Socket.IO, attached to the SAME http.Server and port as the REST API.
 *
 * Only signed-in screens can connect: the handshake must carry a valid session cookie, and the
 * role comes from that server-side session. Each socket joins exactly one room:
 *   room "staff"   (SUPERADMIN, RECEPTION) — full orders, including prices and payment status
 *   room "kitchen" (KITCHEN)               — KitchenOrderDTO only (no prices, no payment info),
 *                                            and no events for billing/payment changes
 *
 * Server -> client events:
 *   'order.created'  { order }   a new order was saved
 *   'order.updated'  { order }   an order changed (status; for staff also bill/payment)
 *
 * The channel is broadcast-only: the server registers no handlers for client events, so a
 * socket can never change data. Sockets are disconnected when their session is logged out,
 * revoked by a credential change, or expires.
 */
export interface ServerToClientEvents {
  'order.created': (payload: { order: OrderDTO | KitchenOrderDTO }) => void;
  'order.updated': (payload: { order: OrderDTO | KitchenOrderDTO }) => void;
}

interface SocketData {
  userId: number;
  role: UserRole;
  sessionId: string;
}

export const roomFor = (role: UserRole) => (role === 'KITCHEN' ? 'kitchen' : 'staff');

export function attachRealtime(
  server: http.Server,
  events: EventBus,
  auth: AuthService,
  opts: { corsOrigins: string[]; sessionCheckMs?: number },
) {
  const io = new Server<Record<string, never>, ServerToClientEvents, Record<string, never>, SocketData>(server, {
    serveClient: false,
    // Long-polling fallback requests need CORS only when the UI is served from another origin.
    cors: opts.corsOrigins.length > 0 ? { origin: opts.corsOrigins, credentials: true } : undefined,
    // WebSockets ignore CORS, so check the Origin ourselves: a random website open in a staff
    // browser cannot open a socket to this server.
    allowRequest: (req, callback) => {
      const ok = isAllowedOrigin(req, opts.corsOrigins);
      // Logged so a misconfigured address (e.g. a proxy changing Host) is easy to diagnose.
      if (!ok) console.warn(`Refused live connection from origin ${req.headers.origin} (host ${req.headers.host})`);
      callback(null, ok);
    },
  });

  // Authenticate every connection from the session cookie.
  io.use((socket, next) => {
    const token = parseCookies(socket.request.headers.cookie)[SESSION_COOKIE];
    const session = auth.validate(token);
    if (!session) return next(new Error('UNAUTHENTICATED'));
    socket.data = { userId: session.user.id, role: session.user.role, sessionId: session.sessionId };
    next();
  });

  io.on('connection', (socket) => {
    void socket.join(roomFor(socket.data.role));
  });

  const onCreated = (order: OrderDTO) => {
    io.to('staff').emit('order.created', { order });
    io.to('kitchen').emit('order.created', { order: toKitchenOrder(order) });
  };
  const onUpdated = (order: OrderDTO, meta?: { kitchen: boolean }) => {
    io.to('staff').emit('order.updated', { order });
    if (meta?.kitchen !== false) io.to('kitchen').emit('order.updated', { order: toKitchenOrder(order) });
  };
  // Logout / credential change: drop the affected live connections immediately.
  const onRevoked = ({ userId, keepSessionId, onlySessionId }: { userId: number; keepSessionId?: string; onlySessionId?: string }) => {
    for (const s of io.of('/').sockets.values()) {
      if (s.data.userId !== userId) continue;
      if (onlySessionId ? s.data.sessionId === onlySessionId : s.data.sessionId !== keepSessionId) s.disconnect(true);
    }
  };
  events.on('order.created', onCreated);
  events.on('order.updated', onUpdated);
  events.on('auth.revoked', onRevoked);

  // Sessions also end by timing out; check open sockets periodically.
  const sweep = setInterval(() => {
    for (const s of io.of('/').sockets.values()) {
      if (!auth.isSessionActive(s.data.sessionId)) s.disconnect(true);
    }
  }, opts.sessionCheckMs ?? 60_000);
  sweep.unref();

  return {
    io,
    /** Number of connected screens (used for logging). */
    clientCount: () => io.engine.clientsCount,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweep);
        events.off('order.created', onCreated);
        events.off('order.updated', onUpdated);
        events.off('auth.revoked', onRevoked);
        io.close(() => resolve());
      }),
  };
}

/** Same-origin pages (the normal case), listed CORS origins, and non-browser clients are allowed. */
export function isAllowedOrigin(req: http.IncomingMessage, allowed: string[]): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (allowed.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
