import { ArrowDownLeft, ArrowUpRight, Loader2, Search, ShoppingBag, UtensilsCrossed, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { isFullOrder, type HistoryRow, type Order } from '../../api/types';
import { cx } from '../../lib/cx';
import { formatPaise } from '../../lib/money';
import { useLiveOrders } from '../../state/LiveOrders';
import { toKey } from './dates';

const PAGE = 40;

type Filter = '' | 'PAID' | 'UNPAID' | 'REFUNDED' | 'CANCELLED';
const FILTERS: { value: Filter; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'PAID', label: 'Paid' },
  { value: 'UNPAID', label: 'Pending' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

export const BADGE: Record<string, { label: string; cls: string }> = {
  PAID: { label: 'Paid', cls: 'bg-emerald-500 text-white' },
  UNPAID: { label: 'Pending', cls: 'bg-orange-400 text-white' },
  CREDIT: { label: 'On credit', cls: 'bg-amber-500 text-white' },
  REFUNDED: { label: 'Refunded', cls: 'bg-rose-400 text-white' },
  FAILED: { label: 'Failed', cls: 'bg-rose-500 text-white' },
  UNCERTAIN: { label: 'Check', cls: 'bg-amber-500 text-white' },
  CANCELLED: { label: 'Cancelled', cls: 'bg-slate-400 text-white' },
};

const METHOD: Record<string, string> = { CASH: 'Cash', UPI_MANUAL: 'UPI', TERMINAL: 'Card', CREDIT: 'Credit' };

function when(iso: string, multiDay: boolean) {
  const d = new Date(iso);
  const t = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return multiDay ? `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${t}` : t;
}

export const fromLive = (o: Order): HistoryRow => ({
  id: o.id,
  orderNumber: o.orderNumber,
  createdAt: o.createdAt,
  orderType: o.orderType,
  tableNumber: o.tableNumber,
  status: o.status,
  paymentStatus: o.paymentStatus,
  paymentMethod: o.paymentMethod,
  totalPaise: o.billTotalPaise ?? o.subtotalPaise,
  itemCount: o.itemCount,
  itemsSummary: o.items.map((i) => `${i.quantity}× ${i.itemName}`).join(', '),
});

const matchesFilter = (r: HistoryRow, f: Filter) =>
  f === '' ? true : f === 'CANCELLED' ? r.status === 'CANCELLED' : r.status !== 'CANCELLED' && r.paymentStatus === f;

/**
 * Order history tab. The Superadmin searches the server for any dates; reception sees today's
 * orders straight from the live feed (the server only exposes history to the Superadmin).
 */
export function SalesHistory({
  from,
  to,
  isSuperadmin,
  onOpenOrder,
}: {
  from: string;
  to: string;
  isSuperadmin: boolean;
  onOpenOrder: (orderId: number) => void;
}) {
  const { orders, loaded } = useLiveOrders();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('');
  const [remote, setRemote] = useState<HistoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(isSuperadmin);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const multiDay = from !== to;

  const load = useCallback(
    async (offset: number) => {
      const ticket = ++latest.current;
      setLoading(true);
      try {
        const r = await api.orderHistory({
          from,
          to,
          q: q.trim() || undefined,
          payment: filter || undefined,
          limit: PAGE,
          offset,
        });
        if (ticket !== latest.current) return;
        setRemote((cur) => (offset === 0 ? r.rows : [...cur, ...r.rows]));
        setTotal(r.total);
        setError(null);
      } catch (e) {
        if (ticket === latest.current) setError(e instanceof ApiError ? e.message : 'Could not load orders');
      } finally {
        if (ticket === latest.current) setLoading(false);
      }
    },
    [from, to, q, filter],
  );

  useEffect(() => {
    if (!isSuperadmin) return;
    const t = setTimeout(() => void load(0), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [isSuperadmin, load, q]);

  const local = useMemo(() => {
    if (isSuperadmin) return [];
    const needle = q.trim().toLowerCase();
    return [...orders.values()]
      .filter(isFullOrder)
      .filter((o) => toKey(new Date(o.createdAt)) >= from && toKey(new Date(o.createdAt)) <= to)
      .map(fromLive)
      .filter((r) => matchesFilter(r, filter))
      .filter(
        (r) =>
          !needle ||
          r.orderNumber.toLowerCase().includes(needle) ||
          (r.tableNumber ?? '').toLowerCase().includes(needle) ||
          r.itemsSummary.toLowerCase().includes(needle),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [isSuperadmin, orders, from, to, q, filter]);

  const rows = isSuperadmin ? remote : local;
  const count = isSuperadmin ? total : local.length;
  const busy = isSuperadmin ? loading : !loaded;

  return (
    <section aria-label="Order history" className="mx-auto w-full max-w-2xl animate-enter">
      <div className="rounded-[28px] bg-white/85 p-4 shadow-[0_10px_40px_-12px_rgba(120,80,40,0.18)] ring-1 ring-white backdrop-blur-xl sm:p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold tracking-tight text-slate-900">Order history</h2>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600 tabular-nums">
            {count} {count === 1 ? 'order' : 'orders'}
          </span>
        </div>

        <div className="relative mt-3">
          <Search size={16} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-slate-400" aria-hidden />
          <input
            type="search"
            aria-label="Search orders"
            placeholder="Search order no., table or dish…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-11 w-full rounded-full border border-transparent bg-slate-100/80 pr-10 pl-10 text-sm text-slate-900 outline-none transition-all placeholder:text-slate-400 focus:border-orange-300 focus:bg-white focus:shadow-[0_0_0_4px_rgba(251,146,60,0.15)]"
          />
          {q && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQ('')}
              className="absolute top-1/2 right-3 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700"
            >
              <X size={14} />
            </button>
          )}
        </div>

        <div role="radiogroup" aria-label="Filter orders" className="no-scrollbar mt-3 flex gap-2 overflow-x-auto pb-1">
          {FILTERS.map((f) => {
            const active = filter === f.value;
            return (
              <button
                key={f.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setFilter(f.value)}
                className={cx(
                  'shrink-0 rounded-full px-3.5 py-1.5 text-xs font-bold transition-all duration-200 active:scale-95',
                  active ? 'bg-slate-900 text-white shadow-md' : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
                )}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-3 rounded-2xl bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
          {error}
        </p>
      )}

      {busy && rows.length === 0 ? (
        <div className="space-y-2.5 pt-3" aria-label="Loading orders">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-[74px] animate-pulse rounded-[22px] bg-white/70" style={{ animationDelay: `${i * 90}ms` }} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-3 rounded-[28px] bg-white/70 px-6 py-14 text-center animate-fade">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-orange-100 text-orange-500">
            <ShoppingBag size={24} aria-hidden />
          </span>
          <p className="mt-3 font-bold text-slate-800">No orders found</p>
          <p className="mt-1 text-sm text-slate-500">Try another search or filter{isSuperadmin ? ' or date' : ''}.</p>
        </div>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {rows.map((r, i) => (
            <HistoryItem key={r.id} row={r} multiDay={multiDay} index={i} onOpen={() => onOpenOrder(r.id)} />
          ))}
        </ul>
      )}

      {isSuperadmin && rows.length > 0 && (
        <div className="flex items-center justify-between gap-3 px-2 pt-4 text-xs font-medium text-slate-500">
          <span className="flex items-center gap-2">
            {loading && <Loader2 size={14} className="animate-spin" aria-hidden />}
            Showing {rows.length} of {total}
          </span>
          {rows.length < total && (
            <button
              type="button"
              disabled={loading}
              onClick={() => void load(rows.length)}
              className="rounded-full bg-white px-4 py-2 text-xs font-bold text-slate-800 shadow-sm transition-all hover:shadow-md active:scale-95 disabled:opacity-50"
            >
              Show more
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function HistoryItem({ row: r, multiDay, index, onOpen }: { row: HistoryRow; multiDay: boolean; index: number; onOpen: () => void }) {
  const cancelled = r.status === 'CANCELLED';
  const badge = BADGE[cancelled ? 'CANCELLED' : r.paymentStatus === 'PAID' && r.paymentMethod === 'CREDIT' ? 'CREDIT' : r.paymentStatus] ?? BADGE.UNPAID;
  const refunded = r.paymentStatus === 'REFUNDED';
  const Icon = r.orderType === 'DINE_IN' ? UtensilsCrossed : ShoppingBag;
  const Trend = refunded ? ArrowDownLeft : ArrowUpRight;
  const place = r.orderType === 'DINE_IN' ? (r.tableNumber ? `Table ${r.tableNumber}` : 'Dine-in') : 'Takeaway';
  const method = r.paymentMethod && r.paymentMethod !== 'CREDIT' && r.paymentStatus === 'PAID' ? ` · ${METHOD[r.paymentMethod]}` : '';

  return (
    <li className="animate-card-rise" style={{ animationDelay: `${Math.min(index, 12) * 45}ms` }}>
      <button
        type="button"
        onClick={onOpen}
        className="group flex w-full items-center gap-3 rounded-[22px] bg-white/90 p-3.5 text-left shadow-[0_4px_18px_-6px_rgba(120,80,40,0.14)] ring-1 ring-white transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_10px_26px_-8px_rgba(120,80,40,0.25)] active:scale-[0.985]"
      >
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-orange-100 to-amber-50 text-orange-500 transition-transform duration-300 group-hover:rotate-6 group-hover:scale-105">
          <Icon size={20} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-bold text-slate-900">
            #{r.orderNumber} <span className="font-medium text-slate-400">· {place}</span>
          </span>
          <span className="block truncate text-xs text-slate-500">{r.itemsSummary}</span>
          <span className="block text-[11px] text-slate-400">
            {when(r.createdAt, multiDay)}
            {method}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1.5">
          <span
            className={cx(
              'flex items-center gap-0.5 text-sm font-extrabold tabular-nums',
              cancelled ? 'text-slate-400 line-through' : refunded ? 'text-rose-500' : 'text-emerald-600',
            )}
          >
            {refunded ? '−' : '+'}
            {formatPaise(r.totalPaise)}
            {!cancelled && <Trend size={14} aria-hidden />}
          </span>
          <span className={cx('rounded-full px-2 py-0.5 text-[10px] font-bold', badge.cls)}>{badge.label}</span>
        </span>
      </button>
    </li>
  );
}
