import type { OrderStatus } from '../../api/types';
import { cx } from '../../lib/cx';

const styles: Record<OrderStatus, { pill: string; dot: string }> = {
  NEW: { pill: 'bg-accent-tint text-accent-hover', dot: 'bg-accent' },
  PREPARING: { pill: 'bg-warning-tint text-warning', dot: 'bg-warning' },
  READY: { pill: 'bg-success-tint text-success', dot: 'bg-success' },
  COMPLETED: { pill: 'bg-fill text-ink-2', dot: 'bg-ink-3' },
  CANCELLED: { pill: 'bg-danger-tint text-danger', dot: 'bg-danger' },
};

export const STATUS_LABELS: Record<OrderStatus, string> = {
  NEW: 'Sent to kitchen',
  PREPARING: 'Preparing',
  READY: 'Ready',
  COMPLETED: 'Served', // stored as COMPLETED in the database
  CANCELLED: 'Cancelled',
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  const s = styles[status];
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold', s.pill)}>
      <span className={cx('h-1.5 w-1.5 rounded-full', s.dot)} aria-hidden />
      {STATUS_LABELS[status]}
    </span>
  );
}
