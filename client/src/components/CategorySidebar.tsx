import {
  CakeSlice,
  Coffee,
  CookingPot,
  Croissant,
  CupSoda,
  Flame,
  GlassWater,
  Hamburger,
  IceCreamCone,
  PartyPopper,
  Pizza,
  Popcorn,
  Salad,
  Sandwich,
  Soup,
  UtensilsCrossed,
  Wheat,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { MenuCategory } from '../api/types';
import { cx } from '../lib/cx';
import { pressable } from './ui/Button';

// Categories are editable data, so icons are matched by keyword with a safe fallback.
const ICONS: [RegExp, LucideIcon][] = [
  [/pizza/i, Pizza],
  [/burger/i, Hamburger],
  [/sandwich|roll|wrap/i, Sandwich],
  [/fries|potato/i, Popcorn],
  [/combo|party/i, PartyPopper],
  [/italian|garlic/i, Croissant],
  [/chilli/i, Flame],
  [/chaap|tikka|tandoor/i, Flame],
  [/coffee|tea|chai|latte|cappuccino/i, Coffee],
  [/mojito|lime|soda/i, GlassWater],
  [/shake/i, IceCreamCone],
  [/starter|snack|appet/i, Salad],
  [/main|curry|gravy/i, CookingPot],
  [/bread|roti|naan/i, Wheat],
  [/rice|biryani|soup|maggi|chowmein|noodle/i, Soup],
  [/drink|beverage|juice/i, CupSoda],
  [/dessert|sweet|cake/i, CakeSlice],
];
const iconFor = (name: string): LucideIcon =>
  ICONS.find(([re]) => re.test(name))?.[1] ?? UtensilsCrossed;

interface Props {
  categories: MenuCategory[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}

/**
 * Vertical Category Sidebar on the left side of the screen.
 * Clean, warm Purr'Coffee aesthetic with category icons and dish counts.
 */
export function CategorySidebar({ categories, selectedId, onSelect }: Props) {
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    navRef.current
      ?.querySelector('[aria-current="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [selectedId]);

  return (
    <nav
      ref={navRef}
      aria-label="Menu categories"
      className="no-scrollbar flex min-h-0 w-full max-w-full min-w-0 shrink-0 gap-1.5 overflow-x-auto border-b border-slate-200/80 bg-white px-3 py-2.5 sm:py-3 lg:w-48 lg:flex-col lg:overflow-x-visible lg:overflow-y-auto lg:border-r lg:border-b-0 lg:px-3 lg:py-4 xl:w-56 shadow-[1px_0_12px_rgba(30,41,59,0.02)]"
    >
      <div className="hidden items-center justify-between px-3 pb-2.5 lg:flex">
        <h2 className="text-xs font-bold tracking-wider text-slate-400 uppercase">
          Categories
        </h2>
        <span className="text-[11px] font-semibold text-slate-400 tabular-nums">
          {categories.length}
        </span>
      </div>

      <div className="flex w-full gap-1.5 lg:flex-col">
        {categories.map((c) => {
          const active = c.id === selectedId;
          const Icon = iconFor(c.name);

          return (
            <button
              key={c.id}
              type="button"
              aria-current={active ? 'true' : undefined}
              onClick={() => onSelect(c.id)}
              className={cx(
                'flex shrink-0 items-center gap-3 rounded-[16px] px-3.5 text-left text-xs sm:text-sm font-bold transition-all duration-150',
                'h-10 sm:h-11',
                pressable,
                active
                  ? 'bg-[#ff8548] text-white shadow-[0_4px_14px_rgba(255,133,72,0.35)]'
                  : 'text-slate-700 hover:bg-[#fff6ee] hover:text-[#ff8548] border border-transparent',
              )}
            >
              <span
                className={cx(
                  'flex h-7 w-7 items-center justify-center rounded-[10px] shrink-0 transition-colors',
                  active ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600',
                )}
              >
                <Icon size={15} strokeWidth={2.2} aria-hidden />
              </span>
              <span className="whitespace-nowrap lg:flex-1 lg:truncate">{c.name}</span>
              <span
                className={cx(
                  'hidden text-[11px] font-bold tabular-nums rounded-full px-2 py-0.5 lg:inline',
                  active ? 'bg-white/25 text-white' : 'bg-slate-100 text-slate-500',
                )}
              >
                {c.items.length}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
