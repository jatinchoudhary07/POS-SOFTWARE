import { Loader2, Search, ShoppingBag, UtensilsCrossed } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { HistoryRow } from '../../api/types';
import { cx } from '../../lib/cx';
import { formatPaise } from '../../lib/money';
import { Button } from '../ui/Button';
import { inputClass } from '../ui/fields';
import { PaymentBadge } from '../ui/PaymentBadge';
import { StatusBadge } from '../ui/StatusBadge';
import { fromKey } from './dates';

const PAGE = 50;
type PayFilter = '' | 'PAID' | 'UNPAID' | 'REFUNDED' | 'UNCERTAIN' | 'FAILED' | 'CANCELLED';
const PAY_OPTIONS: [PayFilter, string][] = [
  ['', 'All payments'],
  ['PAID', 'Paid'],
  ['UNPAID', 'Unpaid'],
  ['REFUNDED', 'Refunded'],
  ['UNCERTAIN', 'Needs checking'],
  ['FAILED', 'Payment failed'],
  ['CANCELLED', 'Cancelled orders'],
];

const when = (iso: string, multiDay: boolean) => {
  const d = new Date(iso);
  const t = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return multiDay ? `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${t}` : t;
};

/** Every order in the chosen dates, newest first, with search and filters. Click one to open its bill. */
export function OrderHistory({ from, to, onOpenOrder }: { from: string; to: string; onOpenOrder: (orderId: number) => void }) {
  const [q, setQ] = useState('');
  const [payment, setPayment] = useState<PayFilter>('');
  const [type, setType] = useState<'' | 'DINE_IN' | 'TAKEAWAY'>('');
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const multiDay = from !== to;

  const load = useCallback(
    async (offset: number) => {
      const ticket = ++latest.current;
      setLoading(true);
      try {
        const r = await api.orderHistory({ from, to, q: q.trim() || undefined, payment: payment || undefined, type: type || undefined, limit: PAGE, offset });
        if (ticket !== latest.current) return; // a newer search is already running
        setRows((cur) => (offset === 0 ? r.rows : [...cur, ...r.rows]));
        setTotal(r.total);
        setError(null);
      } catch (e) {
        if (ticket === latest.current) setError(e instanceof ApiError ? e.message : 'Could not load orders');
      } finally {
        if (ticket === latest.current) setLoading(false);
      }
    },
    [from, to, q, payment, type],
  );

  // Typing waits a moment so every keystroke doesn't hit the server.
  useEffect(() => {
    const t = setTimeout(() => void load(0), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  return (
    <section className="rounded-card bg-surface shadow-card" aria-label="Order history">
      <div className="flex flex-wrap items-center gap-2 p-3 sm:p-4">
        <div className="relative w-full sm:w-auto sm:min-w-52 sm:flex-1">
          <Search size={17} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-3" aria-hidden />
          <input type="search" aria-label="Search orders" placeholder="Search order no., table or item…" value={q} onChange={(e) => setQ(e.target.value)} className={cx(inputClass, 'h-11 pl-10')} />
        </div>
        <select aria-label="Payment filter" value={payment} onChange={(e) => setPayment(e.target.value as PayFilter)} className={cx(inputClass, 'h-11 flex-1 sm:flex-initial sm:w-auto')}>
          {PAY_OPTIONS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select aria-label="Order type filter" value={type} onChange={(e) => setType(e.target.value as typeof type)} className={cx(inputClass, 'h-11 flex-1 sm:flex-initial sm:w-auto')}>
          <option value="">Dine-in &amp; takeaway</option>
          <option value="DINE_IN">Dine-in</option>
          <option value="TAKEAWAY">Takeaway</option>
        </select>
      </div>

      {error && <p role="alert" className="px-5 pb-3 text-sm font-medium text-danger">{error}</p>}

      {rows.length === 0 && !loading ? (
        <p className="border-t border-line px-5 py-12 text-center text-sm text-ink-2">No orders match{multiDay ? '' : ' on this day'}.</p>
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {rows.map((r) => {
            const Icon = r.orderType === 'DINE_IN' ? UtensilsCrossed : ShoppingBag;
            return (
              <li key={r.id}>
                <button type="button" onClick={() => onOpenOrder(r.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-subtle sm:px-5">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-fill text-ink-2">
                    <Icon size={18} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-semibold">#{r.orderNumber}</span>
                      <span className="text-sm text-ink-2">
                        {r.orderType === 'DINE_IN' ? (r.tableNumber ? `Table ${r.tableNumber}` : 'Dine-in') : 'Takeaway'} · {when(r.createdAt, multiDay)}
                      </span>
                    </span>
                    <span className="block truncate text-sm text-ink-2">{r.itemsSummary}</span>
                  </span>
                  <span className="hidden shrink-0 items-center gap-2 md:flex">
                    {r.status === 'CANCELLED' ? <StatusBadge status="CANCELLED" /> : <PaymentBadge status={r.paymentStatus} method={r.paymentMethod} />}
                  </span>
                  <span className="shrink-0 text-right">
                    <span className={cx('block font-semibold tabular-nums', r.status === 'CANCELLED' && 'text-ink-3 line-through')}>{formatPaise(r.totalPaise)}</span>
                    <span className="block text-xs text-ink-2">
                      {r.itemCount} {r.itemCount === 1 ? 'item' : 'items'}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3 text-sm text-ink-2">
        <span>
          {loading ? (
            <span className="flex items-center gap-2">
              <Loader2 size={15} className="animate-spin" aria-hidden /> Loading…
            </span>
          ) : (
            `Showing ${rows.length} of ${total} orders${multiDay ? '' : ` on ${fromKey(from).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}`}`
          )}
        </span>
        {rows.length < total && (
          <Button size="sm" variant="secondary" disabled={loading} onClick={() => void load(rows.length)}>
            Show more
          </Button>
        )}
      </div>
    </section>
  );
}
