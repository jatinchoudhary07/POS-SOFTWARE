import { CircleAlert, CircleCheck, CircleDashed, RotateCcw, TriangleAlert } from 'lucide-react';
import type { OrderPaymentStatus, PaymentMethod } from '../../api/types';
import { cx } from '../../lib/cx';

export const METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: 'Cash',
  UPI_MANUAL: 'UPI (manual check)',
  TERMINAL: 'Paytm terminal',
  CREDIT: 'On credit',
};

const STYLES: Record<OrderPaymentStatus, { label: string; cls: string; icon: typeof CircleCheck }> = {
  UNPAID: { label: 'Unpaid', cls: 'bg-fill text-ink-2', icon: CircleDashed },
  PAID: { label: 'Paid', cls: 'bg-success-tint text-success', icon: CircleCheck },
  FAILED: { label: 'Payment failed', cls: 'bg-danger-tint text-danger', icon: CircleAlert },
  UNCERTAIN: { label: 'Check payment', cls: 'bg-warning-tint text-warning', icon: TriangleAlert },
  REFUNDED: { label: 'Refunded', cls: 'bg-fill text-ink-2', icon: RotateCcw },
};

/**
 * Payment status pill. Uses an icon (not a dot) so it is never confused with the kitchen
 * status badge shown next to it.
 */
export function PaymentBadge({ status, method }: { status: OrderPaymentStatus; method?: PaymentMethod | null }) {
  const s = STYLES[status];
  const Icon = s.icon;
  const short = method === 'UPI_MANUAL' ? 'UPI' : method ? METHOD_LABELS[method] : null;
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold whitespace-nowrap', s.cls)}>
      <Icon size={13} aria-hidden />
      {s.label}
      {status === 'PAID' && short ? ` · ${short}` : ''}
    </span>
  );
}
