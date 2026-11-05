import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';

/**
 * Shows a value and plays a short "tick" whenever it changes. The new value is
 * rendered immediately (the key change remounts the span), so the animation never
 * delays what the cashier sees — it only draws the eye to the change.
 */
export function AnimatedValue({ value, children, className }: { value: string | number; children?: ReactNode; className?: string }) {
  return (
    <span key={value} className={cx('inline-block animate-tick tabular-nums', className)}>
      {children ?? value}
    </span>
  );
}
