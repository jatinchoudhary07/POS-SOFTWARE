import { ChevronLeft, ChevronRight, CircleAlert, Loader2, RotateCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { DailySummary } from '../api/types';
import { cx } from '../lib/cx';
import { formatPaise } from '../lib/money';
import { formatClock } from '../lib/time';
import { useUser } from '../state/Auth';
import { useLiveOrders } from '../state/LiveOrders';
import { can } from '../state/permissions';
import { Dashboard } from './dashboard/Dashboard';
import { SalesHistory } from './dashboard/SalesHistory';
import { CreditBook } from './CreditBook';
import { PhoneSalesDashboard } from './dashboard/PhoneSalesDashboard';
import { Button, IconButton } from './ui/Button';
import { METHOD_LABELS } from './ui/PaymentBadge';

const toKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fromKey = (k: string) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const shiftDay = (k: string, days: number) => {
  const d = fromKey(k);
  d.setDate(d.getDate() + days);
  return toKey(d);
};

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'danger' | 'warning' }) {
  return (
    <div className="rounded-card bg-surface p-4 shadow-card">
      <p className="text-sm font-medium text-ink-2">{label}</p>
      <p
        className={cx(
          'mt-1 text-2xl font-semibold tracking-tight tabular-nums',
          tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-ink',
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-sm text-ink-2 tabular-nums">{sub}</p>}
    </div>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const STATUS_TEXT: Record<string, string> = {
  SUCCEEDED: 'Paid',
  FAILED: 'Failed',
  PENDING: 'In progress',
  UNKNOWN: 'Uncertain',
  REFUNDED: 'Refunded',
};

/** Phones get the compact phone layout; laptops and tablets get the full desktop views. */
function useIsPhone() {
  const query = '(max-width: 767px)';
  const [phone, setPhone] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

export function SalesView({ onOpenOrder }: { onOpenOrder: (orderId: number) => void }) {
  const { role } = useUser();
  const isPhone = useIsPhone();

  if (isPhone) return <PhoneSalesDashboard onOpenOrder={onOpenOrder} />;
  return role === 'SUPERADMIN' ? <Dashboard onOpenOrder={onOpenOrder} /> : <TodaySales onOpenOrder={onOpenOrder} />;
}

function TodaySales({ onOpenOrder }: { onOpenOrder: (orderId: number) => void }) {
  const { subscribe } = useLiveOrders();
  const { role } = useUser();
  // Reception sees today's figures only; other days are for the Superadmin (server enforces it).
  const otherDays = can.viewOtherDays(role);
  const [date, setDate] = useState(() => toKey(new Date()));
  const [summary, setSummary] = useState<DailySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const isToday = date === toKey(new Date());
  const [tab, setTab] = useState<'today' | 'history' | 'credit'>('today');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSummary(await api.dailySummary(date));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the summary');
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    void load();
  }, [load]);

  // Today's figures follow live order/payment events.
  useEffect(() => (isToday ? subscribe(() => void load()) : undefined), [isToday, subscribe, load]);

  const label = fromKey(date).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div className="flex min-h-0 min-w-0 w-full max-w-full flex-1 flex-col overflow-y-auto overflow-x-hidden">
      <div className="flex flex-wrap items-center gap-2.5 px-4 pt-3.5 pb-2.5 sm:pt-4 sm:pb-3 lg:px-6 lg:pt-5">
        <h2 className="mr-1 text-xl font-semibold tracking-tight">Sales</h2>
        {!otherDays ? (
          <span className="text-xs sm:text-sm font-semibold text-ink-2">Today · {label}</span>
        ) : (
        <div className="flex max-w-full items-center gap-1 rounded-[12px] bg-fill p-1">
          <IconButton icon={ChevronLeft} variant="plain" aria-label="Previous day" className="h-8 w-8 sm:h-9 sm:w-9" onClick={() => setDate((d) => shiftDay(d, -1))} />
          <span className="min-w-36 flex-1 px-1 text-center text-xs sm:text-sm font-semibold truncate sm:min-w-52">{label}</span>
          <IconButton
            icon={ChevronRight}
            variant="plain"
            aria-label="Next day"
            className="h-8 w-8 sm:h-9 sm:w-9"
            disabled={isToday}
            onClick={() => setDate((d) => shiftDay(d, 1))}
          />
        </div>
        )}
        {!isToday && otherDays && (
          <Button size="sm" variant="plain" onClick={() => setDate(toKey(new Date()))}>
            Today
          </Button>
        )}
        <Button size="sm" icon={RotateCw} loading={loading} disabled={loading} onClick={() => void load()} className="ml-auto">
          Refresh
        </Button>
      </div>

      <div role="tablist" aria-label="Sales sections" className="mx-4 mb-3 inline-flex w-fit gap-1 rounded-full bg-fill p-1 lg:mx-6">
        {(
          [
            ['today', 'Sales'],
            ['history', 'Order history'],
            ['credit', 'Credit'],
          ] as const
        ).map(([v, l]) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={tab === v}
            onClick={() => setTab(v)}
            className={cx(
              'rounded-full px-4 py-1.5 text-sm font-semibold transition-all',
              tab === v ? 'bg-surface text-ink shadow-sm' : 'text-ink-2 hover:text-ink',
            )}
          >
            {l}
          </button>
        ))}
      </div>

      {tab === 'history' && (
        <div className="px-4 pb-6 lg:px-6">
          <SalesHistory from={date} to={date} isSuperadmin={role === 'SUPERADMIN'} onOpenOrder={onOpenOrder} />
        </div>
      )}

      {tab === 'credit' && (
        <div className="px-4 pb-6 lg:px-6">
          <CreditBook light />
        </div>
      )}

      <div className={cx('space-y-4 px-4 pb-24 md:pb-6 lg:px-6', tab !== 'today' && 'hidden')}>
        {error && (
          <p role="alert" className="flex items-center gap-2 rounded-control bg-danger-tint px-4 py-3 text-sm font-medium text-danger">
            <CircleAlert size={18} aria-hidden /> {error}
          </p>
        )}
        {!summary ? (
          !error && (
            <p className="flex items-center justify-center gap-2 py-20 text-ink-2">
              <Loader2 size={18} className="animate-spin" aria-hidden /> Loading…
            </p>
          )
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Net sales" value={formatPaise(summary.netSalesPaise)} sub={`${summary.paidCount} paid`} />
              <Stat label="Cash" value={formatPaise(summary.byMethod.CASH.totalPaise)} sub={plural(summary.byMethod.CASH.count, 'payment', 'payments')} />
              <Stat label="UPI (manual check)" value={formatPaise(summary.byMethod.UPI_MANUAL.totalPaise)} sub={plural(summary.byMethod.UPI_MANUAL.count, 'payment', 'payments')} />
              <Stat label="Orders" value={String(summary.orderCount)} sub="created this day" />
              <Stat
                label="Unpaid"
                value={formatPaise(summary.unpaidTotalPaise)}
                sub={plural(summary.unpaidCount, 'order', 'orders')}
                tone={summary.unpaidCount > 0 ? 'warning' : undefined}
              />
              <Stat
                label="Needs attention"
                value={String(summary.uncertainAttemptCount)}
                sub={`uncertain · ${plural(summary.failedAttemptCount, 'failed attempt', 'failed attempts')}`}
                tone={summary.uncertainAttemptCount > 0 ? 'danger' : undefined}
              />
            </div>

            <section className="rounded-card bg-surface shadow-card" aria-label="Payment records">
              <h3 className="px-5 pt-4 pb-2 text-[15px] font-semibold text-ink-2">Payment records</h3>
              {summary.payments.length === 0 ? (
                <p className="px-5 pb-5 text-sm text-ink-2">No payments on this day.</p>
              ) : (
                <>
                  {/* Phones: one row per payment instead of a six-column table. */}
                  <ul className="divide-y divide-line sm:hidden">
                    {summary.payments.map((p) => (
                      <li key={p.id} className="flex items-center gap-3 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <button type="button" className="font-medium text-accent-hover hover:underline" onClick={() => onOpenOrder(p.orderId)}>
                            #{p.orderNumber}
                          </button>
                          <div className="text-[13px] text-ink-2">
                            {formatClock(p.completedAt ?? p.createdAt)} · {METHOD_LABELS[p.method]} ·{' '}
                            <span className={cx('font-medium', p.status === 'FAILED' && 'text-danger', p.status === 'UNKNOWN' && 'text-warning')}>
                              {STATUS_TEXT[p.status]}
                            </span>
                          </div>
                        </div>
                        <span className={cx('font-semibold tabular-nums', p.status !== 'SUCCEEDED' && p.status !== 'REFUNDED' && 'text-ink-2 line-through')}>
                          {formatPaise(p.amountPaise)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="hidden overflow-x-auto sm:block">
                    <table className="w-full text-sm whitespace-nowrap">
                      <thead>
                        <tr className="border-y border-line text-left text-ink-2">
                          <th className="py-2 pr-2 pl-4 font-medium sm:px-5">Time</th>
                          <th className="px-2 py-2 font-medium sm:px-3">Order</th>
                          <th className="hidden px-3 py-2 font-medium sm:table-cell">Reference</th>
                          <th className="px-2 py-2 font-medium sm:px-3">Method</th>
                          <th className="px-2 py-2 font-medium sm:px-3">Status</th>
                          <th className="py-2 pr-4 pl-2 text-right font-medium sm:px-5">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {summary.payments.map((p) => (
                          <tr key={p.id}>
                            <td className="py-2.5 pr-2 pl-4 tabular-nums sm:px-5">{formatClock(p.completedAt ?? p.createdAt)}</td>
                            <td className="px-2 py-2.5 sm:px-3">
                              <button type="button" className="font-medium text-accent-hover hover:underline" onClick={() => onOpenOrder(p.orderId)}>
                                #{p.orderNumber}
                              </button>
                            </td>
                            <td className="hidden px-3 py-2.5 text-ink-2 sm:table-cell">{p.reference}</td>
                            <td className="px-2 py-2.5 sm:px-3">{METHOD_LABELS[p.method]}</td>
                            <td className={cx('px-2 py-2.5 font-medium sm:px-3', p.status === 'FAILED' && 'text-danger', p.status === 'UNKNOWN' && 'text-warning')}>
                              {STATUS_TEXT[p.status]}
                            </td>
                            <td className={cx('py-2.5 pr-4 pl-2 text-right tabular-nums sm:px-5', p.status !== 'SUCCEEDED' && p.status !== 'REFUNDED' && 'text-ink-2 line-through')}>
                              {formatPaise(p.amountPaise)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>

            <p className="text-sm text-ink-2">
              Calculated by the server from saved payment records for this computer's local day (midnight to midnight). Sales count on the day
              the payment was completed. Failed and uncertain attempts are never counted as
              sales. Unpaid amounts for orders without a bill are estimated with today's tax settings.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
