import type { LucideIcon } from 'lucide-react';
import { cx } from '../../lib/cx';
import { pressable } from './Button';

export interface Segment<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
}

interface Props<T extends string> {
  segments: Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  size?: 'md' | 'lg';
  className?: string;
  /** Show only icons below the lg breakpoint (labels stay available to screen readers). */
  compact?: boolean;
}

/**
 * Apple macOS/iOS-style segmented control with frosted glass track and floating white pill.
 */
export function SegmentedControl<T extends string>({ segments, value, onChange, label, size = 'md', className, compact }: Props<T>) {
  const index = segments.findIndex((s) => s.value === value);
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx('relative grid rounded-full bg-slate-200/60 backdrop-blur-md border border-white/70 p-1 shadow-2xs', className)}
      style={{ gridTemplateColumns: `repeat(${segments.length}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden
        hidden={index < 0}
        className="absolute top-1 bottom-1 left-1 rounded-full bg-white shadow-[0_2px_8px_rgba(15,23,42,0.08)] ring-1 ring-black/5 transition-transform duration-250 ease-out-soft"
        style={{
          width: `calc((100% - 0.5rem) / ${segments.length})`,
          transform: `translateX(${index * 100}%)`,
        }}
      />
      {segments.map((s) => {
        const active = s.value === value;
        const Icon = s.icon;
        return (
          <button
            key={s.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(s.value)}
            className={cx(
              'relative z-10 inline-flex items-center justify-center gap-2 rounded-full px-3 font-semibold transition-colors duration-150',
              pressable,
              size === 'lg' ? 'h-11 text-[15px]' : 'h-8 text-xs sm:text-sm',
              active ? 'text-slate-900 font-bold' : 'text-slate-600 hover:text-slate-900',
            )}
          >
            {Icon && <Icon size={size === 'lg' ? 18 : 15} aria-hidden />}
            <span className={compact && Icon ? 'sr-only lg:not-sr-only' : undefined}>{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}
