// @refresh reset
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { api, ApiError } from '../api/client';
import type { LiveOrder, Order, OrderStatus, Role } from '../api/types';
import { API_BASE } from '../lib/config';
import { ACTIVE_STATUSES, mergeSnapshot, upsertOrder, type OrderMap } from './orders';

/**
 * One live view of the orders, shared by the Orders and Kitchen screens.
 *
 *  - On start and after EVERY (re)connect, a REST snapshot is fetched and merged, so a screen
 *    that was offline catches up on anything it missed (Socket.IO does not replay events).
 *  - Socket events ('order.created' / 'order.updated') are merged as they arrive.
 *  - Merges are "newest wins" by id (see orders.ts), so the same order arriving from both the
 *    snapshot and an event never produces a duplicate ticket.
 *  - While the socket is down, the snapshot is re-fetched every 10 s as a fallback.
 */

export type ConnectionState = 'connecting' | 'live' | 'reconnecting';
/** 'websocket' normally; 'polling' if something on the network blocks WebSockets (still works). */
export type Transport = 'websocket' | 'polling' | null;
export interface LiveEvent {
  type: 'created' | 'updated';
  /** Full order for staff logins; kitchen-only fields for the kitchen login. */
  order: LiveOrder;
}

interface LiveOrdersValue {
  orders: OrderMap;
  connection: ConnectionState;
  transport: Transport;
  /** true once the first snapshot has loaded */
  loaded: boolean;
  syncError: string | null;
  lastSyncedAt: Date | null;
  resync: () => Promise<void>;
  reconnect: () => void;
  /** Calls the API; the server validates the transition. Throws ApiError on failure. */
  updateStatus: (id: number, status: OrderStatus) => Promise<LiveOrder>;
  /** Adds an order this screen just created (the socket event will be de-duplicated). */
  ingest: (order: Order) => void;
  /** Listen to live socket events (e.g. to show a toast). Returns an unsubscribe function. */
  subscribe: (fn: (e: LiveEvent) => void) => () => void;
}

const FALLBACK_POLL_MS = 10_000;
const RECENT_LIMIT = 100;
const ACTIVE_LIMIT = 200;

const LiveOrdersContext = createContext<LiveOrdersValue | null>(null);

export function useLiveOrders(): LiveOrdersValue {
  const ctx = useContext(LiveOrdersContext);
  if (!ctx) throw new Error('useLiveOrders must be used inside <LiveOrdersProvider>');
  return ctx;
}

export function LiveOrdersProvider({
  children,
  role,
  onUnauthenticated,
}: {
  children: ReactNode;
  /** The signed-in login's role; the kitchen login loads price-free kitchen data. */
  role: Role;
  /** The server refused the socket (session expired/revoked). */
  onUnauthenticated: () => void;
}) {
  const [orders, setOrders] = useState<OrderMap>(() => new Map());
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [transport, setTransport] = useState<Transport>(null);
  const [loaded, setLoaded] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const listeners = useRef(new Set<(e: LiveEvent) => void>());
  // Ids touched by socket events while a snapshot request is in flight.
  const touchedDuringSync = useRef<Set<number> | null>(null);

  const resync = useCallback(async () => {
    const touched = new Set<number>();
    touchedDuringSync.current = touched;
    try {
      // Staff: recent history + ALL active orders (however old). Kitchen: active orders only,
      // from the kitchen endpoint (no prices or payment data).
      const [recent, active]: [LiveOrder[], LiveOrder[]] =
        role === 'KITCHEN'
          ? [[], await api.kitchenOrders()]
          : await Promise.all([
              api.listOrders({ limit: RECENT_LIMIT }),
              api.listOrders({ statuses: [...ACTIVE_STATUSES], limit: ACTIVE_LIMIT }),
            ]);
      let snapshot: OrderMap = new Map();
      for (const o of [...recent, ...active]) snapshot = upsertOrder(snapshot, o);
      setOrders((m) => mergeSnapshot(m, [...snapshot.values()], touched));
      setLoaded(true);
      setSyncError(null);
      setLastSyncedAt(new Date());
    } catch (e) {
      setSyncError(e instanceof ApiError ? e.message : 'Could not load orders');
    } finally {
      if (touchedDuringSync.current === touched) touchedDuringSync.current = null;
    }
  }, [role]);

  // Kept in a ref so the socket effect doesn't reconnect when the callback identity changes.
  const unauthRef = useRef(onUnauthenticated);
  unauthRef.current = onUnauthenticated;

  useEffect(() => {
    // No URL = same server that served this page (see lib/config.ts).
    // The session cookie is sent with the handshake; the server rejects it if not signed in.
    const opts = { reconnectionDelayMax: 5000, withCredentials: true };
    const socket = API_BASE ? io(API_BASE, opts) : io(opts);
    socketRef.current = socket;

    const onOrder = (type: LiveEvent['type']) => (payload: { order: LiveOrder }) => {
      const order = payload?.order;
      if (!order || typeof order.id !== 'number') return;
      touchedDuringSync.current?.add(order.id);
      setOrders((m) => upsertOrder(m, order));
      listeners.current.forEach((fn) => fn({ type, order }));
    };
    socket.on('order.created', onOrder('created'));
    socket.on('order.updated', onOrder('updated'));
    socket.on('connect', () => {
      setConnection('live');
      // Socket.IO starts with HTTP polling and upgrades to WebSocket within a moment. Only report
      // "polling" if it is still polling after a few seconds (= WebSockets blocked on this network).
      const engine = socket.io.engine;
      setTransport(engine.transport.name === 'websocket' ? 'websocket' : null);
      engine.once('upgrade', () => setTransport('websocket'));
      setTimeout(() => {
        if (socket.connected && socket.io.engine.transport.name !== 'websocket') setTransport('polling');
      }, 5000);
      void resync(); // catch up on anything missed while disconnected
    });
    socket.on('disconnect', (reason) => {
      setConnection('reconnecting');
      // The client retries automatically except when the server closed the connection.
      if (reason === 'io server disconnect') socket.connect();
    });
    socket.on('connect_error', (err) => {
      setConnection('reconnecting');
      // Session gone: confirm with the API (a 401 there returns the app to the login screen).
      if (err.message === 'UNAUTHENTICATED') {
        socket.disconnect();
        api.me().catch(() => unauthRef.current());
      }
    });

    void resync(); // show orders even before (or without) the socket connecting
    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [resync]);

  // Fallback while live updates are down: keep the screen reasonably fresh via REST.
  useEffect(() => {
    if (connection === 'live') return;
    const t = setInterval(() => void resync(), FALLBACK_POLL_MS);
    return () => clearInterval(t);
  }, [connection, resync]);

  // Coming back to a backgrounded tab: refresh once.
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && void resync();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [resync]);

  const value = useMemo<LiveOrdersValue>(
    () => ({
      orders,
      connection,
      transport,
      loaded,
      syncError,
      lastSyncedAt,
      resync,
      reconnect: () => {
        socketRef.current?.connect();
        void resync();
      },
      updateStatus: async (id: number, status: OrderStatus): Promise<LiveOrder> => {
        const { order } = await api.updateOrderStatus(id, status);
        setOrders((m) => upsertOrder(m, order));
        return order;
      },
      ingest: (order: Order) => setOrders((m) => upsertOrder(m, order)),
      subscribe: (fn) => {
        listeners.current.add(fn);
        return () => listeners.current.delete(fn);
      },
    }),
    [orders, connection, transport, loaded, syncError, lastSyncedAt, resync],
  );

  return <LiveOrdersContext.Provider value={value}>{children}</LiveOrdersContext.Provider>;
}
