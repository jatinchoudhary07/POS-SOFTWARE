import { Check, ChevronDown, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cx } from '../../lib/cx';

export interface FilterOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  /** Colour class for the icon, e.g. "text-emerald-600". */
  tone?: string;
  /** Shown as a small number badge (how many items are in this group). */
  count?: number;
}

/**
 * Pill-shaped dropdown (not a native select) so the open list never shifts the layout.
 * Same look as the date menu on the Sales page.
 */
export function FilterMenu<T extends string>({
  value,
  options,
  onChange,
  label,
  align = 'right',
  className,
}: {
  value: T;
  options: FilterOption<T>[];
  onChange: (v: T) => void;
  /** Accessible name of the whole menu, e.g. "Filter by status". */
  label: string;
  align?: 'left' | 'right';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

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

  const CurrentIcon = current.icon;
  return (
    <div ref={ref} className={cx('relative shrink-0', className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${current.label}`}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9.5 max-w-[11rem] items-center gap-1.5 rounded-full bg-white pr-2.5 pl-3 text-xs font-bold text-slate-700 shadow-sm ring-1 ring-slate-200/80 transition-all hover:shadow-md active:scale-95 sm:max-w-none sm:text-[13px]"
      >
        {CurrentIcon && <CurrentIcon size={14} className={cx('shrink-0', current.tone)} aria-hidden />}
        <span className="truncate">{current.label}</span>
        {current.count !== undefined && (
          <span className="rounded-full bg-slate-100 px-1.5 py-px text-[11px] font-bold text-slate-600 tabular-nums">{current.count}</span>
        )}
        <ChevronDown size={14} className={cx('shrink-0 text-slate-500 transition-transform duration-200', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label={label}
          className={cx(
            'absolute z-30 mt-2 w-56 animate-pop overflow-hidden rounded-2xl bg-white p-1 shadow-[0_16px_40px_-10px_rgba(60,40,20,0.35)] ring-1 ring-slate-100',
            align === 'right' ? 'right-0 origin-top-right' : 'left-0 origin-top-left',
          )}
        >
          {options.map((o) => {
            const Icon = o.icon;
            const selected = o.value === value;
            return (
              <li key={o.value} role="option" aria-selected={selected}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={cx(
                    'flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm font-semibold transition-colors',
                    selected ? 'bg-orange-50 text-orange-600' : 'text-slate-700 hover:bg-slate-50',
                  )}
                >
                  {Icon && <Icon size={16} className={cx('shrink-0', selected ? 'text-orange-600' : o.tone)} aria-hidden />}
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.count !== undefined && (
                    <span className={cx('rounded-full px-1.5 py-px text-[11px] font-bold tabular-nums', selected ? 'bg-orange-100 text-orange-600' : 'bg-slate-100 text-slate-500')}>
                      {o.count}
                    </span>
                  )}
                  {selected && <Check size={14} className="shrink-0" aria-hidden />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
