import { ArrowDownRight, ArrowUpRight, Crown, Minus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import { formatPaise } from '../../lib/money';

/** Vibrant, modern categorical series colors for youth cafe analytics. */
export const SERIES = [
  '#f43f5e', // Electric Rose (primary brand)
  '#0284c7', // Vibrant Sky/Electric Blue (UPI/digital)
  '#10b981', // Neon Emerald (Cash/success)
  '#f59e0b', // Sunny Amber (takeaway/packing)
  '#8b5cf6', // Electric Purple (tables)
] as const;

/** ₹950, ₹1.2k, ₹45k, ₹1.2L — for axis labels only; exact amounts use formatPaise. */
export function compactRupees(paise: number): string {
  const r = paise / 100;
  if (r >= 100_000) return `₹${+(r / 100_000).toFixed(1)}L`;
  if (r >= 1_000) return `₹${+(r / 1_000).toFixed(1)}k`;
  return `₹${Math.round(r)}`;
}

/** Nice round axis maximum so the gridlines land on tidy numbers. */
function niceMax(max: number): number {
  if (max <= 0) return 100;
  const pow = 10 ** Math.floor(Math.log10(max));
  const n = max / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

/** "+12%" / "−5%" / "new" compared with the previous period. Green = up, red = down. */
export function Delta({ now, before, className }: { now: number; before: number; className?: string }) {
  if (before === 0 && now === 0) return null;
  const pct = before === 0 ? null : Math.round(((now - before) / before) * 100);
  const up = pct === null || pct > 0;
  const flat = pct === 0;
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      title="Compared with the previous period of the same length"
      className={cx(
        'inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums shadow-2xs',
        flat
          ? 'bg-fill text-ink-2'
          : up
            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200/80 ring-1 ring-emerald-500/10'
            : 'bg-rose-50 text-rose-700 border border-rose-200/80 ring-1 ring-rose-500/10',
        className,
      )}
    >
      <Icon size={12} className={up ? 'text-emerald-600' : flat ? 'text-ink-3' : 'text-rose-600'} aria-hidden />
      {pct === null ? 'New' : `${Math.abs(pct)}%`}
    </span>
  );
}

export function Card({
  title,
  subtitle,
  action,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cx(
        'rounded-card border border-line/70 bg-surface p-5 shadow-xs transition-shadow hover:shadow-card',
        className,
      )}
      aria-label={title}
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-bold tracking-tight text-ink">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs font-medium text-ink-2">{subtitle}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}

export interface ColumnDatum {
  label: string;
  value: number; // paise or a count
  tip: string;
}

/**
 * Modern interactive vertical bar columns: rounded tops, gradient fills, quiet gridlines,
 * hover tooltips with exact values, and peak indicator.
 */
export function Columns({
  data,
  format,
  height = 190,
  labelEvery = 1,
  highlightMax = false,
  barColor = SERIES[0],
}: {
  data: ColumnDatum[];
  format: (v: number) => string;
  height?: number;
  labelEvery?: number;
  highlightMax?: boolean;
  barColor?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const top = Math.max(...data.map((d) => d.value));
  const ticks = [1, 0.5, 0];

  return (
    <div className="flex gap-2.5" style={{ height: height + 32 }}>
      {/* Y-Axis Labels */}
      <div
        className="flex shrink-0 flex-col justify-between pb-7 text-right text-[11px] font-medium text-ink-3 tabular-nums select-none"
        style={{ height: height + 32 }}
        aria-hidden
      >
        {ticks.map((t) => (
          <span key={t} className="leading-none">
            {format(max * t)}
          </span>
        ))}
      </div>

      {/* Bars Container */}
      <div className="relative min-w-0 flex-1">
        {/* Subtle Horizontal Gridlines */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col justify-between" style={{ height }} aria-hidden>
          {ticks.map((t) => (
            <div key={t} className={cx('h-px w-full', t === 0 ? 'bg-line-strong' : 'bg-line/50 border-t border-dashed border-line/60')} />
          ))}
        </div>

        {/* Columns */}
        <div className="relative flex items-end justify-between gap-1 sm:gap-1.5" style={{ height }} onMouseLeave={() => setHover(null)}>
          {data.map((d, i) => {
            const isTop = top > 0 && d.value === top;
            const pct = (d.value / max) * 100;
            const isHovered = hover === i;

            return (
              <div
                key={i}
                className="group relative flex h-full flex-1 items-end justify-center cursor-pointer"
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                tabIndex={0}
                aria-label={`${d.label}: ${d.tip}`}
              >
                {/* Max peak badge */}
                {highlightMax && isTop && !isHovered && (
                  <span className="pointer-events-none absolute -top-4 text-amber-500 animate-pulse">
                    <Crown size={12} />
                  </span>
                )}

                {/* The Bar */}
                <div
                  className="w-full max-w-[28px] rounded-t-[5px] transition-all duration-150"
                  style={{
                    height: `${pct}%`,
                    minHeight: d.value > 0 ? 4 : 0,
                    background: isTop && highlightMax
                      ? 'linear-gradient(180deg, #f59e0b 0%, #d97706 100%)'
                      : isHovered
                        ? barColor
                        : `linear-gradient(180deg, ${barColor} 0%, ${barColor}cc 100%)`,
                    opacity: hover !== null && !isHovered ? 0.35 : 1,
                    boxShadow: isHovered ? `0 0 10px ${barColor}66` : undefined,
                  }}
                />

                {/* Floating Tooltip */}
                {isHovered && (
                  <div
                    className="pointer-events-none absolute bottom-full z-20 mb-2 rounded-control bg-ink px-3 py-2 text-xs whitespace-nowrap text-white shadow-raised animate-fade"
                    style={{
                      left: i > data.length * 0.75 ? 'auto' : '50%',
                      right: i > data.length * 0.75 ? 0 : 'auto',
                      transform: i > data.length * 0.75 ? undefined : 'translateX(-50%)',
                    }}
                  >
                    <span className="block font-bold text-white/90">{d.label}</span>
                    <span className="mt-0.5 block font-mono font-semibold text-accent-tint">{d.tip}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* X-Axis Labels */}
        <div className="mt-2.5 flex justify-between gap-1 text-[11px] font-medium text-ink-2 select-none">
          {data.map((d, i) => (
            <span key={i} className="flex-1 text-center whitespace-nowrap">
              {i % labelEvery === 0 ? d.label : ''}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export interface BarDatum {
  label: string;
  value: number;
  valueLabel: string;
  sub?: string;
}

/** Horizontal ranked bars with sleek rank pills (#1, #2, #3 podium badges). */
export function RankBars({
  data,
  color = SERIES[0],
  empty = 'Nothing yet for this period.',
}: {
  data: BarDatum[];
  color?: string;
  empty?: string;
}) {
  if (data.length === 0) {
    return <p className="py-8 text-center text-sm font-medium text-ink-2">{empty}</p>;
  }

  const max = Math.max(...data.map((d) => d.value), 1);

  return (
    <ol className="space-y-3">
      {data.map((d, i) => {
        const isFirst = i === 0;
        const isSecond = i === 1;
        const isThird = i === 2;

        return (
          <li key={d.label + i} className="group rounded-control p-1.5 transition-colors hover:bg-fill/40">
            <div className="mb-1.5 flex items-center gap-2.5 text-sm">
              <span
                className={cx(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold tabular-nums',
                  isFirst
                    ? 'bg-amber-100 text-amber-800 ring-1 ring-amber-300'
                    : isSecond
                      ? 'bg-slate-100 text-slate-700 ring-1 ring-slate-300'
                      : isThird
                        ? 'bg-orange-100 text-orange-800 ring-1 ring-orange-300'
                        : 'bg-fill text-ink-3',
                )}
              >
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate font-semibold text-ink group-hover:text-accent-hover">
                {d.label}
              </span>
              <span className="shrink-0 font-bold tabular-nums text-ink">{d.valueLabel}</span>
            </div>

            <div className="flex items-center gap-3 pl-7">
              <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-fill">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${Math.max(2, (d.value / max) * 100)}%`,
                    background: color,
                  }}
                />
              </div>
              {d.sub && <span className="w-24 shrink-0 text-right text-xs font-medium text-ink-2 tabular-nums">{d.sub}</span>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export interface Part {
  label: string;
  value: number;
  color: string;
  count?: number;
}

/** One stacked bar showing shares of a whole, with a rich modern legend carrying figures and percentages. */
export function Split({ parts, money = true }: { parts: Part[]; money?: boolean }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (total === 0) return <p className="py-8 text-center text-sm font-medium text-ink-2">No sales in this period.</p>;
  const shown = parts.filter((p) => p.value > 0);

  return (
    <div className="space-y-4">
      {/* Visual Multi-Segment Bar */}
      <div
        className="flex h-3.5 w-full gap-1 overflow-hidden rounded-full bg-fill p-0.5 shadow-2xs"
        role="img"
        aria-label={parts.map((p) => `${p.label} ${Math.round((p.value / total) * 100)}%`).join(', ')}
      >
        {shown.map((p) => (
          <div
            key={p.label}
            className="h-full first:rounded-l-full last:rounded-r-full transition-all duration-300"
            style={{ width: `${(p.value / total) * 100}%`, background: p.color }}
          />
        ))}
      </div>

      {/* Legend & Breakdown List */}
      <ul className="space-y-2">
        {parts.map((p) => {
          const pct = Math.round((p.value / total) * 100);
          return (
            <li
              key={p.label}
              className="flex items-center justify-between gap-3 rounded-control px-2.5 py-1.5 transition-colors hover:bg-fill/50"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="h-3 w-3 shrink-0 rounded-[4px] shadow-2xs" style={{ background: p.color }} aria-hidden />
                <span className="truncate text-sm font-semibold text-ink">{p.label}</span>
                {p.count !== undefined && (
                  <span className="text-xs text-ink-3">({p.count} {p.count === 1 ? 'order' : 'orders'})</span>
                )}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="font-bold tabular-nums text-ink text-sm">
                  {money ? formatPaise(p.value) : p.value}
                </span>
                <span className="min-w-10 rounded-full bg-fill px-2 py-0.5 text-right text-xs font-semibold tabular-nums text-ink-2">
                  {pct}%
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
