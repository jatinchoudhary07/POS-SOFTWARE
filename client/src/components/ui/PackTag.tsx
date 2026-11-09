import { Package } from 'lucide-react';
import { cx } from '../../lib/cx';

/** Marks a dish on a dine-in order that the guest wants packed to take away. */
export function PackTag({ className, large = false }: { className?: string; large?: boolean }) {
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center gap-1 rounded-full bg-accent font-bold uppercase tracking-wide text-white',
        large ? 'px-2.5 py-0.5 text-xs' : 'px-1.5 py-px text-[10px]',
        className,
      )}
    >
      <Package size={large ? 12 : 10} aria-hidden /> Pack
    </span>
  );
}
