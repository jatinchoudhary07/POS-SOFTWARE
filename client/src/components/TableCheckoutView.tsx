import {
  ArrowLeft,
  Banknote,
  CheckCheck,
  CircleAlert,
  CircleCheck,
  CreditCard,
  HandCoins,
  Loader2,
  Printer,
  Smartphone,
  Tag,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import type { Bill, DiscountRequest, PaymentRequest, TableCheckoutDTO } from '../api/types';
import { formatBps, parsePercentToBps, parseRupeesToPaise, quickCashAmounts } from '../lib/amounts';
import { cx } from '../lib/cx';
import { newRequestId } from '../lib/id';
import { formatPaise } from '../lib/money';
import { formatClock } from '../lib/time';
import { useUser } from '../state/Auth';
import { useLiveOrders } from '../state/LiveOrders';
import { can } from '../state/permissions';
import { ResolveForm } from './CheckoutView';
import { CreditPaymentForm } from './CreditPaymentForm';
import { isTerminalPayment, TerminalStartPanel, TerminalWaitingPanel, useTerminalConfig } from './PaytmTerminal';
import { useReceiptPrinter } from './ReceiptPrinter';
import { AnimatedValue } from './ui/AnimatedValue';
import { Button, IconButton } from './ui/Button';
import { inputClass, labelClass } from './ui/fields';
import { METHOD_LABELS, PaymentBadge } from './ui/PaymentBadge';
import { SegmentedControl } from './ui/SegmentedControl';
import { PackTag } from './ui/PackTag';
import { StatusBadge } from './ui/StatusBadge';
import { useToast } from './ui/Toast';

const card = 'rounded-card bg-surface shadow-card';

function Row({ label, value, strong, muted }: { label: React.ReactNode; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className={cx('flex items-baseline justify-between gap-4', strong ? 'text-ink' : muted ? 'text-ink-2' : 'text-ink')}>
      <span className={cx(strong ? 'text-lg font-semibold' : 'text-[15px]')}>{label}</span>
      <span className={cx('tabular-nums', strong ? 'text-[28px] font-semibold tracking-tight' : 'text-[15px] font-medium')}>
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
      <Button size="sm" variant="plain" icon={X} disabled={disabled} onClick={() => void onApply({ type: 'NONE' })}>
        Remove discount
      </Button>
    );
  }

  if (!open) {
    return (
      <Button size="sm" variant="secondary" icon={Tag} disabled={disabled} onClick={() => setOpen(true)}>
        Add discount
      </Button>
    );
  }

  return (
    <form onSubmit={submit} className="animate-enter mt-3 space-y-3 rounded-control bg-subtle p-3 text-sm">
      <SegmentedControl
        label="Discount type"
        value={type}
        onChange={(t) => {
          setType(t);
          setValue('');
          setError(null);
        }}
        segments={[
          { value: 'PERCENT', label: 'Percent %' },
          { value: 'AMOUNT', label: 'Flat ₹' },
        ]}
      />
      <div className="flex gap-2">
        <label className="flex-1">
          <span className={labelClass}>{type === 'PERCENT' ? 'Percentage' : 'Rupees'}</span>
          <input
            autoFocus
            value={value}
            inputMode="decimal"
            placeholder={type === 'PERCENT' ? '10' : '100'}
            onChange={(e) => setValue(e.target.value)}
            className={cx(inputClass, 'h-10')}
          />
        </label>
        <label className="flex-[2]">
          <span className={labelClass}>Reason (required)</span>
          <input
            value={reason}
            maxLength={100}
            placeholder="e.g. Staff meal, promo"
            onChange={(e) => setReason(e.target.value)}
            className={cx(inputClass, 'h-10')}
          />
        </label>
      </div>
      {error && <p className="text-xs font-semibold text-danger">{error}</p>}
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

interface Props {
  tableId: number;
  onBack: () => void;
}

export function TableCheckoutView({ tableId, onBack }: Props) {
  const toast = useToast();
  const { role } = useUser();
  const { subscribe } = useLiveOrders();
  const { printTable, printing } = useReceiptPrinter();
  const [data, setData] = useState<TableCheckoutDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);

  // Payment tab and form state
  const terminal = useTerminalConfig();
  const [method, setMethod] = useState<'CASH' | 'UPI_MANUAL' | 'CREDIT' | 'TERMINAL'>('CASH');
  const [cash, setCash] = useState<string>('');
  const [upiRef, setUpiRef] = useState('');
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);

  // Idempotency key preserved per table bill attempt
  const keyRef = useRef<string>(newRequestId());

  const load = useCallback(async () => {
    try {
      let c = await api.getTableCheckout(tableId);
      // Auto-generate or sync open bill
      const hasUnpaid = c.orders.some((o) => o.paymentStatus !== 'PAID');
      // While a payment is waiting on the terminal (or is unsure) the bill is frozen: regenerating it is refused by the server.
      const paymentOpen = c.payments.some((p) => p.status === 'PENDING' || p.status === 'UNKNOWN');
      if (hasUnpaid && !paymentOpen && (!c.bill || c.bill.status === 'OPEN')) {
        const d = c.bill?.discount;
        const discount: DiscountRequest =
          d && d.type === 'PERCENT'
            ? { type: 'PERCENT', bps: d.value, reason: d.reason ?? 'Discount' }
            : d && d.type === 'AMOUNT'
              ? { type: 'AMOUNT', paise: d.value, reason: d.reason ?? 'Discount' }
              : { type: 'NONE' };
        c = await api.generateTableBill(tableId, discount);
      }
      setData(c);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load table checkout');
    } finally {
      setLoading(false);
    }
  }, [tableId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Real-time update subscription
  useEffect(() => {
    return subscribe(() => {
      void load();
    });
  }, [subscribe, load]);

  async function applyDiscount(discount: DiscountRequest): Promise<boolean> {
    try {
      const updated = await api.generateTableBill(tableId, discount);
      setData(updated);
      toast({ tone: 'success', title: 'Discount updated' });
      return true;
    } catch (e) {
      toast({ tone: 'error', title: 'Discount not applied', description: e instanceof ApiError ? e.message : undefined });
      return false;
    }
  }

  async function submitPayment(input: PaymentRequest) {
    if (!data?.bill) return;
    setBusy(true);
    try {
      const res = await api.recordTablePayment(tableId, input);
      setData(res.checkout);
      keyRef.current = newRequestId();
      if (input.method === 'TERMINAL' && res.payment.status !== 'SUCCEEDED') {
        if (res.payment.status === 'FAILED') toast({ tone: 'error', title: 'Terminal payment did not go through', description: res.payment.failureReason ?? 'The bill is still unpaid.' });
        else toast({ tone: 'success', title: 'Sent to the terminal', description: 'Waiting for the customer to pay.' });
        return;
      }
      toast({
        tone: 'success',
        title: input.method === 'CREDIT' ? 'Put on credit' : 'Payment recorded',
        description: input.method === 'CREDIT' ? `Table ${data.table.name} bill added to ${input.customerName}'s credit.` : `Bill for Table ${data.table.name} is settled.`,
      });
      // Reset idempotency key for next cycle
      keyRef.current = newRequestId();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'BILL_CHANGED') {
        toast({ tone: 'error', title: 'Bill changed', description: 'The bill changed since shown. Total reloaded.' });
        void load();
      } else {
        toast({ tone: 'error', title: 'Payment failed', description: e instanceof ApiError ? e.message : undefined });
      }
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-ink-2">
        <Loader2 size={24} className="animate-spin text-accent" />
        <p>Loading table billing...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center p-6 text-ink-2">
        <CircleAlert size={36} className="text-warning" />
        <p className="font-medium text-ink">{error || 'Table not found'}</p>
        <Button variant="secondary" icon={ArrowLeft} onClick={onBack}>
          Back to Tables
        </Button>
      </div>
    );
  }

  const { table, orders, bill, payments } = data;
  const isPaid = bill?.status === 'PAID';
  const total = bill?.totalPaise ?? 0;
  const tendered = parseRupeesToPaise(cash);
  const change = tendered !== null && tendered >= total ? tendered - total : null;
  const short = tendered !== null && tendered < total ? total - tendered : 0;
  const settledPayment = payments.find((p) => p.status === 'SUCCEEDED');
  const openPayment = payments.find((p) => p.status === 'PENDING' || p.status === 'UNKNOWN');

  return (
    <div className="flex min-h-0 min-w-0 w-full max-w-full flex-1 flex-col overflow-y-auto overflow-x-hidden">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface/80 px-4 py-3.5 backdrop-blur-md sm:px-6">
        <IconButton icon={ArrowLeft} aria-label="Back to tables" onClick={onBack} />
        <div>
          <h1 className="text-xl font-bold tracking-tight text-ink">
            Table Billing &bull; {table.name}
          </h1>
          <p className="text-xs text-ink-2">
            Combining {orders.length} order{orders.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {!isPaid && bill && (
            <Button
              size="sm"
              variant="secondary"
              icon={Printer}
              loading={printing}
              onClick={() => void printTable(tableId)}
            >
              Print Bill
            </Button>
          )}
          {isPaid ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-success-tint px-3 py-1 text-xs font-bold text-success">
              <CircleCheck size={14} aria-hidden /> PAID &amp; SETTLED
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-warning-tint px-3 py-1 text-xs font-bold text-warning">
              <span className="h-2 w-2 rounded-full bg-warning animate-pulse" aria-hidden /> OPEN BILL
            </span>
          )}
        </div>
      </div>

      {/* Main Grid: Bill Snapshot (Left) + Payment (Right) */}
      <div className="grid gap-6 p-4 sm:p-6 pb-24 sm:pb-6 lg:grid-cols-[minmax(0,1fr)_440px]">
        {/* Left Column: Orders Breakdown and Bill Details */}
        <div className="space-y-6">
          {/* Covered Orders Accordion / Card */}
          <section className={cx(card, 'p-5 sm:p-6')}>
            <h2 className="text-base font-bold tracking-tight text-ink">
              Orders Included in this Bill ({orders.length})
            </h2>
            <div className="mt-4 space-y-4 divide-y divide-line">
              {orders.map((o) => (
                <div key={o.id} className={cx('pt-3 first:pt-0')}>
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-mono text-sm font-bold text-ink">#{o.orderNumber}</span>
                      <span className="ml-2 text-xs text-ink-2">{formatClock(o.createdAt)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={o.status} />
                      <PaymentBadge status={o.paymentStatus} />
                    </div>
                  </div>

                  <ul className="mt-2.5 space-y-1 text-sm text-ink-2">
                    {o.items.map((i) => (
                      <li key={i.id} className="flex justify-between">
                        <span>
                          <strong className="text-ink">{i.quantity}&times;</strong> {i.itemName} {i.packed && <PackTag className="ml-1 align-middle" />}
                        </span>
                        <span className="tabular-nums font-medium text-ink">{formatPaise(i.lineTotalPaise)}</span>
                      </li>
                    ))}
                  </ul>

                  <div className="mt-2 flex justify-between text-xs text-ink-3">
                    <span>Order Subtotal</span>
                    <span className="tabular-nums font-semibold text-ink">{formatPaise(o.subtotalPaise)}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Bill Calculation Snapshot */}
          {bill && (
            <section className={cx(card, 'space-y-3.5 p-5 sm:p-6')}>
              <h2 className="text-base font-bold tracking-tight text-ink">Bill Summary</h2>

              <Row label="Combined Subtotal" value={formatPaise(bill.subtotalPaise)} />

              {/* Discount Row */}
              <div className="flex items-center justify-between gap-4 border-t border-line/60 pt-3">
                <div>
                  <div className="text-[15px] font-medium text-ink">
                    Discount
                    {bill.discount.type !== 'NONE' && (
                      <span className="ml-2 text-xs text-ink-2">
                        ({bill.discount.type === 'PERCENT' ? formatBps(bill.discount.value) : `₹${(bill.discount.value / 100).toFixed(2)}`} &bull; {bill.discount.reason})
                      </span>
                    )}
                  </div>
                  {!isPaid && can.manageDiscounts(role) && (
                    <div className="mt-1">
                      <DiscountEditor bill={bill} disabled={isPaid} onApply={applyDiscount} />
                    </div>
                  )}
                </div>
                <span className="tabular-nums font-medium text-ink">
                  {bill.discount.paise > 0 ? `−${formatPaise(bill.discount.paise)}` : '₹0.00'}
                </span>
              </div>

              {/* Taxable Subtotal */}
              <Row label="Taxable Amount" value={formatPaise(bill.taxablePaise)} muted />

              {/* Tax Lines */}
              {bill.taxLines.map((t, i) => (
                <Row key={i} label={`${t.name} (${formatBps(t.rateBps)})`} value={formatPaise(t.amountPaise)} muted />
              ))}

              {/* Round Off */}
              {bill.roundOffPaise !== 0 && (
                <Row
                  label="Round off"
                  value={`${bill.roundOffPaise > 0 ? '+' : ''}${formatPaise(bill.roundOffPaise)}`}
                  muted
                />
              )}

              {/* Grand Total */}
              <div className="border-t border-line pt-3">
                <Row label="Total Amount Due" value={formatPaise(bill.totalPaise)} strong />
              </div>
            </section>
          )}
        </div>

        {/* Right Column: Settle / Take Payment */}
        <div>
          <section className={cx(card, 'sticky top-6 p-5 sm:p-6')}>
            {isPaid ? (
              <div className="space-y-5 text-center">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-success-tint text-success">
                  <CircleCheck size={36} />
                </div>
                <div>
                  <h3 className="text-xl font-bold tracking-tight text-ink">{settledPayment?.method === 'CREDIT' ? 'Bill put on credit' : 'Bill Paid Successfully'}</h3>
                  <p className="mt-1 text-sm text-ink-2">
                    {settledPayment?.method === 'CREDIT' ? `Table ${table.name} is closed. The amount is added to the customer's credit and can be collected from Sales → Credit.` : `Table ${table.name} has been settled and all orders are reconciled.`}
                  </p>
                </div>

                {settledPayment && (
                  <div className="rounded-control bg-fill p-4 text-left text-sm space-y-1.5">
                    <div className="flex justify-between">
                      <span className="text-ink-2">Method:</span>
                      <span className="font-semibold text-ink">{METHOD_LABELS[settledPayment.method]}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-ink-2">Amount Paid:</span>
                      <span className="font-semibold text-ink">{formatPaise(settledPayment.amountPaise)}</span>
                    </div>
                    {settledPayment.tenderedPaise && (
                      <div className="flex justify-between">
                        <span className="text-ink-2">Tendered / Change:</span>
                        <span className="font-mono text-ink">
                          {formatPaise(settledPayment.tenderedPaise)} / {formatPaise(settledPayment.changePaise ?? 0)}
                        </span>
                      </div>
                    )}
                    {settledPayment.providerReference && (
                      <div className="flex justify-between">
                        <span className="text-ink-2">UPI Ref:</span>
                        <span className="font-mono text-ink">{settledPayment.providerReference}</span>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex flex-col gap-2.5 pt-2">
                  <Button
                    size="lg"
                    variant="primary"
                    icon={Printer}
                    loading={printing}
                    onClick={() => void printTable(tableId)}
                    className="w-full"
                  >
                    Print Receipt
                  </Button>
                  <Button
                    size="md"
                    variant="secondary"
                    icon={CheckCheck}
                    loading={clearing}
                    onClick={async () => {
                      setClearing(true);
                      try {
                        await api.clearTable(tableId);
                        toast({ tone: 'success', title: 'Table cleared', description: `Table ${table.name} is now available.` });
                        onBack();
                      } catch (e) {
                        toast({ tone: 'error', title: 'Could not clear table', description: e instanceof ApiError ? e.message : undefined });
                      } finally {
                        setClearing(false);
                      }
                    }}
                    className="w-full"
                  >
                    Clear &amp; Free Table
                  </Button>
                  <Button
                    size="md"
                    variant="plain"
                    icon={ArrowLeft}
                    onClick={onBack}
                    className="w-full text-ink-2"
                  >
                    Return to Dining Tables
                  </Button>
                </div>
              </div>
            ) : openPayment && isTerminalPayment(openPayment) ? (
              <div className="space-y-5">
                <div>
                  <h3 className="text-base font-bold tracking-tight text-ink">Payment on the terminal</h3>
                  <p className="text-xs text-ink-2">The bill is paid only when the terminal confirms the money.</p>
                </div>
                <TerminalWaitingPanel payment={openPayment} onChanged={() => void load()} />
                {role === 'SUPERADMIN' && (
                  <details open={openPayment.status === 'UNKNOWN'} className="rounded-control bg-subtle p-3 text-sm">
                    <summary className="cursor-pointer font-semibold text-ink-2">Settle by hand (Superadmin)</summary>
                    <div className="mt-3">
                      <ResolveForm payment={openPayment} onDone={() => void load()} />
                    </div>
                  </details>
                )}
              </div>
            ) : bill ? (
              <div className="space-y-5">
                <div>
                  <h3 className="text-base font-bold tracking-tight text-ink">Record Payment</h3>
                  <p className="text-xs text-ink-2">Select payment method and collect payment.</p>
                </div>

                <SegmentedControl
                  label="Payment method"
                  size="lg"
                  value={method}
                  onChange={setMethod}
                  segments={[
                    { value: 'CASH', label: 'Cash', icon: Banknote },
                    { value: 'UPI_MANUAL', label: 'UPI QR', icon: Smartphone },
                    { value: 'CREDIT', label: 'Credit', icon: HandCoins },
                    ...(terminal?.enabled ? [{ value: 'TERMINAL' as const, label: 'Paytm', icon: CreditCard }] : []),
                  ]}
                />

                {method === 'TERMINAL' ? (
                  <TerminalStartPanel
                    key="terminal"
                    total={total}
                    busy={busy}
                    practice={!!terminal?.practice}
                    onSend={() => void submitPayment({ method: 'TERMINAL', idempotencyKey: keyRef.current, expectedTotalPaise: total })}
                  />
                ) : method === 'CREDIT' ? (
                  <CreditPaymentForm
                    key="credit"
                    total={total}
                    defaultName={data.orders.find((o) => o.customerName)?.customerName}
                    defaultPhone={data.orders.find((o) => o.customerPhone)?.customerPhone}
                    busy={busy}
                    onConfirm={(customerName, customerPhone) =>
                      void submitPayment({ method: 'CREDIT', idempotencyKey: keyRef.current, expectedTotalPaise: total, customerName, customerPhone })
                    }
                  />
                ) : method === 'CASH' ? (
                  <div className="space-y-4">
                    <label className="block">
                      <span className={labelClass}>Cash received (₹)</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        autoFocus
                        value={cash}
                        placeholder={(total / 100).toFixed(2)}
                        onChange={(e) => setCash(e.target.value)}
                        className={cx(inputClass, 'h-12 text-lg font-bold tabular-nums')}
                      />
                    </label>

                    {/* Quick Cash Buttons */}
                    <div className="flex flex-wrap gap-2">
                      {[total, ...quickCashAmounts(total)].map((amt, i) => (
                        <button
                          key={amt}
                          type="button"
                          onClick={() => setCash((amt / 100).toFixed(2))}
                          className="rounded-control bg-fill px-3 py-1.5 text-xs font-semibold text-ink hover:bg-line transition-colors"
                        >
                          {i === 0 ? `Exact ${formatPaise(amt)}` : formatPaise(amt)}
                        </button>
                      ))}
                    </div>

                    {/* Change Due Box */}
                    <div
                      className={cx(
                        'flex items-baseline justify-between rounded-control p-4',
                        short > 0 ? 'bg-danger-tint text-danger' : change !== null ? 'bg-success-tint text-success' : 'bg-fill text-ink-2',
                      )}
                    >
                      <span className="font-semibold text-sm">{short > 0 ? 'Underpaid by' : 'Change Due'}</span>
                      <span className="text-2xl font-extrabold tabular-nums">
                        {formatPaise(short > 0 ? short : (change ?? 0))}
                      </span>
                    </div>

                    <Button
                      size="lg"
                      variant="primary"
                      icon={Banknote}
                      loading={busy}
                      disabled={tendered === null || tendered < total || busy}
                      className="w-full text-base"
                      onClick={() =>
                        void submitPayment({
                          method: 'CASH',
                          idempotencyKey: keyRef.current,
                          expectedTotalPaise: total,
                          tenderedPaise: tendered!,
                        })
                      }
                    >
                      Confirm Cash Payment &bull; {formatPaise(total)}
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="rounded-control bg-accent-tint p-4 text-xs text-accent-hover">
                      <p className="font-semibold">Manual UPI Verification</p>
                      <p className="mt-1">
                        Confirm <strong>{formatPaise(total)}</strong> is credited to your merchant account before finalizing.
                      </p>
                    </div>

                    <label className="block">
                      <span className={labelClass}>UPI Reference / UTR (optional)</span>
                      <input
                        value={upiRef}
                        maxLength={64}
                        placeholder="e.g. 123456789012"
                        onChange={(e) => setUpiRef(e.target.value)}
                        className={cx(inputClass, 'h-11')}
                      />
                    </label>

                    <label className="flex items-start gap-3 rounded-control bg-subtle p-3 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={verified}
                        onChange={(e) => setVerified(e.target.checked)}
                        className="mt-0.5 h-4 w-4 rounded accent-accent shrink-0"
                      />
                      <span className="text-ink">
                        I confirm that <strong>{formatPaise(total)}</strong> has been received.
                      </span>
                    </label>

                    <Button
                      size="lg"
                      variant="primary"
                      icon={Smartphone}
                      loading={busy}
                      disabled={!verified || busy}
                      className="w-full text-base"
                      onClick={() =>
                        void submitPayment({
                          method: 'UPI_MANUAL',
                          idempotencyKey: keyRef.current,
                          expectedTotalPaise: total,
                          outcome: 'SUCCEEDED',
                          manuallyVerified: true,
                          ...(upiRef.trim() ? { providerReference: upiRef.trim() } : {}),
                        })
                      }
                    >
                      Record UPI Payment &bull; {formatPaise(total)}
                    </Button>
                  </div>
                )}
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}
