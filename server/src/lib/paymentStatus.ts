import type { PaymentMethod, PaymentStatus } from '../db/schema';

/**
 * The order's payment status shown to staff, derived from its payment attempts.
 * It is deliberately separate from the kitchen status (orders.status).
 *
 *   PAID       a payment SUCCEEDED
 *   REFUNDED   the successful payment was refunded (and nothing else succeeded)
 *   UNCERTAIN  an attempt is in progress or its outcome is unknown — needs checking
 *   FAILED     the latest attempt failed (the bill is still unpaid)
 *   UNPAID     no attempts yet
 */
export const ORDER_PAYMENT_STATUSES = ['UNPAID', 'PAID', 'FAILED', 'UNCERTAIN', 'REFUNDED'] as const;
export type OrderPaymentStatus = (typeof ORDER_PAYMENT_STATUSES)[number];

export function derivePaymentStatus(attempts: { id: number; status: PaymentStatus }[]): OrderPaymentStatus {
  if (attempts.some((p) => p.status === 'SUCCEEDED')) return 'PAID';
  if (attempts.some((p) => p.status === 'PENDING' || p.status === 'UNKNOWN')) return 'UNCERTAIN';
  if (attempts.some((p) => p.status === 'REFUNDED')) return 'REFUNDED';
  const latest = attempts.reduce<{ id: number; status: PaymentStatus } | undefined>((a, p) => (!a || p.id > a.id ? p : a), undefined);
  return latest?.status === 'FAILED' ? 'FAILED' : 'UNPAID';
}

export function paidMethod(attempts: { status: PaymentStatus; method: PaymentMethod }[]): PaymentMethod | null {
  return attempts.find((p) => p.status === 'SUCCEEDED' || p.status === 'REFUNDED')?.method ?? null;
}
