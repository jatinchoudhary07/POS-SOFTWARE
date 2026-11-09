import {
  ArrowLeft,
  Banknote,
  CircleAlert,
  CircleCheck,
  HandCoins,
  Loader2,
  Percent,
  Printer,
  RotateCcw,
  ShieldCheck,
  Smartphone,
  Tag,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import type { Bill, Checkout, DiscountRequest, Payment, PaymentRequest } from '../api/types';
import { formatBps, parsePercentToBps, parseRupeesToPaise, quickCashAmounts } from '../lib/amounts';
import { cx } from '../lib/cx';
import { newRequestId } from '../lib/id';
import { formatPaise } from '../lib/money';
import { formatClock } from '../lib/time';
import { useUser } from '../state/Auth';
import { useLiveOrders } from '../state/LiveOrders';
import { can } from '../state/permissions';
import { CreditPaymentForm } from './CreditPaymentForm';
import { useReceiptPrinter } from './ReceiptPrinter';
import { AnimatedValue } from './ui/AnimatedValue';
import { Button, IconButton } from './ui/Button';
import { inputClass, labelClass } from './ui/fields';
import { METHOD_LABELS, PaymentBadge } from './ui/PaymentBadge';
import { SegmentedControl } from './ui/SegmentedControl';
import { StatusBadge } from './ui/StatusBadge';
import { useToast } from './ui/Toast';

const card = 'rounded-card bg-surface shadow-card';

// ---------------------------------------------------------------------------
// Bill (left column)
// ---------------------------------------------------------------------------

function Row({ label, value, strong, muted }: { label: React.ReactNode; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className={cx('flex items-baseline justify-between gap-4', strong ? 'text-ink' : muted ? 'text-ink-2' : 'text-ink')}>
      <span className={cx(strong ? 'text-base font-semibold lg:text-lg' : 'text-sm lg:text-[15px]')}>{label}</span>
      <span className={cx('tabular-nums', strong ? 'text-2xl font-semibold tracking-tight lg:text-[28px]' : 'text-sm font-medium lg:text-[15px]')}>
        {strong ? <AnimatedValue value={value} /> : value}
      </span>
    </div>
  );
}

function DiscountEditor({ bill, disabled, onApply }: { bill: Bill; disabled: boolean; onApply: (d: DiscountRequest) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<'PERCENT' | 'AMOUNT'>('PERCENT');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = type === 'PERCENT' ? parsePercentToBps(value) : parseRupeesToPaise(value);
    if (!parsed) return setError(type === 'PERCENT' ? 'Enter a percentage like 10 or 12.5' : 'Enter an amount like 50 or 49.50');
    if (reason.trim().length < 3) return setError('Give a short reason (kept on the bill)');
    setBusy(true);
    const ok = await onApply(type === 'PERCENT' ? { type, bps: parsed, reason: reason.trim() } : { type, paise: parsed, reason: reason.trim() });
    setBusy(false);
    if (ok) {
      setOpen(false);
      setValue('');
      setReason('');
      setError(null);
    }
  }

  if (bill.discount.type !== 'NONE') {
    return (
      <Button size="sm" variant="plain" icon={X} disabled={disabled} onClick={() => void onApply({ type: 'NONE' })} className="max-lg:h-7">
        Remove discount
      </Button>
    );
  }
  if (!open) {
    return (
      <Button size="sm" variant="plain" icon={Tag} disabled={disabled} onClick={() => setOpen(true)} className="max-lg:h-7">
        Add discount
      </Button>
    );
  }
  return (
    <form onSubmit={submit} className="w-full animate-enter space-y-3 rounded-control bg-subtle p-3">
      <div className="flex gap-2">
        <SegmentedControl
          label="Discount type"
          className="w-40 shrink-0"
          value={type}
          onChange={setType}
          segments={[
            { value: 'PERCENT', label: '%', icon: Percent },
            { value: 'AMOUNT', label: '₹' },
          ]}
        />
        <label className="flex-1">
          <span className="sr-only">Discount {type === 'PERCENT' ? 'percentage' : 'amount in rupees'}</span>
          <input
            autoFocus
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={type === 'PERCENT' ? 'e.g. 10' : 'e.g. 50'}
            className={cx(inputClass, 'h-9')}
          />
        </label>
      </div>
      <label className="block">
        <span className="sr-only">Reason for discount</span>
        <input value={reason} maxLength={120} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" className={cx(inputClass, 'h-9')} />
      </label>
      {error && <p className="text-sm font-medium text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="plain" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" loading={busy}>
          Apply discount
        </Button>
      </div>
    </form>
  );
}

function BillCard({ checkout, editable, onDiscount, collapseItems }: { checkout: Checkout; editable: boolean; onDiscount: (d: DiscountRequest) => Promise<boolean>; collapseItems?: boolean }) {
  const { order, bill } = checkout;
  return (
    <section aria-label="Bill" className={cx(card, 'flex flex-col p-3 lg:p-6')}>
      <h2 className="text-[15px] font-semibold text-ink-2 max-lg:sr-only">Bill</h2>
      {/* On a phone the items share one line each and scroll inside their own small box if there are many, so the
          totals and the payment always stay on screen. */}
      <ul className={cx('space-y-1 max-lg:max-h-[21dvh] max-lg:overflow-y-auto lg:mt-3 lg:space-y-2.5', collapseItems && 'max-lg:hidden')}>
        {order.items.map((i) => (
          <li key={i.id} className="flex items-baseline justify-between gap-2 lg:gap-4">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium lg:overflow-visible lg:whitespace-normal lg:text-base" title={i.itemName}>
                <span className="tabular-nums text-ink-2 lg:hidden">{i.quantity}× </span>
                {i.itemName}
              </span>
              <span className="hidden text-sm text-ink-2 tabular-nums lg:block">
                {i.quantity} × {formatPaise(i.unitPricePaise)}
              </span>
            </span>
            <span className="text-xs font-medium tabular-nums lg:text-base">{formatPaise(i.lineTotalPaise)}</span>
          </li>
        ))}
      </ul>

      {bill ? (
        <div className={cx('space-y-1 pt-2 lg:mt-5 lg:space-y-2 lg:border-t lg:border-line lg:pt-4', collapseItems ? 'mt-0' : 'mt-2 border-t border-line')}>
          <Row label="Subtotal" value={formatPaise(bill.subtotalPaise)} />
          {bill.discount.paise > 0 && (
            <Row
              muted
              label={
                <>
                  Discount{bill.discount.type === 'PERCENT' ? ` ${formatBps(bill.discount.value)}` : ''}
                  {bill.discount.reason && <span className="block text-xs">{bill.discount.reason}</span>}
                </>
              }
              value={`−${formatPaise(bill.discount.paise)}`}
            />
          )}
          {bill.taxLines.map((t) => (
            <Row key={t.name} muted label={`${t.name} ${formatBps(t.rateBps)}`} value={formatPaise(t.amountPaise)} />
          ))}
          {bill.taxLines.length === 0 && <p className="text-xs text-ink-2 lg:text-sm">No tax lines configured (see Settings).</p>}
          {bill.roundOffPaise !== 0 && (
            <Row muted label="Round off" value={`${bill.roundOffPaise > 0 ? '+' : '−'}${formatPaise(Math.abs(bill.roundOffPaise))}`} />
          )}
          <div className="border-t border-line pt-1.5 lg:pt-3">
            <Row strong label="Total" value={formatPaise(bill.totalPaise)} />
          </div>
          {editable && (
            <div className="flex pt-1">
              <DiscountEditor bill={bill} disabled={!editable} onApply={onDiscount} />
            </div>
          )}
        </div>
      ) : (
        <p className="mt-6 flex items-center gap-2 text-ink-2">
          <Loader2 size={16} className="animate-spin" aria-hidden /> Calculating bill…
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Superadmin-only actions (refund / resolve). The server enforces this too.
// ---------------------------------------------------------------------------

function RefundForm({ payment, onDone }: { payment: Payment; onDone: (c: Checkout) => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  if (payment.provider !== 'MANUAL') return null;
  if (!open) {
    return (
      <Button size="sm" variant="plain" icon={RotateCcw} onClick={() => setOpen(true)}>
        Record a refund…
      </Button>
    );
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.refundPayment(payment.id, reason.trim());
      toast({ tone: 'success', title: `Refund of ${formatPaise(payment.amountPaise)} recorded` });
      onDone(r.checkout);
    } catch (err) {
      toast({ tone: 'error', title: 'Refund not recorded', description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="w-full animate-enter space-y-3 rounded-control bg-subtle p-4 text-left">
      <p className="text-sm text-ink-2">
        Records a <strong className="text-ink">full refund</strong> of {formatPaise(payment.amountPaise)}. Only do this after the money has
        actually been returned to the customer.
      </p>
      <label className="block">
        <span className={labelClass}>Reason</span>
        <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} className={cx(inputClass, 'h-11')} />
      </label>
      <label className="flex items-start gap-2.5 text-sm">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" />
        I have returned {formatPaise(payment.amountPaise)} to the customer.
      </label>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="plain" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button size="sm" variant="danger" type="submit" loading={busy} disabled={!confirmed || reason.trim().length < 3 || busy} className="bg-danger-tint">
          Record refund
        </Button>
      </div>
    </form>
  );
}

function ResolveForm({ payment, onDone }: { payment: Payment; onDone: (c: Checkout) => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState<'SUCCEEDED' | 'FAILED' | null>(null);

  async function resolve(outcome: 'SUCCEEDED' | 'FAILED') {
    setBusy(outcome);
    try {
      const r = await api.resolvePayment(payment.id, { outcome, note: note.trim(), ...(reference.trim() ? { providerReference: reference.trim() } : {}) });
      onDone(r.checkout);
    } catch (err) {
      toast({ tone: 'error', title: 'Could not resolve payment', description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setBusy(null);
    }
  }
  const ready = note.trim().length >= 3 && !busy;
  return (
    <div className="space-y-3">
      <label className="block">
        <span className={labelClass}>How did you verify it?</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Checked terminal history" className={cx(inputClass, 'h-11')} />
      </label>
      <label className="block">
        <span className={labelClass}>Transaction reference (optional)</span>
        <input value={reference} onChange={(e) => setReference(e.target.value)} className={cx(inputClass, 'h-11')} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="secondary" loading={busy === 'FAILED'} disabled={!ready} onClick={() => void resolve('FAILED')}>
          It failed
        </Button>
        <Button variant="success" loading={busy === 'SUCCEEDED'} disabled={!ready} onClick={() => void resolve('SUCCEEDED')}>
          Money received
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payment (right column)
// ---------------------------------------------------------------------------

function PaidPanel({ checkout, onUpdate, onBack }: { checkout: Checkout; onUpdate: (c: Checkout) => void; onBack: () => void }) {
  const { role } = useUser();
  const { print, printing, format, setFormat } = useReceiptPrinter();
  const settled = checkout.payments.find((p) => p.status === 'SUCCEEDED' || p.status === 'REFUNDED')!;
  const refunded = settled.status === 'REFUNDED';
  const onCredit = settled.method === 'CREDIT';
  const toast = useToast();
  const { updateStatus } = useLiveOrders();
  const [completing, setCompleting] = useState(false);
  const { order } = checkout;
  const dineIn = order.orderType === 'DINE_IN';

  async function complete() {
    setCompleting(true);
    try {
      await updateStatus(order.id, 'COMPLETED');
      toast({ tone: 'success', title: `#${order.orderNumber} ${dineIn ? 'served' : 'handed over'}` });
      onBack();
    } catch (e) {
      toast({ tone: 'error', title: 'Could not update the order', description: e instanceof ApiError ? e.message : undefined });
      setCompleting(false);
    }
  }
  return (
    <div className="flex animate-enter flex-col items-center text-center">
      <span
        className={cx(
          'flex h-14 w-14 items-center justify-center rounded-full max-lg:h-10 max-lg:w-10',
          refunded ? 'bg-fill text-ink-2' : 'bg-success-tint text-success',
        )}
      >
        {refunded ? <RotateCcw size={26} aria-hidden /> : <CircleCheck size={28} aria-hidden />}
      </span>
      <h3 className="mt-1.5 text-lg font-semibold tracking-tight lg:mt-3 lg:text-xl">{refunded ? 'Refunded' : onCredit ? 'On credit' : 'Paid'}</h3>
      <p className="mt-1 text-ink-2">
        {formatPaise(settled.amountPaise)} · {METHOD_LABELS[settled.method]}
      </p>
      {settled.changePaise !== null && settled.changePaise > 0 && !refunded && (
        <p className="mt-2.5 w-full rounded-control bg-success-tint px-3 py-1.5 text-success lg:mt-4 lg:px-4 lg:py-3">
          <span className="block text-sm font-medium">Give change</span>
          <span className="text-2xl font-semibold tabular-nums lg:text-[28px]">{formatPaise(settled.changePaise)}</span>
        </p>
      )}
      <dl className="mt-2.5 hidden w-full space-y-0.5 text-xs lg:mt-4 lg:block lg:space-y-1 lg:text-sm">
        {settled.tenderedPaise !== null && (
          <div className="flex justify-between">
            <dt className="text-ink-2">Cash received</dt>
            <dd className="tabular-nums">{formatPaise(settled.tenderedPaise)}</dd>
          </div>
        )}
        <div className="flex justify-between">
          <dt className="text-ink-2">Reference</dt>
          <dd className="font-medium">{settled.reference}</dd>
        </div>
        {settled.providerReference && (
          <div className="flex justify-between max-lg:hidden">
            <dt className="text-ink-2">UPI ref</dt>
            <dd>{settled.providerReference}</dd>
          </div>
        )}
        {settled.completedAt && (
          <div className="flex justify-between max-lg:hidden">
            <dt className="text-ink-2">Time</dt>
            <dd className="tabular-nums">{formatClock(settled.completedAt)}</dd>
          </div>
        )}
        {refunded && (
          <div className="flex justify-between gap-4">
            <dt className="text-ink-2">Refund reason</dt>
            <dd className="text-right">{settled.refundReason}</dd>
          </div>
        )}
      </dl>

      {!refunded && order.status !== 'COMPLETED' && order.status !== 'CANCELLED' && (
        <div className="mt-3 w-full lg:mt-5">
          {order.status === 'READY' ? (
            <Button size="lg" variant="success" icon={CircleCheck} loading={completing} disabled={completing} onClick={() => void complete()} className="w-full max-lg:h-12">
              {dineIn ? 'Mark served' : 'Hand over to customer'}
            </Button>
          ) : (
            <p className="rounded-control bg-fill px-4 py-3 text-sm font-medium text-ink-2">
              Paid. {order.status === 'PREPARING' ? 'The kitchen is preparing it' : 'Waiting for the kitchen to start'}; you can {dineIn ? 'serve' : 'hand it over'} once it is ready.
            </p>
          )}
        </div>
      )}

      <div className="mt-3 w-full space-y-1.5 lg:mt-5 lg:space-y-2">
        <div className="flex items-center gap-2 max-lg:flex-row lg:block lg:space-y-2">
          <SegmentedControl
            label="Receipt paper"
            value={format}
            onChange={setFormat}
            className="max-lg:w-44 max-lg:shrink-0"
            segments={[
              { value: 'compact', label: '80 mm roll' },
              { value: 'a4', label: 'A4' },
            ]}
          />
          <Button size="lg" variant="primary" icon={Printer} loading={printing} onClick={() => void print(checkout.order.id)} className="w-full max-lg:h-12 max-lg:flex-1">
            Print receipt
          </Button>
        </div>
        {/* the arrow at the top already goes back, so this button is only for larger screens */}
        <Button size="lg" variant="secondary" icon={ArrowLeft} onClick={onBack} className="w-full max-lg:hidden">
          Back to orders
        </Button>
      </div>
      {!refunded && !onCredit && can.refundOrResolve(role) && (
        <div className="mt-4 flex w-full justify-center">
          <RefundForm payment={settled} onDone={onUpdate} />
        </div>
      )}
    </div>
  );
}

function UncertainPanel({ payment, onUpdate }: { payment: Payment; onUpdate: (c: Checkout) => void }) {
  const { role } = useUser();
  return (
    <div className="space-y-4">
      <div className="flex gap-3 rounded-control bg-warning-tint p-4 text-warning">
        <TriangleAlert size={20} className="mt-0.5 shrink-0" aria-hidden />
        <div className="text-sm">
          <p className="font-semibold">Payment outcome uncertain</p>
          <p className="mt-1">
            {payment.reference} for {formatPaise(payment.amountPaise)}
            {payment.failureReason ? ` — ${payment.failureReason}` : ''}. The customer may or may not have been charged. Check the terminal
            or bank statement before taking another payment.
          </p>
        </div>
      </div>
      {can.refundOrResolve(role) ? (
        <ResolveForm payment={payment} onDone={onUpdate} />
      ) : (
        <p className="text-sm text-ink-2">Ask the Superadmin to check and resolve this payment.</p>
      )}
    </div>
  );
}

function TakePayment({ checkout, onPaid, onReload }: { checkout: Checkout; onPaid: (c: Checkout) => void; onReload: () => void }) {
  const toast = useToast();
  const bill = checkout.bill!;
  const total = bill.totalPaise;
  const [method, setMethod] = useState<'CASH' | 'UPI_MANUAL' | 'CREDIT'>('CASH');
  const [cash, setCash] = useState('');
  const [upiRef, setUpiRef] = useState('');
  const [verified, setVerified] = useState(false);
  const [failReason, setFailReason] = useState('');
  const [showFail, setShowFail] = useState(false);
  const [busy, setBusy] = useState<'pay' | 'fail' | null>(null);
  // One idempotency key per payment attempt. It is kept after a network error, so pressing
  // the button again can never record the payment twice; it changes after a definite answer.
  const keyRef = useRef(newRequestId());
  const busyRef = useRef(false);
  // On a phone, focusing the cash box at once would pop the keyboard over the screen; the quick amounts cover most sales.
  const isDesktop = typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches;

  useEffect(() => setVerified(false), [total, method]);

  const tendered = parseRupeesToPaise(cash);
  const short = tendered !== null && tendered < total ? total - tendered : 0;
  const change = tendered !== null && tendered >= total ? tendered - total : null;
  const lastFailed = checkout.payments.find((p) => p.status === 'FAILED');

  async function submit(body: PaymentRequest, kind: 'pay' | 'fail') {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(kind);
    try {
      const r = await api.recordPayment(checkout.order.id, body);
      keyRef.current = newRequestId();
      if (r.payment.status === 'SUCCEEDED') {
        toast({ tone: 'success', title: r.payment.method === 'CREDIT' ? `Put on credit · #${checkout.order.orderNumber}` : `Payment recorded · #${checkout.order.orderNumber}`, description: `${formatPaise(r.payment.amountPaise)} · ${METHOD_LABELS[r.payment.method]}` });
      } else {
        toast({ tone: 'error', title: 'Failed UPI attempt recorded', description: 'The bill is still unpaid.' });
        setShowFail(false);
        setFailReason('');
      }
      onPaid(r.checkout);
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err && err.status !== 0 && err.status < 500) keyRef.current = newRequestId();
      if (err?.code === 'BILL_CHANGED' || err?.code === 'ALREADY_PAID' || err?.code === 'PAYMENT_UNCERTAIN') onReload();
      toast({
        tone: 'error',
        title: 'Payment not recorded',
        description: err ? (err.status === 0 ? `${err.message} Nothing was recorded twice — press the button again.` : err.message) : 'Unexpected error',
      });
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2.5 lg:space-y-5">
      <SegmentedControl
        label="Payment method"
        size="lg"
        className="max-lg:[&_button]:h-9 max-lg:[&_button]:text-sm"
        value={method}
        onChange={setMethod}
        segments={[
          { value: 'CASH', label: 'Cash', icon: Banknote },
          { value: 'UPI_MANUAL', label: 'UPI', icon: Smartphone },
          { value: 'CREDIT', label: 'Credit', icon: HandCoins },
        ]}
      />

      {lastFailed && (
        <p className="flex gap-2 rounded-control bg-danger-tint px-3 py-2.5 text-sm text-danger">
          <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
          Previous attempt failed ({METHOD_LABELS[lastFailed.method]}): {lastFailed.failureReason}
        </p>
      )}

      {method === 'CREDIT' ? (
        <CreditPaymentForm
          key="credit"
          total={total}
          defaultName={checkout.order.customerName}
          defaultPhone={checkout.order.customerPhone}
          busy={busy === 'pay'}
          onConfirm={(customerName, customerPhone) =>
            void submit({ method: 'CREDIT', idempotencyKey: keyRef.current, expectedTotalPaise: total, customerName, customerPhone }, 'pay')
          }
        />
      ) : method === 'CASH' ? (
        <form
          key="cash"
          className="animate-fade space-y-2 lg:space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (tendered !== null && tendered >= total) {
              void submit({ method: 'CASH', idempotencyKey: keyRef.current, expectedTotalPaise: total, tenderedPaise: tendered }, 'pay');
            }
          }}
        >
          <label className="block">
            <span className={cx(labelClass, 'max-lg:sr-only')}>Cash received</span>
            <span className="relative block">
              <span className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-xl font-semibold text-ink-3">₹</span>
              <input
                autoFocus={isDesktop}
                inputMode="decimal"
                value={cash}
                onChange={(e) => setCash(e.target.value)}
                placeholder="0.00"
                aria-invalid={cash !== '' && tendered === null}
                className={cx(inputClass, 'h-14 pl-9 text-2xl font-semibold tabular-nums max-lg:h-11 max-lg:text-xl')}
              />
            </span>
          </label>
          <div className="flex flex-wrap gap-1.5 lg:gap-2">
            {[total, ...quickCashAmounts(total)].map((v, i) => (
              <Button key={v} size="sm" variant="secondary" onClick={() => setCash((v / 100).toFixed(2))} className="max-lg:h-8 max-lg:px-2.5 max-lg:text-xs">
                {i === 0 ? `Exact ${formatPaise(v)}` : formatPaise(v)}
              </Button>
            ))}
          </div>

          <div
            aria-live="polite"
            className={cx(
              'flex items-baseline justify-between rounded-control px-3 py-1.5 lg:px-4 lg:py-3',
              short > 0 ? 'bg-danger-tint text-danger' : change !== null ? 'bg-success-tint text-success' : 'bg-fill text-ink-2',
            )}
          >
            <span className="font-medium">{short > 0 ? 'Short by' : 'Change due'}</span>
            <span className="text-xl font-semibold tabular-nums lg:text-[26px]">
              <AnimatedValue value={short > 0 ? `s${short}` : `c${change ?? 0}`}>{formatPaise(short > 0 ? short : (change ?? 0))}</AnimatedValue>
            </span>
          </div>
          {cash !== '' && tendered === null && <p className="text-sm font-medium text-danger">Enter an amount like 700 or 650.50</p>}

          <Button
            type="submit"
            size="lg"
            variant="primary"
            icon={Banknote}
            loading={busy === 'pay'}
            disabled={tendered === null || tendered < total || !!busy}
            className="w-full max-lg:h-12"
          >
            Confirm cash payment · {formatPaise(total)}
          </Button>
        </form>
      ) : (
        <div key="upi" className="animate-fade space-y-2.5 lg:space-y-4">
          <div className="flex gap-3 rounded-control bg-accent-tint p-3 text-xs text-accent-hover lg:p-4 lg:text-sm">
            <ShieldCheck size={20} className="mt-0.5 shrink-0 max-lg:hidden" aria-hidden />
            <div>
              <p className="font-semibold">Manual verification</p>
              <p className="mt-1 lg:hidden">
                Check <strong>{formatPaise(total)}</strong> is in your merchant app or bank first. A customer's screen is not proof.
              </p>
              <p className="mt-1 hidden lg:block">
                Check that <strong>{formatPaise(total)}</strong> from this customer appears in your merchant app or bank before recording it. A
                QR code, a payment request or the customer's screen is not proof of payment. This app does not check UPI automatically.
              </p>
            </div>
          </div>
          <label className="block">
            <span className={cx(labelClass, 'max-lg:sr-only')}>UPI reference / UTR (optional)</span>
            <input value={upiRef} maxLength={64} onChange={(e) => setUpiRef(e.target.value)} placeholder="UPI reference / UTR (optional)" className={cx(inputClass, 'h-11 max-lg:h-10')} />
          </label>
          <label className="flex items-start gap-3 rounded-control bg-subtle p-2.5 text-sm lg:p-3 lg:text-[15px]">
            <input
              type="checkbox"
              checked={verified}
              onChange={(e) => setVerified(e.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--color-accent)]"
            />
            <span>
              I have verified that <strong className="tabular-nums">{formatPaise(total)}</strong> was received.
            </span>
          </label>
          <Button
            size="lg"
            variant="primary"
            icon={Smartphone}
            loading={busy === 'pay'}
            disabled={!verified || !!busy}
            className="w-full max-lg:h-12"
            onClick={() =>
              void submit(
                {
                  method: 'UPI_MANUAL',
                  idempotencyKey: keyRef.current,
                  expectedTotalPaise: total,
                  outcome: 'SUCCEEDED',
                  manuallyVerified: true,
                  ...(upiRef.trim() ? { providerReference: upiRef.trim() } : {}),
                },
                'pay',
              )
            }
          >
            Record UPI payment · {formatPaise(total)}
          </Button>

          {showFail ? (
            <form
              className="animate-enter space-y-2 rounded-control bg-subtle p-3"
              onSubmit={(e) => {
                e.preventDefault();
                void submit(
                  {
                    method: 'UPI_MANUAL',
                    idempotencyKey: keyRef.current,
                    expectedTotalPaise: total,
                    outcome: 'FAILED',
                    failureReason: failReason.trim(),
                    ...(upiRef.trim() ? { providerReference: upiRef.trim() } : {}),
                  },
                  'fail',
                );
              }}
            >
              <label className="block">
                <span className={labelClass}>What went wrong?</span>
                <input autoFocus value={failReason} maxLength={200} onChange={(e) => setFailReason(e.target.value)} placeholder="e.g. Declined by customer's bank" className={cx(inputClass, 'h-10')} />
              </label>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="plain" onClick={() => setShowFail(false)}>
                  Cancel
                </Button>
                <Button size="sm" variant="danger" type="submit" loading={busy === 'fail'} disabled={failReason.trim().length < 3 || !!busy} className="bg-danger-tint">
                  Record failed attempt
                </Button>
              </div>
            </form>
          ) : (
            <Button size="sm" variant="plain" className="w-full" onClick={() => setShowFail(true)}>
              Customer's UPI payment failed…
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function CheckoutView({ orderId, onBack }: { orderId: number; onBack: () => void }) {
  const toast = useToast();
  const { role } = useUser();
  const { subscribe } = useLiveOrders();
  const { print, printing } = useReceiptPrinter();
  const [data, setData] = useState<Checkout | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      let c = await api.getCheckout(orderId);
      // Make sure an open bill reflects the current tax settings (keeps any discount).
      if (c.order.paymentStatus === 'UNPAID' || c.order.paymentStatus === 'FAILED') {
        const d = c.bill?.discount;
        const discount: DiscountRequest =
          d && d.type === 'PERCENT'
            ? { type: 'PERCENT', bps: d.value, reason: d.reason ?? 'Discount' }
            : d && d.type === 'AMOUNT'
              ? { type: 'AMOUNT', paise: d.value, reason: d.reason ?? 'Discount' }
              : { type: 'NONE' };
        c = await api.generateBill(orderId, discount);
      }
      setData(c);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load this order');
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  // If another screen changes this order (e.g. pays it), refresh.
  useEffect(
    () =>
      subscribe(({ order }) => {
        if (order.id === orderId) void api.getCheckout(orderId).then(setData).catch(() => {});
      }),
    [subscribe, orderId],
  );

  async function applyDiscount(discount: DiscountRequest): Promise<boolean> {
    try {
      setData(await api.generateBill(orderId, discount));
      return true;
    } catch (e) {
      toast({ tone: 'error', title: 'Discount not applied', description: e instanceof ApiError ? e.message : undefined });
      return false;
    }
  }

  if (!data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-ink-2">
        {error ? (
          <>
            <p className="font-medium text-ink">{error}</p>
            <Button variant="secondary" icon={ArrowLeft} onClick={onBack}>
              Back to orders
            </Button>
          </>
        ) : (
          <p className="flex items-center gap-2">
            <Loader2 size={18} className="animate-spin" aria-hidden /> Loading bill…
          </p>
        )}
      </div>
    );
  }

  const { order } = data;
  const uncertain = data.payments.find((p) => p.status === 'PENDING' || p.status === 'UNKNOWN');
  const settled = order.paymentStatus === 'PAID' || order.paymentStatus === 'REFUNDED';
  const editable = !settled && !uncertain;

  return (
    <div className="flex min-h-0 min-w-0 w-full max-w-full flex-1 flex-col overflow-y-auto overflow-x-hidden">
      <div className="flex flex-wrap items-center gap-2 px-3 pt-2 pb-1.5 lg:gap-3 lg:px-6 lg:pt-5 lg:pb-3">
        <IconButton icon={ArrowLeft} aria-label="Back to orders" onClick={onBack} className="max-lg:h-9 max-lg:w-9" />
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight tabular-nums lg:text-xl">Checkout · #{order.orderNumber}</h2>
          <p className="text-xs text-ink-2 lg:text-sm">
            {order.orderType === 'DINE_IN' ? 'Dine-in' : 'Takeaway'}
            {order.tableNumber ? ` · Table ${order.tableNumber}` : ''} · {formatClock(order.createdAt)}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5 lg:gap-2">
          <span className="sr-only">Kitchen status:</span>
          <StatusBadge status={order.status} />
          <span className="sr-only">Payment status:</span>
          <PaymentBadge status={order.paymentStatus} method={order.paymentMethod} />
          {data.bill && !settled && (
            <Button size="sm" variant="secondary" icon={Printer} loading={printing} onClick={() => void print(order.id)} className="max-lg:h-8 max-lg:w-8 max-lg:px-0" aria-label="Print bill">
              <span className="max-lg:sr-only">Print bill</span>
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-2.5 px-3 pb-24 lg:gap-4 lg:pb-6 lg:grid-cols-[minmax(0,1fr)_420px] lg:px-6">
        <BillCard checkout={data} editable={editable && can.manageDiscounts(role)} onDiscount={applyDiscount} collapseItems={settled} />

        <section aria-label="Payment" className={cx(card, 'p-3 lg:p-6')}>
          <h2 className="mb-4 text-[15px] font-semibold text-ink-2 max-lg:sr-only">Payment</h2>
          {settled ? (
            <PaidPanel checkout={data} onUpdate={setData} onBack={onBack} />
          ) : uncertain ? (
            <UncertainPanel payment={uncertain} onUpdate={setData} />
          ) : data.bill ? (
            <TakePayment checkout={data} onPaid={setData} onReload={() => void load()} />
          ) : null}
        </section>

        {data.payments.length > 0 && (
          <section aria-label="Payment attempts" className={cx(card, 'p-3 lg:col-span-2 lg:p-5', settled && data.payments.length === 1 && 'max-lg:hidden')}>
            <h2 className="mb-2 text-[15px] font-semibold text-ink-2">Payment attempts</h2>
            <ul className="divide-y divide-line text-sm">
              {data.payments.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                  <span className="font-medium">{p.reference}</span>
                  <span className="text-ink-2">{METHOD_LABELS[p.method]}</span>
                  <span className="font-medium">{p.status}</span>
                  {p.failureReason && <span className="text-ink-2">{p.failureReason}</span>}
                  <span className="ml-auto tabular-nums">{formatPaise(p.amountPaise)}</span>
                  <span className="text-ink-2 tabular-nums">{formatClock(p.createdAt)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
