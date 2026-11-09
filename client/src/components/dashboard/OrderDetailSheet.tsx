import { CircleAlert, Clock, FileText, Loader2, Phone, ShoppingBag, StickyNote, User, UtensilsCrossed } from 'lucide-react';
import { PackTag } from '../ui/PackTag';
import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../../api/client';
import type { Checkout, Payment } from '../../api/types';
import { cx } from '../../lib/cx';
import { formatPaise } from '../../lib/money';
import { BottomSheet } from '../ui/BottomSheet';
import { Button } from '../ui/Button';
import { METHOD_LABELS, PaymentBadge } from '../ui/PaymentBadge';
import { StatusBadge } from '../ui/StatusBadge';

const dateTime = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
};

const PAYMENT_STATE: Record<Payment['status'], { label: string; cls: string }> = {
  SUCCEEDED: { label: 'Paid', cls: 'text-success' },
  PENDING: { label: 'In progress', cls: 'text-warning' },
  UNKNOWN: { label: 'Needs checking', cls: 'text-warning' },
  FAILED: { label: 'Failed', cls: 'text-danger' },
  REFUNDED: { label: 'Refunded', cls: 'text-ink-2' },
};

function Row({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-fill text-ink-2">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-ink-3">{label}</p>
        <div className="text-sm font-semibold text-ink">{children}</div>
      </div>
    </div>
  );
}

function Money({ label, value, strong, tone }: { label: ReactNode; value: string; strong?: boolean; tone?: 'minus' }) {
  return (
    <div className={cx('flex items-baseline justify-between gap-3', strong ? 'pt-2 text-base font-extrabold' : 'text-sm text-ink-2')}>
      <span className="min-w-0">{label}</span>
      <span className={cx('shrink-0 tabular-nums', strong ? 'text-ink' : 'font-medium', tone === 'minus' && 'text-success')}>{value}</span>
    </div>
  );
}

/**
 * Everything about one order, shown in a panel that slides up over the page: when and where it was
 * placed, who it was for, the items, how the bill was made up and how it was paid.
 */
export function OrderDetailSheet({
  orderId,
  onClose,
  onOpenBill,
}: {
  orderId: number;
  onClose: () => void;
  /** Goes to the bill / payment screen for this order. */
  onOpenBill?: (orderId: number) => void;
}) {
  const [data, setData] = useState<Checkout | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    api
      .getCheckout(orderId)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof ApiError ? e.message : 'Could not load this order'));
    return () => {
      live = false;
    };
  }, [orderId]);

  const order = data?.order;
  const bill = data?.bill ?? null;
  const payments = data?.payments ?? [];
  const cancelled = order?.status === 'CANCELLED';
  // A table's bill can cover several orders: then its total is more than this order's own items.
  const sharedBill = !!bill && !!order && bill.subtotalPaise !== order.subtotalPaise;
  const place = order ? (order.orderType === 'DINE_IN' ? (order.tableNumber ? `Table ${order.tableNumber}` : 'Dine-in') : 'Takeaway') : '';

  return (
    <BottomSheet title={order ? `Order #${order.orderNumber}` : 'Order details'} onClose={onClose}>
      {error ? (
        <p role="alert" className="flex items-start gap-2 rounded-2xl bg-danger-tint px-4 py-3 text-sm font-medium text-danger">
          <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden /> {error}
        </p>
      ) : !order ? (
        <p className="flex items-center justify-center gap-2 py-14 text-sm text-ink-2">
          <Loader2 size={18} className="animate-spin" aria-hidden /> Loading…
        </p>
      ) : (
        <div className="animate-enter space-y-5 pt-1">
          {/* status */}
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={order.status} />
            {!cancelled && <PaymentBadge status={order.paymentStatus} method={order.paymentMethod} />}
            <span className={cx('ml-auto text-2xl font-extrabold tabular-nums tracking-tight', cancelled && 'text-ink-3 line-through')}>
              {formatPaise(bill?.totalPaise ?? order.subtotalPaise)}
            </span>
          </div>

          {/* who / where / when */}
          <div className="divide-y divide-line rounded-2xl bg-subtle px-3.5 ring-1 ring-line">
            <Row icon={order.orderType === 'DINE_IN' ? <UtensilsCrossed size={16} aria-hidden /> : <ShoppingBag size={16} aria-hidden />} label="Order">
              {place}
            </Row>
            <Row icon={<Clock size={16} aria-hidden />} label="Placed">
              {dateTime(order.createdAt)}
            </Row>
            {order.customerName && (
              <Row icon={<User size={16} aria-hidden />} label="Customer">
                {order.customerName}
              </Row>
            )}
            {order.customerPhone && (
              <Row icon={<Phone size={16} aria-hidden />} label="Phone">
                {order.customerPhone}
              </Row>
            )}
            {order.notes && (
              <Row icon={<StickyNote size={16} aria-hidden />} label="Notes">
                <span className="font-medium">{order.notes}</span>
              </Row>
            )}
            {cancelled && order.cancelReason && (
              <Row icon={<CircleAlert size={16} aria-hidden />} label="Cancelled because">
                <span className="font-medium">{order.cancelReason}</span>
              </Row>
            )}
          </div>

          {/* items */}
          <section aria-label="Items">
            <h4 className="mb-2 text-xs font-bold tracking-wider text-ink-2 uppercase">
              Items <span className="ml-1 rounded-full bg-fill px-2 py-0.5 text-[11px] tabular-nums">{order.itemCount}</span>
            </h4>
            <ul className="divide-y divide-line rounded-2xl bg-surface ring-1 ring-line">
              {order.items.map((i) => (
                <li key={i.id} className="flex items-baseline gap-3 px-3.5 py-2.5">
                  <span className="flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md bg-accent-tint px-1.5 text-xs font-extrabold text-accent tabular-nums">{i.quantity}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">{i.itemName} {i.packed && <PackTag className="ml-1 align-middle" />}</span>
                    {i.quantity > 1 && <span className="block text-xs text-ink-3">{formatPaise(i.unitPricePaise)} each</span>}
                  </span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">{formatPaise(i.lineTotalPaise)}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* bill */}
          <section aria-label="Bill" className="space-y-1.5 rounded-2xl bg-subtle p-3.5 ring-1 ring-line">
            <h4 className="mb-1 text-xs font-bold tracking-wider text-ink-2 uppercase">Bill</h4>
            {bill ? (
              <>
                <Money label={sharedBill ? 'Subtotal (whole table bill)' : 'Subtotal'} value={formatPaise(bill.subtotalPaise)} />
                {bill.discount.paise > 0 && (
                  <Money
                    label={
                      <>
                        Discount{bill.discount.type === 'PERCENT' ? ` (${bill.discount.value / 100}%)` : ''}
                        {bill.discount.reason && <span className="block text-xs text-ink-3">{bill.discount.reason}</span>}
                      </>
                    }
                    value={`− ${formatPaise(bill.discount.paise)}`}
                    tone="minus"
                  />
                )}
                {bill.taxLines.map((t) => (
                  <Money key={t.name} label={`${t.name} (${t.rateBps / 100}%)`} value={formatPaise(t.amountPaise)} />
                ))}
                {bill.roundOffPaise !== 0 && <Money label="Round off" value={`${bill.roundOffPaise < 0 ? '− ' : ''}${formatPaise(Math.abs(bill.roundOffPaise))}`} />}
                <div className="border-t border-line-strong/60 pt-1">
                  <Money label="Total" value={formatPaise(bill.totalPaise)} strong />
                </div>
                {sharedBill && (
                  <p className="pt-1 text-xs leading-relaxed text-ink-3">
                    This order was billed together with the other orders on the table, so the bill above is for the whole table. This order’s own items come to {formatPaise(order.subtotalPaise)}.
                  </p>
                )}
              </>
            ) : (
              <>
                <Money label="Items total" value={formatPaise(order.subtotalPaise)} />
                <p className="pt-1 text-xs text-ink-3">{cancelled ? 'No bill was made for this order.' : 'The bill has not been made yet (taxes and discount are added when it is).'}</p>
              </>
            )}
          </section>

          {/* payments */}
          <section aria-label="Payments" className="space-y-2">
            <h4 className="text-xs font-bold tracking-wider text-ink-2 uppercase">Payment</h4>
            {payments.length === 0 ? (
              <p className="rounded-2xl bg-subtle px-3.5 py-3 text-sm text-ink-2 ring-1 ring-line">{cancelled ? 'No payment — the order was cancelled.' : 'Nothing has been paid yet.'}</p>
            ) : (
              <ul className="space-y-2">
                {payments.map((p) => {
                  const st = PAYMENT_STATE[p.status];
                  return (
                    <li key={p.id} className="rounded-2xl bg-surface px-3.5 py-3 ring-1 ring-line">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-sm font-bold">{METHOD_LABELS[p.method]}</span>
                        <span className="text-sm font-extrabold tabular-nums">{formatPaise(p.amountPaise)}</span>
                      </div>
                      <div className="mt-0.5 flex items-center justify-between gap-3 text-xs">
                        <span className={cx('font-semibold', st.cls)}>{st.label}</span>
                        <span className="text-ink-3">{dateTime(p.completedAt ?? p.createdAt)}</span>
                      </div>
                      <div className="mt-1 space-y-0.5 text-xs text-ink-3">
                        <p>Ref {p.reference}</p>
                        {p.tenderedPaise !== null && p.changePaise !== null && (
                          <p>
                            Received {formatPaise(p.tenderedPaise)}, change {formatPaise(p.changePaise)}
                          </p>
                        )}
                        {p.providerReference && <p>UPI reference: {p.providerReference}</p>}
                        {p.failureReason && <p className="text-danger">{p.failureReason}</p>}
                        {p.note && <p>{p.note}</p>}
                        {p.status === 'REFUNDED' && p.refundedAt && (
                          <p>
                            Refunded {dateTime(p.refundedAt)}
                            {p.refundReason ? ` — ${p.refundReason}` : ''}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {onOpenBill && !cancelled && (
            <Button
              size="lg"
              variant="secondary"
              icon={FileText}
              className="w-full"
              onClick={() => {
                onClose();
                onOpenBill(order.id);
              }}
            >
              {order.paymentStatus === 'PAID' ? 'Open bill & receipt' : 'Open bill & take payment'}
            </Button>
          )}
        </div>
      )}
    </BottomSheet>
  );
}
