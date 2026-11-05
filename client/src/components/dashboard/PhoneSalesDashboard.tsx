import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  HandCoins,
  Eye,
  EyeOff,
  LayoutDashboard,
  Banknote,
  ReceiptText,
  RefreshCw,
  ShoppingBag,
  Smartphone,
  UtensilsCrossed,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from '../../api/client';
import { isFullOrder, type Analytics, type DailySummary, type HistoryRow, type ItemStat } from '../../api/types';
import { cx } from '../../lib/cx';
import { formatPaise } from '../../lib/money';
import { useUser } from '../../state/Auth';
import { useLiveOrders } from '../../state/LiveOrders';
import { can } from '../../state/permissions';
import { fromKey, hourLabel, presetRange, PRESET_LABELS, shiftDay, shortDate, toKey, type Preset } from './dates';
import { CreditBook } from '../CreditBook';
import { BADGE, fromLive, SalesHistory } from './SalesHistory';
import { useCountUp } from './useCountUp';

type Tab = 'dashboard' | 'history' | 'credit';
const PRESETS: Exclude<Preset, 'custom'>[] = ['today', 'yesterday', '7d', '30d', 'month'];

// --- small pieces -----------------------------------------------------------

function Money({ paise, hidden, className }: { paise: number; hidden?: boolean; className?: string }) {
  const v = useCountUp(paise, 950);
  return <span className={cx('tabular-nums', className)}>{hidden ? '₹ ••••' : formatPaise(Math.round(v))}</span>;
}

function Count({ value, className }: { value: number; className?: string }) {
  const v = useCountUp(value, 800);
  return <span className={cx('tabular-nums', className)}>{Math.round(v).toLocaleString()}</span>;
}

/** ₹1.2k style label for chart axes. */
const compact = (paise: number) => {
  const r = paise / 100;
  return r >= 1000 ? `${+(r / 1000).toFixed(1)}k` : String(Math.round(r));
};

/** Round a chart maximum up to a tidy number so gridlines read well. */
function niceMax(paise: number) {
  const r = Math.max(paise / 100, 100);
  const pow = Math.pow(10, Math.floor(Math.log10(r)));
  const n = r / pow;
  return Math.ceil(n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow * 100;
}

function Panel({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <div
      className={cx(
        'animate-card-rise min-w-0 rounded-[32px] bg-white/70 p-4 shadow-[0_18px_50px_-18px_rgba(120,80,40,0.25)] ring-1 ring-white backdrop-blur-xl sm:p-5',
        className,
      )}
      style={{ animationDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}

/** Custom dropdown (not a native select) so the open list never shifts the layout. */
function RangeMenu({ preset, label, onChange }: { preset: Preset; label: string; onChange: (p: Preset) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 items-center gap-1.5 rounded-full bg-white/90 pr-2.5 pl-3.5 text-xs font-bold text-slate-700 shadow-sm ring-1 ring-slate-200/70 transition-all hover:shadow-md active:scale-95"
      >
        {preset === 'custom' ? label : PRESET_LABELS[preset]}
        <ChevronDown size={14} className={cx('text-slate-500 transition-transform duration-200', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <ul role="listbox" aria-label="Date range" className="absolute right-0 z-30 mt-2 w-40 origin-top-right animate-pop overflow-hidden rounded-2xl bg-white p-1 shadow-[0_16px_40px_-10px_rgba(60,40,20,0.35)] ring-1 ring-slate-100">
          {PRESETS.map((p) => (
            <li key={p} role="option" aria-selected={preset === p}>
              <button
                type="button"
                onClick={() => {
                  onChange(p);
                  setOpen(false);
                }}
                className={cx(
                  'flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm font-semibold transition-colors',
                  preset === p ? 'bg-orange-50 text-orange-600' : 'text-slate-700 hover:bg-slate-50',
                )}
              >
                {PRESET_LABELS[p]}
                {preset === p && <Check size={14} aria-hidden />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const TEAL = [20, 184, 166];
const PEACH = [253, 186, 116];
const tickColor = (f: number) => `rgb(${TEAL.map((c, i) => Math.round(c + (PEACH[i] - c) * f)).join(',')})`;

/** Half-circle gauge drawn as plain tick lines; lit ticks fade teal to peach and a dark needle marks the value. */
function Gauge({ pct, goalLabel, children }: { pct: number; goalLabel: string; children: ReactNode }) {
  const TICKS = 44;
  const p = Math.max(0, Math.min(100, useCountUp(pct, 1200)));
  const lit = (p / 100) * TICKS;
  const at = (i: number, r: number) => {
    const a = (Math.PI * i) / TICKS;
    return { x: 110 - r * Math.cos(a), y: 112 - r * Math.sin(a) };
  };

  return (
    <div className="relative mx-auto w-full max-w-[270px]">
      <svg viewBox="0 0 220 124" className="w-full" role="img" aria-label={goalLabel}>
        {Array.from({ length: TICKS + 1 }, (_, i) => {
          const on = i <= lit && p > 0;
          const a = at(i, 74);
          const b = at(i, on ? 92 : 88);
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={on ? tickColor(i / TICKS) : '#e4ddd3'} strokeWidth="2.5" strokeLinecap="butt" />;
        })}
        {p > 0 && (() => {
          const a = at(lit, 70);
          const b = at(lit, 100);
          return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#0f172a" strokeWidth="3" strokeLinecap="round" />;
        })()}
      </svg>
      <div className="absolute inset-x-0 bottom-0 text-center">{children}</div>
    </div>
  );
}

// --- main -------------------------------------------------------------------

interface Props {
  onOpenOrder: (orderId: number) => void;
}

/** Sales page: summary gauge, sales chart, top items and an order-history tab. */
export function PhoneSalesDashboard({ onOpenOrder }: Props) {
  const { role, username } = useUser();
  const { subscribe, orders } = useLiveOrders();
  const isSuperadmin = role === 'SUPERADMIN';
  const otherDays = can.viewOtherDays(role);
  const todayKey = toKey(new Date());

  const [tab, setTab] = useState<Tab>('dashboard');
  const [preset, setPreset] = useState<Preset>('today');
  const [range, setRange] = useState(() => presetRange('today'));
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [daily, setDaily] = useState<DailySummary | null>(null);
  const [recentRemote, setRecentRemote] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [goalPaise, setGoalPaise] = useState(() => {
    try {
      const v = Number(localStorage.getItem('salesGoalPaise'));
      return v > 0 ? v : 500000;
    } catch {
      return 500000;
    }
  });
  const [editGoal, setEditGoal] = useState(false);

  const isSingleDay = range.from === range.to;
  const isToday = isSingleDay && range.from === todayKey;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (isSuperadmin) {
        const [an, hist] = await Promise.all([
          api.analytics(range.from, range.to),
          api.orderHistory({ from: range.from, to: range.to, limit: 4 }),
        ]);
        setAnalytics(an);
        setRecentRemote(hist.rows);
      } else {
        setDaily(await api.dailySummary(range.from));
      }
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load sales');
    } finally {
      setLoading(false);
    }
  }, [isSuperadmin, range.from, range.to]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => (isToday ? subscribe(() => void load()) : undefined), [isToday, subscribe, load]);

  // Reception has no analytics endpoint, so items and recent orders come from the live feed.
  const liveInRange = useMemo(
    () =>
      isSuperadmin
        ? []
        : [...orders.values()].filter(isFullOrder).filter((o) => {
            const k = toKey(new Date(o.createdAt));
            return k >= range.from && k <= range.to;
          }),
    [isSuperadmin, orders, range.from, range.to],
  );

  const recent = useMemo(
    () => (isSuperadmin ? recentRemote : liveInRange.map(fromLive).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4)),
    [isSuperadmin, recentRemote, liveInRange],
  );

  const items: ItemStat[] = useMemo(() => {
    if (analytics) return analytics.topItems.slice(0, 6);
    const by = new Map<string, ItemStat>();
    for (const o of liveInRange) {
      if (o.status === 'CANCELLED') continue;
      for (const i of o.items) {
        const cur = by.get(i.itemName) ?? { name: i.itemName, quantity: 0, revenuePaise: 0 };
        cur.quantity += i.quantity;
        cur.revenuePaise += i.lineTotalPaise;
        by.set(i.itemName, cur);
      }
    }
    return [...by.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 6);
  }, [analytics, liveInRange]);

  const t = useMemo(() => {
    if (analytics) {
      const a = analytics.totals;
      return {
        net: a.netPaise,
        orders: a.orderCount,
        paid: a.paidCount,
        avg: a.avgOrderPaise,
        items: a.itemsSold,
        // money actually received: direct payments plus credit collected from customers
        cash: (analytics.byMethod.CASH?.totalPaise ?? 0) + analytics.credit.collectedCashPaise,
        digital: (analytics.byMethod.UPI_MANUAL?.totalPaise ?? 0) + (analytics.byMethod.TERMINAL?.totalPaise ?? 0) + analytics.credit.collectedUpiPaise,
        creditOwed: analytics.credit.outstandingPaise,
        creditCustomers: analytics.credit.owingCustomers,
        prevNet: analytics.previous.netPaise,
      };
    }
    const d = daily;
    return {
      net: d?.netSalesPaise ?? 0,
      orders: d?.orderCount ?? 0,
      paid: d?.paidCount ?? 0,
      avg: d && d.paidCount > 0 ? Math.round(d.grossSalesPaise / d.paidCount) : 0,
      items: items.reduce((n, i) => n + i.quantity, 0),
      cash: (d?.byMethod.CASH?.totalPaise ?? 0) + (d?.credit.collectedCashPaise ?? 0),
      digital: (d?.byMethod.UPI_MANUAL?.totalPaise ?? 0) + (d?.byMethod.TERMINAL?.totalPaise ?? 0) + (d?.credit.collectedUpiPaise ?? 0),
      creditOwed: d?.credit.outstandingPaise ?? 0,
      creditCustomers: d?.credit.owingCustomers ?? 0,
      prevNet: 0,
    };
  }, [analytics, daily, items]);

  const days = analytics?.days ?? 1;
  const goalTotal = goalPaise * days;
  const goalPct = goalTotal > 0 ? Math.min(100, Math.round((t.net / goalTotal) * 100)) : 0;
  const delta = t.prevNet > 0 ? Math.round(((t.net - t.prevNet) / t.prevNet) * 100) : null;

  // Bars: one per day for ranges, one per hour for a single day.
  const bars = useMemo(() => {
    if (analytics && analytics.days > 1) {
      return analytics.byDay.slice(-14).map((d) => ({
        label: fromKey(d.date).toLocaleDateString(undefined, { weekday: analytics.days > 7 ? undefined : 'short', day: analytics.days > 7 ? 'numeric' : undefined }),
        value: d.netPaise,
      }));
    }
    const perHour: number[] = new Array(24).fill(0);
    if (analytics) analytics.byHour.forEach((b, h) => (perHour[h] = b?.totalPaise ?? 0));
    else for (const p of daily?.payments ?? []) if (p.status === 'SUCCEEDED') perHour[new Date(p.completedAt ?? p.createdAt).getHours()] += p.amountPaise;
    const active = perHour.map((v, h) => (v > 0 ? h : -1)).filter((h) => h >= 0);
    const lo = Math.max(0, Math.min(10, active[0] ?? 10));
    const hi = Math.min(23, Math.max(20, active[active.length - 1] ?? 20));
    return perHour.slice(lo, hi + 1).map((value, i) => ({ label: hourLabel(lo + i).replace(' ', '').toLowerCase(), value }));
  }, [analytics, daily]);

  const axisMax = niceMax(Math.max(...bars.map((b) => b.value), 0));
  const peak = bars.reduce((best, b, i) => (b.value > (bars[best]?.value ?? -1) ? i : best), 0);
  const active = picked !== null && picked < bars.length ? picked : peak;
  const labelEvery = Math.ceil(bars.length / 7);
  const chartKey = `${range.from}|${range.to}|${bars.length}`;

  function choosePreset(p: Preset) {
    setPicked(null);
    setPreset(p);
    if (p !== 'custom') setRange(presetRange(p));
  }

  function stepDay(offset: number) {
    const target = shiftDay(range.from, offset);
    if (target > todayKey) return;
    setPicked(null);
    setRange({ from: target, to: target });
    setPreset(target === todayKey ? 'today' : target === shiftDay(todayKey, -1) ? 'yesterday' : 'custom');
  }

  const dateLabel = isSingleDay
    ? fromKey(range.from).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
    : `${shortDate(range.from)} – ${shortDate(range.to)}`;
  const short = username ? username.split('@')[0] : '';
  const name = short ? short.charAt(0).toUpperCase() + short.slice(1) : 'there';
  const maxQty = Math.max(...items.map((i) => i.quantity), 1);

  return (
    <div className="relative flex min-h-0 w-full max-w-full flex-1 flex-col overflow-x-hidden overflow-y-auto bg-linear-to-br from-[#f6e7d8] via-[#faf1e8] to-[#dcefe9]">
      {/* Drifting colour blobs behind the glass panels */}
      <div aria-hidden className="pointer-events-none absolute -top-16 -left-20 h-72 w-72 animate-float rounded-full bg-orange-200/50 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute top-1/3 -right-24 h-80 w-80 animate-float rounded-full bg-teal-200/50 blur-3xl [animation-delay:-3s]" />

      <div className="relative mx-auto w-full min-w-0 max-w-6xl px-4 pt-4 pb-24 sm:px-6 md:pb-10">
        {/* Header */}
        <header className="flex flex-wrap items-center gap-3 animate-enter">
          <div className="flex min-w-0 items-center gap-3">
            <div className="min-w-0 leading-tight">
              <p className="text-xs font-medium text-slate-500">Welcome</p>
              <p className="truncate text-lg font-extrabold tracking-tight text-slate-900">{name}</p>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {otherDays ? (
              <div className="flex items-center rounded-full bg-white/80 p-0.5 shadow-sm ring-1 ring-white backdrop-blur">
                <button type="button" aria-label="Previous day" onClick={() => stepDay(-1)} className="flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-all hover:bg-slate-100 active:scale-90">
                  <ChevronLeft size={16} />
                </button>
                <span className="min-w-24 px-1 text-center text-xs font-bold text-slate-700">{dateLabel}</span>
                <button
                  type="button"
                  aria-label="Next day"
                  disabled={isToday || !isSingleDay}
                  onClick={() => stepDay(1)}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-all hover:bg-slate-100 active:scale-90 disabled:opacity-30 disabled:hover:bg-transparent"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            ) : (
              <span className="rounded-full bg-white/80 px-3 py-2 text-xs font-bold text-slate-700 shadow-sm ring-1 ring-white">Today · {dateLabel}</span>
            )}
            <button
              type="button"
              aria-label="Refresh"
              disabled={loading}
              onClick={() => void load()}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white/80 text-slate-600 shadow-sm ring-1 ring-white transition-all hover:bg-white hover:shadow-md active:scale-90"
            >
              <RefreshCw size={15} className={cx(loading && 'animate-spin text-orange-500')} />
            </button>
          </div>
        </header>

        {/* Tabs with a sliding indicator */}
        <div role="tablist" aria-label="Sales sections" className="relative mt-4 grid w-full max-w-sm grid-cols-3 rounded-full bg-white/70 p-1 shadow-sm ring-1 ring-white backdrop-blur">
          <span
            aria-hidden
            className="absolute top-1 bottom-1 left-1 w-[calc((100%-8px)/3)] rounded-full bg-slate-900 shadow-md transition-transform duration-300 ease-[cubic-bezier(0.34,1.3,0.64,1)]"
            style={{ transform: `translateX(${['dashboard', 'history', 'credit'].indexOf(tab) * 100}%)` }}
          />
          {(
            [
              ['dashboard', 'Dashboard', LayoutDashboard],
              ['history', 'Orders', ReceiptText],
              ['credit', 'Credit', HandCoins],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={cx(
                'relative z-10 flex h-10 items-center justify-center gap-1.5 rounded-full text-[13px] font-bold transition-colors duration-300',
                tab === value ? 'text-white' : 'text-slate-600 hover:text-slate-900',
              )}
            >
              <Icon size={15} aria-hidden /> {label}
            </button>
          ))}
        </div>

        {error && (
          <p role="alert" className="mt-4 flex items-center gap-2 rounded-2xl bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700 animate-enter">
            <CircleAlert size={16} aria-hidden /> {error}
          </p>
        )}

        <div className="mt-5">
          {tab === 'credit' ? (
            <CreditBook />
          ) : tab === 'history' ? (
            <SalesHistory key={`${range.from}${range.to}`} from={range.from} to={range.to} isSuperadmin={isSuperadmin} onOpenOrder={onOpenOrder} />
          ) : (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
              {/* 1. Summary */}
              <Panel delay={40}>
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-bold text-slate-900">Summary</h2>
                  {otherDays && <RangeMenu preset={preset} label={dateLabel} onChange={choosePreset} />}
                </div>

                <div className="mt-3">
                  <Gauge pct={goalPct} goalLabel={`${goalPct}% of ${formatPaise(goalTotal).replace(/\.00$/, '')} goal`}>
                    <p className="text-xs font-medium text-slate-500">Sales</p>
                    <p className="text-2xl font-black tracking-tight text-slate-900">
                      <Money paise={t.net} hidden={hidden} />
                    </p>
                  </Gauge>
                </div>
                <div className="mt-2 flex items-center justify-center gap-2 text-[11px] text-slate-500">
                  {editGoal ? (
                    <form
                      className="flex items-center gap-1.5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const v = Number(new FormData(e.currentTarget).get('goal'));
                        if (v > 0) {
                          setGoalPaise(Math.round(v * 100));
                          try {
                            localStorage.setItem('salesGoalPaise', String(Math.round(v * 100)));
                          } catch {
                            /* private mode: goal just isn't remembered */
                          }
                        }
                        setEditGoal(false);
                      }}
                    >
                      ₹
                      <input name="goal" type="number" min="1" step="1" autoFocus defaultValue={goalPaise / 100} aria-label="Daily sales goal in rupees" className="h-7 w-24 rounded-full bg-white px-3 text-xs font-bold text-slate-800 ring-1 ring-slate-200 outline-none focus:ring-2 focus:ring-orange-400" />
                      /day
                      <button type="submit" className="rounded-full bg-slate-900 px-2.5 py-1 font-bold text-white">Save</button>
                    </form>
                  ) : (
                    <button type="button" onClick={() => setEditGoal(true)} className="rounded-full px-2 py-1 font-semibold transition-colors hover:bg-white/80 hover:text-slate-800">
                      Daily goal {formatPaise(goalPaise).replace(/\.00$/, '')} · Edit
                    </button>
                  )}
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div className="rounded-2xl bg-white/90 px-3 py-2 text-xs ring-1 ring-slate-100">
                    <span className="text-slate-400">Avg order: </span>
                    <span className="font-bold text-emerald-600 tabular-nums">+ {hidden ? '••••' : formatPaise(t.avg)}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setTab('credit')}
                    className="rounded-2xl bg-amber-50 px-3 py-2 text-left text-xs ring-1 ring-amber-100 transition-all hover:shadow-md active:scale-[0.97]"
                  >
                    <span className="text-amber-700/70">Credit owed: </span>
                    <span className="font-bold text-amber-700 tabular-nums">{hidden ? '••••' : formatPaise(t.creditOwed)}</span>
                  </button>
                </div>

                <div className="mt-4 grid grid-cols-4 gap-2">
                  {(
                    [
                      { label: 'Orders', icon: ShoppingBag, value: t.orders, tint: 'bg-sky-100 text-sky-600', go: () => setTab('history') },
                      { label: 'Items', icon: UtensilsCrossed, value: t.items, tint: 'bg-orange-100 text-orange-600' },
                      { label: 'Cash', icon: Banknote, money: t.cash, tint: 'bg-emerald-100 text-emerald-600' },
                      { label: 'UPI', icon: Smartphone, money: t.digital, tint: 'bg-violet-100 text-violet-600' },
                    ] as const
                  ).map((s, i) => {
                    const Tile = s.label === 'Orders' ? 'button' : 'div';
                    return (
                      <Tile
                        key={s.label}
                        {...(s.label === 'Orders' ? { type: 'button' as const, onClick: () => setTab('history') } : {})}
                        className="group animate-card-rise rounded-2xl bg-white/90 p-2 text-center ring-1 ring-slate-100 transition-all duration-200 hover:-translate-y-1 hover:shadow-md active:scale-95"
                        style={{ animationDelay: `${160 + i * 70}ms` }}
                      >
                        <span className={cx('mx-auto flex h-10 w-10 items-center justify-center rounded-xl transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-6', s.tint)}>
                          <s.icon size={18} aria-hidden />
                        </span>
                        <span className="mt-1.5 block text-[11px] font-semibold text-slate-600">{s.label}</span>
                        <span className="block truncate text-[11px] font-bold text-slate-900">
                          {'money' in s ? (hidden ? '••••' : `₹${compact(s.money)}`) : <Count value={s.value} />}
                        </span>
                      </Tile>
                    );
                  })}
                </div>

                <div className="mt-5 flex items-center justify-between">
                  <h3 className="text-sm font-bold text-slate-900">Transactions</h3>
                  <button type="button" onClick={() => setTab('history')} className="text-xs font-semibold text-orange-600 transition-colors hover:text-orange-700">
                    View all
                  </button>
                </div>
                <ul className="mt-2 space-y-2">
                  {recent.length === 0 ? (
                    <li className="rounded-2xl bg-white/70 py-6 text-center text-xs font-medium text-slate-400">No orders yet</li>
                  ) : (
                    recent.map((r, i) => <TxRow key={r.id} row={r} index={i} hidden={hidden} onOpen={() => onOpenOrder(r.id)} />)
                  )}
                </ul>
              </Panel>

              {/* 2. Total sales chart */}
              <Panel delay={120}>
                <p className="text-xs font-medium text-slate-500">Total sales</p>
                <div className="mt-0.5 flex items-center gap-2">
                  <p className="text-3xl font-black tracking-tight text-slate-900">
                    <Money paise={t.net} hidden={hidden} />
                  </p>
                  <button
                    type="button"
                    aria-label={hidden ? 'Show amounts' : 'Hide amounts'}
                    aria-pressed={hidden}
                    onClick={() => setHidden((h) => !h)}
                    className="flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-slate-500 shadow-sm transition-all hover:text-slate-900 active:scale-90"
                  >
                    {hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                  {delta !== null && !hidden && (
                    <span key={delta} className={cx('animate-pop rounded-full px-2 py-0.5 text-[11px] font-bold', delta >= 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-600')}>
                      {delta >= 0 ? '+' : ''}
                      {delta}%
                    </span>
                  )}
                </div>

                <div className="mt-4 rounded-[26px] bg-white/90 p-4 ring-1 ring-slate-100">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-bold text-slate-900">{isSingleDay ? 'Sales by hour' : 'Sales by day'}</h3>
                    </div>

                  <div className="mt-4 flex gap-2">
                    <div className="flex h-44 w-8 shrink-0 flex-col justify-between text-right text-[10px] leading-none text-slate-400 tabular-nums">
                      {[1, 2 / 3, 1 / 3, 0].map((f) => (
                        <span key={f}>{hidden ? '' : compact(axisMax * f)}</span>
                      ))}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="relative h-44">
                        {[0, 1, 2, 3].map((n) => (
                          <span key={n} className="absolute right-0 left-0 border-t border-dashed border-slate-200" style={{ top: `${(n / 3) * 100}%` }} />
                        ))}
                        <div key={chartKey} className="absolute inset-0 flex items-end gap-1">
                          {bars.map((b, i) => {
                            const on = i === active;
                            const h = b.value > 0 ? Math.max(5, (b.value / axisMax) * 100) : 2;
                            return (
                              <button
                                key={i}
                                type="button"
                                aria-label={`${b.label}: ${formatPaise(b.value)}`}
                                onClick={() => setPicked(i)}
                                onMouseEnter={() => setPicked(i)}
                                className="group relative flex h-full min-w-0 flex-1 items-end justify-center"
                              >
                                {on && b.value > 0 && (
                                  <span className="absolute left-1/2 z-10 -translate-x-1/2" style={{ bottom: `calc(${h}% + 8px)` }}>
                                    <span key={`${chartKey}${i}`} className="block animate-pop rounded-full bg-slate-900 px-2 py-0.5 text-[10px] font-bold whitespace-nowrap text-white shadow-lg">
                                      {hidden ? '••••' : `₹${compact(b.value)}`}
                                    </span>
                                  </span>
                                )}
                                <span
                                  className={cx(
                                    'block w-full max-w-6 origin-bottom animate-bar-rise rounded-full transition-colors duration-300',
                                    on ? 'bg-linear-to-t from-teal-500 to-teal-300 shadow-[0_6px_16px_-4px_rgba(20,184,166,0.6)]' : 'bg-slate-200/80 group-hover:bg-teal-200',
                                  )}
                                  style={{ height: `${h}%`, animationDelay: `${i * 45}ms` }}
                                />
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <div className="mt-2 flex gap-1">
                        {bars.map((b, i) => (
                          <span key={i} className={cx('min-w-0 flex-1 text-center text-[10px] whitespace-nowrap', i === active ? 'font-bold text-slate-900' : 'text-slate-400', i % labelEvery !== 0 && 'invisible')}>
                            {b.label}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div className="rounded-2xl bg-white/90 px-3 py-2.5 ring-1 ring-slate-100">
                    <p className="text-[11px] text-slate-400">Paid orders</p>
                    <p className="text-lg font-extrabold text-slate-900"><Count value={t.paid} /><span className="text-xs font-semibold text-slate-400"> / {t.orders}</span></p>
                  </div>
                  <div className="rounded-2xl bg-white/90 px-3 py-2.5 ring-1 ring-slate-100">
                    <p className="text-[11px] text-slate-400">Items sold</p>
                    <p className="text-lg font-extrabold text-slate-900"><Count value={t.items} /></p>
                  </div>
                </div>
              </Panel>

              {/* 3. Items */}
              <Panel delay={200}>
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-bold text-slate-900">Items</h2>
                  <span className="text-xs font-semibold text-slate-400">{isSingleDay ? dateLabel : 'Top sellers'}</span>
                </div>
                <ul className="mt-3 space-y-2.5">
                  {items.length === 0 ? (
                    <li className="rounded-2xl bg-white/70 py-10 text-center text-xs font-medium text-slate-400">No items sold in this period</li>
                  ) : (
                    items.map((it, i) => (
                      <li
                        key={`${chartKey}${it.name}`}
                        className="group animate-card-rise rounded-[22px] bg-white/90 p-3 ring-1 ring-slate-100 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
                        style={{ animationDelay: `${240 + i * 70}ms` }}
                      >
                        <div className="flex items-center gap-3">
                          <span className={cx('flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-sm font-black', ['bg-orange-100 text-orange-600', 'bg-teal-100 text-teal-600', 'bg-sky-100 text-sky-600', 'bg-violet-100 text-violet-600', 'bg-rose-100 text-rose-600', 'bg-amber-100 text-amber-600'][i % 6])}>
                            {i + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-bold text-slate-900">{it.name}</p>
                            <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400">
                              <span className="rounded-full bg-emerald-500 px-1.5 py-px font-bold text-white">{it.quantity} sold</span>
                            </p>
                          </div>
                          <span className="flex items-center gap-0.5 text-sm font-extrabold text-emerald-600 tabular-nums">
                            +{hidden ? '••••' : formatPaise(it.revenuePaise)}
                            <ArrowUpRight size={14} aria-hidden />
                          </span>
                        </div>
                        <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className="h-full origin-left animate-[grow_900ms_cubic-bezier(0.16,1,0.3,1)_both] rounded-full bg-linear-to-r from-teal-400 to-orange-300"
                            style={{ width: `${(it.quantity / maxQty) * 100}%`, animationDelay: `${300 + i * 70}ms` }}
                          />
                        </div>
                      </li>
                    ))
                  )}
                </ul>
              </Panel>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TxRow({ row: r, index, hidden, onOpen }: { row: HistoryRow; index: number; hidden: boolean; onOpen: () => void }) {
  const cancelled = r.status === 'CANCELLED';
  const badge = BADGE[cancelled ? 'CANCELLED' : r.paymentStatus === 'PAID' && r.paymentMethod === 'CREDIT' ? 'CREDIT' : r.paymentStatus] ?? BADGE.UNPAID;
  const refunded = r.paymentStatus === 'REFUNDED';
  const Icon = r.orderType === 'DINE_IN' ? UtensilsCrossed : ShoppingBag;
  const time = new Date(r.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  return (
    <li className="animate-card-rise" style={{ animationDelay: `${220 + index * 70}ms` }}>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 rounded-2xl bg-white/90 p-2.5 text-left ring-1 ring-slate-100 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md active:scale-[0.98]"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-orange-100 text-orange-500">
          <Icon size={17} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold text-slate-900">#{r.orderNumber}</span>
          <span className="block truncate text-[11px] text-slate-400">
            {r.orderType === 'DINE_IN' ? (r.tableNumber ? `Table ${r.tableNumber}` : 'Dine-in') : 'Takeaway'} · {time}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className={cx('text-sm font-extrabold tabular-nums', cancelled ? 'text-slate-400 line-through' : refunded ? 'text-rose-500' : 'text-emerald-600')}>
            {refunded ? '−' : '+'}
            {hidden ? '••••' : formatPaise(r.totalPaise)}
          </span>
          <span className={cx('rounded-full px-1.5 py-px text-[10px] font-bold', badge.cls)}>{badge.label}</span>
        </span>
      </button>
    </li>
  );
}
