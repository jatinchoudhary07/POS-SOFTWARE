import {
  Banknote,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock,
  Crown,
  HandCoins,
  LayoutDashboard,
  Loader2,
  Package,
  Percent,
  Receipt,
  ReceiptText,
  RotateCcw,
  RotateCw,
  Smartphone,
  Sparkles,
  TrendingUp,
  Utensils,
  UtensilsCrossed,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { Analytics } from '../../api/types';
import { cx } from '../../lib/cx';
import { formatPaise } from '../../lib/money';
import { useLiveOrders } from '../../state/LiveOrders';
import { Button, IconButton } from '../ui/Button';
import { inputClass } from '../ui/fields';
import { Card, Columns, compactRupees, Delta, RankBars, SERIES, Split } from './charts';
import { fromKey, hourLabel, hourWindow, PRESET_LABELS, presetRange, shortDate, shiftDay, toKey, type Preset } from './dates';
import { CreditBook } from '../CreditBook';
import { OrderHistory } from './OrderHistory';

type Section = 'overview' | 'items' | 'history' | 'credit';
const SECTIONS: { value: Section; label: string; icon: typeof LayoutDashboard }[] = [
  { value: 'overview', label: 'Executive Overview', icon: LayoutDashboard },
  { value: 'items', label: 'Menu Performance', icon: Utensils },
  { value: 'history', label: 'Order History', icon: ReceiptText },
  { value: 'credit', label: 'Credit', icon: HandCoins },
];

const ordersCount = (n: number) => `${n} ${n === 1 ? 'order' : 'orders'}`;

export function Dashboard({
  onOpenOrder,
  onSwitchToPhone,
}: {
  onOpenOrder: (orderId: number) => void;
  onSwitchToPhone?: () => void;
}) {
  const { subscribe } = useLiveOrders();
  const [preset, setPreset] = useState<Preset>('today');
  const [range, setRange] = useState(() => presetRange('today'));
  const [section, setSection] = useState<Section>('overview');
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.analytics(range.from, range.to));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the dashboard');
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  // Ranges that include today follow live orders and payments.
  const includesToday = range.to === toKey(new Date());
  useEffect(() => (includesToday ? subscribe(() => void load()) : undefined), [includesToday, subscribe, load]);

  const isSingleDay = range.from === range.to;
  const todayKey = toKey(new Date());
  const isToday = isSingleDay && range.from === todayKey;

  function choose(p: Preset) {
    setPreset(p);
    if (p !== 'custom') setRange(presetRange(p));
  }

  function stepDay(offset: number) {
    const baseDate = isSingleDay ? range.from : offset < 0 ? range.from : range.to;
    const target = shiftDay(baseDate, offset);
    if (target > todayKey) return;
    setRange({ from: target, to: target });
    if (target === todayKey) {
      setPreset('today');
    } else if (target === shiftDay(todayKey, -1)) {
      setPreset('yesterday');
    } else {
      setPreset('custom');
    }
  }

  function pickDate(dateStr: string) {
    if (!dateStr || dateStr > todayKey) return;
    setRange({ from: dateStr, to: dateStr });
    if (dateStr === todayKey) {
      setPreset('today');
    } else if (dateStr === shiftDay(todayKey, -1)) {
      setPreset('yesterday');
    } else {
      setPreset('custom');
    }
  }

  const rangeLabel =
    range.from === range.to
      ? fromKey(range.from).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      : `${shortDate(range.from)} – ${shortDate(range.to)}, ${fromKey(range.to).getFullYear()}`;

  const insights = useMemo(() => {
    if (!data) return null;
    const hour = data.byHour.reduce((best, h, i) => (h.count > data.byHour[best].count ? i : best), 0);
    const weekday = data.byWeekday.reduce((best, h, i) => (h.totalPaise > data.byWeekday[best].totalPaise ? i : best), 0);
    const bestDay = data.byDay.reduce((best, d) => (d.netPaise > best.netPaise ? d : best), data.byDay[0]);
    return { hour, weekday, bestDay };
  }, [data]);

  return (
    <div className="flex min-h-0 min-w-0 w-full max-w-full flex-1 flex-col overflow-y-auto overflow-x-hidden bg-canvas">
      {/* Top Glassmorphism Dashboard Header */}
      <div className="border-b border-line bg-surface/90 px-4 pt-4 pb-3.5 backdrop-blur-md sm:px-6">
        <div className="flex flex-col gap-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-black tracking-tight text-ink sm:text-2xl">Sales & Analytics</h1>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-800 ring-1 ring-emerald-500/20">
                <span className="h-2 w-2 rounded-full bg-emerald-600 animate-pulse" />
                Live Sync
              </span>
            </div>

            {/* Date Stepper Slider (< Date >) & Direct Calendar Picker */}
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1 rounded-control bg-fill p-1 ring-1 ring-line/80">
                <IconButton
                  icon={ChevronLeft}
                  variant="plain"
                  aria-label="Previous day"
                  className="h-8 w-8 hover:bg-surface cursor-pointer text-ink-2 hover:text-ink"
                  onClick={() => stepDay(-1)}
                  title="Step backward 1 day"
                />

                {/* Interactive Date Pill with Native Calendar Datepicker Picker */}
                <div className="relative flex items-center gap-2 px-2.5 py-1 text-xs sm:text-sm font-bold text-ink cursor-pointer hover:text-accent group select-none">
                  <CalendarDays size={15} className="text-accent shrink-0 group-hover:scale-110 transition-transform" aria-hidden />
                  <span className="min-w-36 text-center truncate sm:min-w-48">
                    {rangeLabel}
                  </span>
                  <input
                    type="date"
                    max={todayKey}
                    value={isSingleDay ? range.from : range.to}
                    onChange={(e) => e.target.value && pickDate(e.target.value)}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    title="Click to select any specific date from calendar"
                  />
                </div>

                <IconButton
                  icon={ChevronRight}
                  variant="plain"
                  aria-label="Next day"
                  disabled={isToday}
                  className={cx(
                    'h-8 w-8 hover:bg-surface cursor-pointer text-ink-2 hover:text-ink',
                    isToday && 'opacity-25 cursor-not-allowed hover:bg-transparent',
                  )}
                  onClick={() => stepDay(1)}
                  title={isToday ? 'Already at today' : 'Step forward 1 day'}
                />
              </div>

              {/* Jump to Today Button */}
              {!isToday && (
                <button
                  type="button"
                  onClick={() => choose('today')}
                  className="inline-flex h-9 items-center rounded-control bg-accent-tint px-3.5 text-xs font-bold text-accent hover:bg-accent hover:text-white transition-all cursor-pointer shadow-2xs"
                  title="Jump back to today"
                >
                  Today
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {onSwitchToPhone && (
              <Button
                icon={Smartphone}
                variant="secondary"
                onClick={onSwitchToPhone}
                className="text-xs sm:text-sm font-semibold shadow-2xs border-orange-200 text-orange-600 hover:bg-orange-50"
              >
                Phone UI
              </Button>
            )}
            <Button
              icon={RotateCw}
              variant="secondary"
              loading={loading}
              disabled={loading}
              onClick={() => void load()}
              className="text-xs sm:text-sm font-semibold shadow-2xs"
            >
              Refresh
            </Button>
          </div>
        </div>

        {/* Date Presets Segmented Pills */}
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <div className="no-scrollbar flex overflow-x-auto rounded-control bg-fill p-1">
            {(Object.keys(PRESET_LABELS) as Preset[]).map((p) => {
              const active = preset === p;
              return (
                <button
                  key={p}
                  type="button"
                  aria-pressed={active}
                  onClick={() => choose(p)}
                  className={cx(
                    'inline-flex h-8 shrink-0 items-center rounded-[8px] px-3 text-xs font-bold whitespace-nowrap transition-all cursor-pointer',
                    active ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-ink-2 hover:text-ink',
                  )}
                >
                  {PRESET_LABELS[p]}
                </button>
              );
            })}
          </div>

          {preset === 'custom' && (
            <div className="flex shrink-0 items-center gap-2 rounded-control bg-surface px-2.5 py-1 ring-1 ring-line shadow-xs">
              <span className="text-xs font-bold text-ink-2">From</span>
              <input
                type="date"
                aria-label="From date"
                value={range.from}
                max={range.to || todayKey}
                onChange={(e) => {
                  if (e.target.value) {
                    const newFrom = e.target.value;
                    setRange((r) => ({
                      from: newFrom,
                      to: r.to < newFrom ? newFrom : r.to,
                    }));
                  }
                }}
                className={cx(inputClass, 'h-7 w-auto px-2 text-xs font-semibold')}
              />
              <span className="text-xs font-bold text-ink-3">to</span>
              <input
                type="date"
                aria-label="To date"
                value={range.to}
                min={range.from}
                max={todayKey}
                onChange={(e) => {
                  if (e.target.value) {
                    const newTo = e.target.value;
                    setRange((r) => ({
                      from: r.from > newTo ? newTo : r.from,
                      to: newTo,
                    }));
                  }
                }}
                className={cx(inputClass, 'h-7 w-auto px-2 text-xs font-semibold')}
              />
            </div>
          )}
        </div>

        {/* Section Navigation Tabs */}
        <div role="tablist" aria-label="Dashboard sections" className="mt-4 no-scrollbar flex gap-2 overflow-x-auto border-t border-line/70 pt-3">
          {SECTIONS.map((s) => {
            const active = section === s.value;
            const Icon = s.icon;
            return (
              <button
                key={s.value}
                role="tab"
                type="button"
                aria-selected={active}
                onClick={() => setSection(s.value)}
                className={cx(
                  'inline-flex items-center gap-2 rounded-control px-3.5 py-2 text-xs sm:text-sm font-bold whitespace-nowrap transition-all cursor-pointer',
                  active
                    ? 'bg-accent text-white shadow-xs'
                    : 'text-ink-2 hover:bg-fill/60 hover:text-ink',
                )}
              >
                <Icon size={15} aria-hidden />
                <span>{s.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Content Body */}
      <div className="space-y-5 px-4 pt-4 pb-24 sm:px-6 md:pb-8">
        {error && (
          <div role="alert" className="flex items-center gap-2 rounded-control bg-danger-tint px-4 py-3 text-sm font-medium text-danger">
            <CircleAlert size={18} aria-hidden /> {error}
          </div>
        )}

        {section === 'credit' ? (
          <CreditBook light />
        ) : section === 'history' ? (
          <OrderHistory from={range.from} to={range.to} onOpenOrder={onOpenOrder} />
        ) : !data || !insights ? (
          !error && (
            <div className="flex h-72 items-center justify-center gap-2 text-ink-2">
              <Loader2 size={24} className="animate-spin text-accent" aria-hidden />
              <span className="font-semibold">Loading cafe analytics...</span>
            </div>
          )
        ) : section === 'overview' ? (
          <Overview data={data} insights={insights} />
        ) : (
          <MenuPerformance data={data} />
        )}
      </div>
    </div>
  );
}

/**
 * Modern Unified Bento Matrix:
 * 1. Revenue Spotlight Hero + 2 Companion Cards
 * 2. Cafe Intelligence Strip (Peak hour, star item, channel mix, star table)
 * 3. Interactive Chart with ₹ Revenue vs # Orders toggle
 * 4. Payment Modes + Table Leaderboard + Financial Audit
 */
function Overview({
  data,
  insights,
}: {
  data: Analytics;
  insights: { hour: number; weekday: number; bestDay: { date: string; netPaise: number } };
}) {
  const t = data.totals;
  const p = data.previous;
  const single = data.days === 1;
  const hasSales = t.paidCount > 0;
  const [chartMetric, setChartMetric] = useState<'revenue' | 'orders'>('revenue');

  // Hourly range calculation
  const active = data.byHour.map((h, i) => (h.count > 0 ? i : -1)).filter((i) => i >= 0);
  const { lo: h0, hi: h1 } = hourWindow(active);

  // Chart datasets
  const hourlyRevenueData = data.byHour.slice(h0, h1 + 1).map((h, i) => ({
    label: hourLabel(h0 + i).replace(' ', '').toLowerCase(),
    value: h.totalPaise,
    tip: `${formatPaise(h.totalPaise)} · ${ordersCount(h.count)}`,
  }));

  const hourlyOrdersData = data.byHour.slice(h0, h1 + 1).map((h, i) => ({
    label: hourLabel(h0 + i).replace(' ', '').toLowerCase(),
    value: h.count,
    tip: `${ordersCount(h.count)} · ${formatPaise(h.totalPaise)}`,
  }));

  const dailyRevenueData = data.byDay.map((d) => ({
    label: shortDate(d.date),
    value: d.netPaise,
    tip: `${formatPaise(d.netPaise)} · ${ordersCount(d.orders)}`,
  }));

  const dailyOrdersData = data.byDay.map((d) => ({
    label: shortDate(d.date),
    value: d.orders,
    tip: `${ordersCount(d.orders)} · ${formatPaise(d.netPaise)}`,
  }));

  const activeChartData = single
    ? chartMetric === 'revenue'
      ? hourlyRevenueData
      : hourlyOrdersData
    : chartMetric === 'revenue'
      ? dailyRevenueData
      : dailyOrdersData;

  const takeawayPct = Math.round((data.byType.TAKEAWAY.count / Math.max(1, t.paidCount)) * 100);
  const dineInPct = 100 - takeawayPct;

  return (
    <div className="space-y-5">
      {/* 1. Bento Executive Hero Matrix */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Left Hero Card: Revenue Spotlight (Col 1-7) - Solid Minimalist Dark Slate */}
        <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6 text-white shadow-md lg:col-span-7">
          <div className="relative z-10 flex flex-col justify-between h-full">
            <div>
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-bold uppercase tracking-wider text-rose-200 backdrop-blur-xs">
                  <Sparkles size={12} className="text-amber-400" />
                  Net Revenue
                </span>
                <Delta now={t.netPaise} before={p.netPaise} className="bg-white/95" />
              </div>

              <div className="mt-4">
                <span className="text-3xl sm:text-4xl lg:text-5xl font-black tracking-tight tabular-nums text-white">
                  {formatPaise(t.netPaise)}
                </span>
                <p className="mt-1.5 text-xs sm:text-sm font-medium text-rose-200/80">
                  {formatPaise(t.grossPaise)} gross sales
                </p>
              </div>
            </div>

            {/* Embedded Micro-Ledger Ribbon */}
            <div className="mt-6 grid grid-cols-3 gap-2.5 rounded-control bg-white/5 p-3 backdrop-blur-xs border border-white/10">
              <div>
                <p className="text-[11px] font-semibold text-rose-200/70">Discounts</p>
                <p className="text-sm font-bold tabular-nums text-white">{formatPaise(t.discountPaise)}</p>
              </div>
              <div>
                <p className="text-[11px] font-semibold text-rose-200/70">Tax Collected</p>
                <p className="text-sm font-bold tabular-nums text-white">{formatPaise(t.taxPaise)}</p>
              </div>
              <div>
                <p className="text-[11px] font-semibold text-rose-200/70">Paid Orders</p>
                <p className="text-sm font-bold tabular-nums text-white">{t.paidCount}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Right Companion Card 1: Orders Fulfillment (Col 8-9) */}
        <div className="flex flex-col justify-between rounded-card border border-line/70 bg-surface p-5 shadow-xs lg:col-span-3">
          <div>
            <div className="flex items-center justify-between">
              <span className="flex h-10 w-10 items-center justify-center rounded-control bg-emerald-50 text-emerald-600 ring-1 ring-emerald-500/20">
                <Receipt size={18} />
              </span>
              <Delta now={t.paidCount} before={p.paidCount} />
            </div>
            <p className="mt-3 text-xs font-bold uppercase tracking-wider text-ink-3">Orders Settled</p>
            <p className="mt-1 text-3xl font-black tracking-tight tabular-nums text-ink">{t.paidCount}</p>
          </div>

          <div className="mt-4 pt-3 border-t border-line/60">
            <div className="flex items-center justify-between text-xs font-semibold text-ink-2">
              <span>Conversion</span>
              <span className="text-emerald-700 font-bold">
                {t.orderCount > 0 ? `${Math.round((t.paidCount / t.orderCount) * 100)}%` : '100%'}
              </span>
            </div>
            <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-fill">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all duration-300"
                style={{
                  width: `${t.orderCount > 0 ? Math.min(100, Math.round((t.paidCount / t.orderCount) * 100)) : 100}%`,
                }}
              />
            </div>
            <p className="mt-1.5 text-[11px] text-ink-3">
              {t.orderCount} placed &bull; {t.cancelledCount} cancelled
            </p>
          </div>
        </div>

        {/* Right Companion Card 2: Average Order Value & Basket (Col 10-12) */}
        <div className="flex flex-col justify-between rounded-card border border-line/70 bg-surface p-5 shadow-xs lg:col-span-2">
          <div>
            <div className="flex items-center justify-between">
              <span className="flex h-10 w-10 items-center justify-center rounded-control bg-blue-50 text-blue-600 ring-1 ring-blue-500/20">
                <Banknote size={18} />
              </span>
              <Delta now={t.avgOrderPaise} before={p.avgOrderPaise} />
            </div>
            <p className="mt-3 text-xs font-bold uppercase tracking-wider text-ink-3">Avg Order Value</p>
            <p className="mt-1 text-2xl font-black tracking-tight tabular-nums text-ink">{formatPaise(t.avgOrderPaise)}</p>
          </div>

          <div className="mt-4 pt-3 border-t border-line/60">
            <div className="flex items-center justify-between text-xs font-semibold text-ink-2">
              <span>Basket Size</span>
              <span className="text-blue-700 font-bold">{t.itemsSold} items</span>
            </div>
            <p className="mt-1.5 text-[11px] text-ink-3">
              {t.paidCount ? `${(t.itemsSold / t.paidCount).toFixed(1)} items / order` : '—'}
            </p>
          </div>
        </div>
      </div>

      {/* 2. Cafe Live Intelligence Strip (Replaces the 4 disjointed mini-cards) */}
      {hasSales && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {/* Peak Trading Window */}
          <div className="flex items-center gap-3.5 rounded-card border border-line/70 bg-surface p-4 shadow-xs">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-control bg-amber-50 text-amber-600 ring-1 ring-amber-500/20">
              <Clock size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-bold uppercase tracking-wider text-ink-3">Peak Trading Hour</p>
              <p className="truncate text-sm font-bold text-ink">
                {hourLabel(insights.hour)} &ndash; {hourLabel((insights.hour + 1) % 24)}
              </p>
              <p className="text-xs font-medium text-ink-2">
                {ordersCount(data.byHour[insights.hour].count)} &bull; {formatPaise(data.byHour[insights.hour].totalPaise)}
              </p>
            </div>
          </div>

          {/* Best Selling Dish */}
          <div className="flex items-center gap-3.5 rounded-card border border-line/70 bg-surface p-4 shadow-xs">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-control bg-rose-50 text-rose-700 ring-1 ring-rose-500/20">
              <Crown size={20} className="text-amber-500" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-bold uppercase tracking-wider text-ink-3">Star Dish</p>
              <p className="truncate text-sm font-bold text-ink" title={data.topItems[0]?.name}>
                {data.topItems[0]?.name ?? '—'}
              </p>
              <p className="text-xs font-medium text-ink-2">
                {data.topItems[0] ? `${data.topItems[0].quantity} sold · ${formatPaise(data.topItems[0].revenuePaise)}` : '—'}
              </p>
            </div>
          </div>

          {/* Dining Channel Mix */}
          <div className="flex items-center gap-3.5 rounded-card border border-line/70 bg-surface p-4 shadow-xs">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-control bg-purple-50 text-purple-600 ring-1 ring-purple-500/20">
              <Package size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-bold uppercase tracking-wider text-ink-3">Channel Mix</p>
                <span className="text-xs font-bold text-ink">{dineInPct}% Dine-in</span>
              </div>
              <div className="mt-1 flex h-2 w-full overflow-hidden rounded-full bg-fill">
                <div style={{ width: `${dineInPct}%` }} className="bg-purple-600 h-full" title={`Dine-in: ${dineInPct}%`} />
                <div style={{ width: `${takeawayPct}%` }} className="bg-amber-500 h-full" title={`Packing: ${takeawayPct}%`} />
              </div>
              <p className="mt-1 text-xs font-medium text-ink-2">
                {data.byType.DINE_IN.count} dine-in &bull; {data.byType.TAKEAWAY.count} packing
              </p>
            </div>
          </div>

          {/* Star Dining Table */}
          <div className="flex items-center gap-3.5 rounded-card border border-line/70 bg-surface p-4 shadow-xs">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-control bg-emerald-50 text-emerald-600 ring-1 ring-emerald-500/20">
              <UtensilsCrossed size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-bold uppercase tracking-wider text-ink-3">Top Grossing Table</p>
              <p className="truncate text-sm font-bold text-ink">
                {data.byTable[0] ? `Table ${data.byTable[0].table}` : 'No table orders'}
              </p>
              <p className="text-xs font-medium text-ink-2">
                {data.byTable[0] ? `${formatPaise(data.byTable[0].totalPaise)} · ${ordersCount(data.byTable[0].count)}` : '—'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* 3. Interactive Main Chart: Hourly Sales Velocity / Daily Revenue Trend */}
      <Card
        title={single ? 'Sales Velocity by Hour' : 'Revenue Trend'}
        subtitle={single ? 'Performance by time of day' : 'Net sales per day over time'}
        action={
          <div className="flex items-center rounded-control bg-fill p-0.5">
            <button
              type="button"
              onClick={() => setChartMetric('revenue')}
              className={cx(
                'rounded-[6px] px-2.5 py-1 text-xs font-bold transition-all cursor-pointer',
                chartMetric === 'revenue' ? 'bg-surface text-ink shadow-2xs' : 'text-ink-2 hover:text-ink',
              )}
            >
              ₹ Revenue
            </button>
            <button
              type="button"
              onClick={() => setChartMetric('orders')}
              className={cx(
                'rounded-[6px] px-2.5 py-1 text-xs font-bold transition-all cursor-pointer',
                chartMetric === 'orders' ? 'bg-surface text-ink shadow-2xs' : 'text-ink-2 hover:text-ink',
              )}
            >
              # Orders
            </button>
          </div>
        }
      >
        {hasSales ? (
          <Columns
            data={activeChartData}
            format={chartMetric === 'revenue' ? compactRupees : (v) => String(Math.round(v))}
            labelEvery={single ? 2 : Math.max(1, Math.ceil(activeChartData.length / 10))}
            highlightMax
            barColor={chartMetric === 'revenue' ? SERIES[0] : SERIES[1]}
          />
        ) : (
          <p className="py-12 text-center text-sm font-medium text-ink-2">No sales recorded for this period yet.</p>
        )}
      </Card>

      {/* 4. Operations & Channel Distribution Bento */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Payment Methods */}
        <Card title="Payment Methods & Cash Flow" subtitle="Breakdown of collection channels">
          <Split
            parts={[
              { label: 'UPI (QR / Digital)', value: data.byMethod.UPI_MANUAL.totalPaise, color: SERIES[1], count: data.byMethod.UPI_MANUAL.count },
              { label: 'Cash', value: data.byMethod.CASH.totalPaise, color: SERIES[2], count: data.byMethod.CASH.count },
              { label: 'Card / Terminal', value: data.byMethod.TERMINAL.totalPaise, color: SERIES[4], count: data.byMethod.TERMINAL.count },
            ]}
          />
        </Card>

        {/* Order Fulfillment Types */}
        <Card title="Dine-in vs Packing" subtitle="Dining channel proportion">
          <Split
            parts={[
              { label: 'Dine-in', value: data.byType.DINE_IN.totalPaise, color: SERIES[4], count: data.byType.DINE_IN.count },
              { label: 'Takeaway / Packing', value: data.byType.TAKEAWAY.totalPaise, color: SERIES[3], count: data.byType.TAKEAWAY.count },
            ]}
          />
        </Card>

        {/* Dine-in Table Leaderboard */}
        <Card title="Table Turnover Leaderboard" subtitle="Dine-in revenue generated by each table">
          <RankBars
            data={data.byTable.map((x) => ({
              label: `Table ${x.table}`,
              value: x.totalPaise,
              valueLabel: formatPaise(x.totalPaise),
              sub: ordersCount(x.count),
            }))}
            color={SERIES[4]}
            empty="No dine-in orders with tables recorded yet."
          />
        </Card>

        {/* Financial Audit & Ledger */}
        <Card title="Financial Audit & Taxes" subtitle="Reconciliation summary">
          <dl className="divide-y divide-line/60 text-sm">
            {[
              { icon: TrendingUp, label: 'Gross Revenue', value: formatPaise(t.grossPaise), tone: 'ink' },
              { icon: Percent, label: 'Discounts Given', value: formatPaise(t.discountPaise), tone: 'ink-2' },
              { icon: ReceiptText, label: 'Tax Collected (GST)', value: formatPaise(t.taxPaise), tone: 'ink-2' },
              { icon: RotateCcw, label: 'Cancelled Orders', value: String(t.cancelledCount), tone: t.cancelledCount > 0 ? 'rose' : 'ink-2' },
            ].map(({ icon: Icon, label, value, tone }) => (
              <div key={label} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                <div className="flex items-center gap-2.5">
                  <Icon size={16} className="text-ink-3" aria-hidden />
                  <span className="font-medium text-ink-2">{label}</span>
                </div>
                <span
                  className={cx(
                    'font-bold tabular-nums',
                    tone === 'rose' ? 'text-rose-600' : 'text-ink',
                  )}
                >
                  {value}
                </span>
              </div>
            ))}
          </dl>
        </Card>
      </div>

      <p className="text-xs text-ink-3 text-center sm:text-left">
        * Analytics update in real time with completed payments and verified order closures.
      </p>
    </div>
  );
}

/**
 * Menu Performance Section
 */
function MenuPerformance({ data }: { data: Analytics }) {
  const totalRevenue = data.byCategory.reduce((s, c) => s + c.revenuePaise, 0) || 1;

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-2">
        {/* Best Sellers */}
        <Card
          title="Best Sellers"
          subtitle="Top performing dishes by quantity ordered"
          action={
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-bold text-amber-800 ring-1 ring-amber-300">
              <Crown size={12} /> Top Rank
            </span>
          }
        >
          <RankBars
            data={data.topItems.map((i) => ({
              label: i.name,
              value: i.quantity,
              valueLabel: `${i.quantity} sold`,
              sub: formatPaise(i.revenuePaise),
            }))}
            color={SERIES[0]}
            empty="No items sold in this period."
          />
        </Card>

        {/* Category Share & Slow Movers */}
        <div className="space-y-5">
          <Card title="Sales by Category" subtitle="Revenue share per food & beverage category">
            <RankBars
              data={data.byCategory.slice(0, 8).map((c) => ({
                label: c.category,
                value: c.revenuePaise,
                valueLabel: formatPaise(c.revenuePaise),
                sub: `${Math.round((c.revenuePaise / totalRevenue) * 100)}% · ${c.quantity} sold`,
              }))}
              color={SERIES[1]}
              empty="No items sold in this period."
            />
          </Card>

          <Card title="Slow Movers" subtitle="Dishes sold least — consider specials or promos">
            <RankBars
              data={data.slowItems.map((i) => ({
                label: i.name,
                value: i.quantity,
                valueLabel: `${i.quantity} sold`,
                sub: formatPaise(i.revenuePaise),
              }))}
              color={SERIES[3]}
              empty="No items sold in this period."
            />
          </Card>
        </div>
      </div>

      <p className="text-xs text-ink-3">
        * Figures reflect historical sales at the actual sale price.
      </p>
    </div>
  );
}
