import { Ban, Plus, Search, SearchX, X } from 'lucide-react';
import type { MenuItem } from '../api/types';
import { cx } from '../lib/cx';
import { formatPaise } from '../lib/money';
import { AnimatedValue } from './ui/AnimatedValue';

interface Props {
  viewKey: string;
  title: string;
  items: MenuItem[];
  quantities: Map<number, number>;
  search: string;
  onSearchChange: (s: string) => void;
  onAdd: (item: MenuItem) => void;
}

function VegMark({ veg }: { veg: boolean }) {
  const label = veg ? 'Vegetarian' : 'Non-vegetarian';
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border-[1.5px]',
        veg ? 'border-emerald-600' : 'border-rose-600',
      )}
    >
      <span className={cx('h-1.5 w-1.5 rounded-full', veg ? 'bg-emerald-600' : 'bg-rose-600')} />
    </span>
  );
}

function BasicItemCard({ item, inCart, onAdd }: { item: MenuItem; inCart: number; onAdd: () => void }) {
  const unavailable = !item.isAvailable;

  return (
    <button
      type="button"
      disabled={unavailable}
      onClick={onAdd}
      aria-label={`${item.name}, ${formatPaise(item.pricePaise)}${unavailable ? ', unavailable' : inCart ? `, ${inCart} in order` : ''}`}
      className={cx(
        'group relative flex min-h-[116px] flex-col rounded-[18px] p-3.5 text-left transition-all duration-150 cursor-pointer select-none border',
        unavailable
          ? 'bg-slate-50 border-slate-200 opacity-50 cursor-not-allowed'
          : inCart > 0
            ? 'bg-white border-[#ff8548] shadow-sm ring-1 ring-[#ff8548]'
            : 'bg-white border-slate-200/80 hover:border-slate-400 hover:shadow-sm active:scale-[0.98]',
      )}
    >
      {inCart > 0 && (
        <span className="absolute -top-2 -right-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-[#ff8548] px-1.5 text-xs font-bold text-white shadow-sm ring-2 ring-white">
          <AnimatedValue value={inCart} />
        </span>
      )}

      {/* Top Row: Veg Mark + Name */}
      <span className="flex items-start gap-2">
        <span className="mt-0.5">
          <VegMark veg={item.isVeg} />
        </span>
        <span className={cx('line-clamp-2 text-sm sm:text-[15px] font-bold leading-snug', unavailable ? 'text-slate-400' : 'text-slate-900')}>
          {item.name}
        </span>
      </span>

      {/* Description if present */}
      {item.description && (
        <span className="mt-1 line-clamp-2 pl-5.5 text-xs text-slate-500 leading-normal">
          {item.description}
        </span>
      )}

      {/* Bottom Row: Price + Add Button */}
      <span className="mt-auto flex items-center justify-between pt-3">
        <span className={cx('text-base font-extrabold tabular-nums', unavailable ? 'text-slate-400' : 'text-slate-900')}>
          {formatPaise(item.pricePaise)}
        </span>
        {unavailable ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">
            <Ban size={12} aria-hidden /> Out
          </span>
        ) : (
          <span className="inline-flex h-7.5 items-center gap-1 rounded-full bg-[#ffede3] pr-3 pl-2 text-xs font-bold text-[#ff8548] transition-colors group-hover:bg-[#ff8548] group-hover:text-white">
            <Plus size={14} strokeWidth={2.5} aria-hidden /> Add
          </span>
        )}
      </span>
    </button>
  );
}

export function MenuGrid({
  viewKey,
  title,
  items,
  quantities,
  search,
  onSearchChange,
  onAdd,
}: Props) {
  return (
    <section aria-label="Menu items" className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#fbf7f2]/50">
      {/* Top Area: Search Bar & Heading */}
      <div className="shrink-0 border-b border-slate-200/70 bg-[#fbf7f2]/90 px-4 pt-4 pb-3 sm:px-6">
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-baseline gap-2.5">
            <h2 className="text-xl sm:text-2xl font-black tracking-tight text-slate-900">
              {title}
            </h2>
            <span className="text-xs font-semibold text-slate-500 tabular-nums">
              ({items.length} {items.length === 1 ? 'dish' : 'dishes'})
            </span>
          </div>

          {/* Pill Search Field */}
          <div className="relative w-full sm:w-64 md:w-72">
            <Search size={15} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-slate-400" aria-hidden />
            <input
              type="text"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search dishes..."
              className="h-9.5 w-full rounded-full bg-white pr-8 pl-9.5 text-xs sm:text-sm text-slate-900 placeholder:text-slate-400 shadow-2xs border border-slate-200/80 focus:border-[#ff8548] focus:ring-2 focus:ring-[#ff8548]/20 outline-none transition-all"
            />
            {search && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => onSearchChange('')}
                className="absolute top-1/2 right-2.5 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X size={13} aria-hidden />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Main Grid Area: Clean, Compact Basic Tiles */}
      <div key={viewKey} className="min-h-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-24 lg:pb-6 lg:px-6">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-[20px] border border-dashed border-slate-200 bg-white/60 p-12 text-center text-slate-500">
            <SearchX size={32} className="text-slate-400 mb-2" aria-hidden />
            <p className="text-sm font-bold text-slate-800">No dishes found</p>
            <p className="text-xs text-slate-500 mt-0.5">Try searching with a different keyword or category.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-4 gap-3 sm:gap-3.5">
            {items.map((item) => (
              <BasicItemCard
                key={item.id}
                item={item}
                inCart={quantities.get(item.id) ?? 0}
                onAdd={() => onAdd(item)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
