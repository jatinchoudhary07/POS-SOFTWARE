import { CreditCard, Loader2, RefreshCw, ShieldAlert, TriangleAlert, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { MockScenarioName, Payment, PaymentsConfig, TerminalAttempt } from '../api/types';
import { cx } from '../lib/cx';
import { formatPaise } from '../lib/money';
import { useUser } from '../state/Auth';
import { Button } from './ui/Button';
import { useToast } from './ui/Toast';

/** True for a payment taken on the Paytm terminal (practice terminal included). */
export const isTerminalPayment = (p: Pick<Payment, 'method' | 'provider'>) => p.method === 'TERMINAL' && p.provider.startsWith('PAYTM');

type TerminalConfig = PaymentsConfig['terminal'];
let cachedConfig: TerminalConfig | null = null;

/** Whether the card/UPI terminal is on. null until known; remembered for the session, so tabs do not flicker. */
export function useTerminalConfig(): TerminalConfig | null {
  const [cfg, setCfg] = useState<TerminalConfig | null>(cachedConfig);
  useEffect(() => {
    if (cachedConfig) return;
    let live = true;
    api
      .getPaymentsConfig()
      .then((c) => {
        cachedConfig = c.terminal;
        if (live) setCfg(c.terminal);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return cfg;
}

const SCENARIOS: [MockScenarioName, string][] = [
  ['SUCCESS', 'Customer pays'],
  ['CUSTOMER_CANCEL', 'Customer cancels'],
  ['BANK_REJECT', 'Bank declines'],
  ['TERMINAL_OFFLINE', 'Terminal offline'],
  ['SALE_TIMEOUT', 'Request gets no answer'],
  ['ACCEPTED_NO_RESULT', 'Accepted, never finishes'],
  ['DUPLICATE_ID', 'Duplicate transaction id'],
  ['TERMINAL_BUSY', 'Terminal busy'],
  ['INVALID_CHECKSUM', 'Invalid checksum'],
  ['MISMATCH_AMOUNT', 'Wrong amount comes back'],
  ['MISMATCH_MID', 'Wrong merchant id comes back'],
  ['MISMATCH_TID', 'Wrong terminal id comes back'],
];

/** Practice mode, Superadmin only: choose what the pretend terminal does with the next payment. */
function PracticePicker() {
  const toast = useToast();
  const [value, setValue] = useState<MockScenarioName>('SUCCESS');
  return (
    <label className="block rounded-control bg-subtle p-3 text-sm">
      <span className="mb-1 block text-xs font-semibold text-ink-2">Practice: what the pretend terminal does next</span>
      <select
        value={value}
        onChange={(e) => {
          const next = e.target.value as MockScenarioName;
          setValue(next);
          api.setMockScenario(next).then(
            () => toast({ tone: 'success', title: 'Practice terminal updated' }),
            (err) => toast({ tone: 'error', title: 'Could not change it', description: err instanceof ApiError ? err.message : undefined }),
          );
        }}
        className="h-10 w-full rounded-control border border-line bg-surface px-3 text-sm"
      >
        {SCENARIOS.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The "Paytm" tab: send the bill to the terminal. */
export function TerminalStartPanel({ total, busy, practice, onSend }: { total: number; busy: boolean; practice: boolean; onSend: () => void }) {
  const { role } = useUser();
  return (
    <div className="animate-fade space-y-2.5 lg:space-y-4">
      {practice && (
        <div className="flex gap-2 rounded-control bg-warning-tint p-3 text-xs font-semibold text-warning lg:text-sm">
          <ShieldAlert size={18} className="mt-0.5 shrink-0" aria-hidden />
          <span>Practice mode: this is a pretend terminal. No real money moves and nothing is sent to Paytm.</span>
        </div>
      )}
      <div className="rounded-control bg-accent-tint p-3 text-xs text-accent-hover lg:p-4 lg:text-sm">
        <p className="font-semibold">Card or UPI on the Paytm terminal</p>
        <p className="mt-1">
          Sends <strong>{formatPaise(total)}</strong> to the terminal. The customer pays there, and this screen updates by itself. The bill is only marked
          paid once the terminal confirms the money.
        </p>
      </div>
      {practice && role === 'SUPERADMIN' && <PracticePicker />}
      <Button size="lg" variant="primary" icon={CreditCard} loading={busy} disabled={busy} className="w-full max-lg:h-12" onClick={onSend}>
        Send to terminal · {formatPaise(total)}
      </Button>
    </div>
  );
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Shown while a terminal payment is not settled. Looks at the payment every couple of seconds (the server does the real
 * checking), and tells the screen to reload as soon as the payment changes. Never decides anything itself.
 */
export function TerminalWaitingPanel({ payment, onChanged }: { payment: Payment; onChanged: () => void }) {
  const toast = useToast();
  const [attempt, setAttempt] = useState<TerminalAttempt | null>(null);
  const [checking, setChecking] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const lastStatus = useRef(payment.status);

  const apply = (a: TerminalAttempt) => {
    setAttempt(a);
    if (a.paymentStatus !== lastStatus.current) {
      lastStatus.current = a.paymentStatus;
      onChanged();
    }
  };

  useEffect(() => {
    lastStatus.current = payment.status;
  }, [payment.status]);

  useEffect(() => {
    let live = true;
    const look = () => {
      api.getTerminalAttempt(payment.id).then((a) => live && apply(a), () => undefined);
    };
    look();
    const every = window.setInterval(look, payment.status === 'UNKNOWN' ? 5000 : 2000);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      live = false;
      window.clearInterval(every);
      window.clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payment.id, payment.status]);

  async function checkNow() {
    setChecking(true);
    try {
      apply(await api.checkTerminalPayment(payment.id));
    } catch (err) {
      toast({ tone: 'error', title: 'Could not check', description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setChecking(false);
    }
  }

  const unknown = (attempt?.state ?? (payment.status === 'UNKNOWN' ? 'UNKNOWN' : 'ACCEPTED')) === 'UNKNOWN';
  const sending = attempt?.state === 'CREATED' || attempt?.state === 'SENDING';
  const waited = attempt ? mmss(now - new Date(attempt.startedAt).getTime()) : null;

  return (
    <div className="space-y-3 lg:space-y-4" aria-live="polite">
      {attempt?.mock && <p className="rounded-full bg-warning-tint px-3 py-1 text-center text-xs font-semibold text-warning">Practice mode: pretend terminal</p>}

      {unknown ? (
        <div className="flex gap-3 rounded-control bg-warning-tint p-4 text-warning">
          <TriangleAlert size={20} className="mt-0.5 shrink-0" aria-hidden />
          <div className="text-sm">
            <p className="font-semibold">Payment outcome not certain</p>
            <p className="mt-1">
              {payment.reference} for {formatPaise(payment.amountPaise)}. {attempt?.needsReview ? '' : `${attempt?.message ?? payment.failureReason ?? ''} `}The customer may or may not have been charged.
              Check the terminal, then press Check now. Do not take another payment until this is settled.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-control bg-accent-tint px-4 py-5 text-center text-accent-hover">
          {sending ? <Loader2 size={30} className="animate-spin" aria-hidden /> : <CreditCard size={30} className="animate-pulse" aria-hidden />}
          <p className="text-base font-semibold">{attempt?.message ?? 'Waiting for the customer to pay on the terminal'}</p>
          <p className="text-2xl font-extrabold tabular-nums text-ink">{formatPaise(payment.amountPaise)}</p>
          {waited && <p className="text-xs tabular-nums text-ink-2">Waiting {waited}</p>}
          <p className="text-xs text-ink-2">This screen updates by itself. The bill is not paid until the terminal confirms.</p>
        </div>
      )}

      {attempt?.needsReview && (
        <p role="alert" className="flex gap-2 rounded-control bg-danger-tint px-3 py-2.5 text-sm text-danger">
          <ShieldAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span>{attempt.reviewNote ?? 'Something did not add up. Ask the Superadmin to check this payment.'}</span>
        </p>
      )}

      <Button size="md" variant="secondary" icon={RefreshCw} loading={checking} disabled={checking} onClick={() => void checkNow()} className="w-full">
        Check now
      </Button>
    </div>
  );
}

/** Superadmin: cancel a successful terminal payment on the day it was taken. */
export function TerminalVoidButton({ payment, onDone }: { payment: Payment; onDone: () => void }) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!isTerminalPayment(payment) || payment.status !== 'SUCCEEDED') return null;

  async function run() {
    setBusy(true);
    try {
      const t = await api.voidTerminalPayment(payment.id);
      toast({ tone: t.voidState === 'VOIDED' ? 'success' : 'error', title: t.voidState === 'VOIDED' ? 'Payment voided' : 'Void not confirmed yet', description: t.voidMessage ?? undefined });
      onDone();
    } catch (err) {
      toast({ tone: 'error', title: 'Could not void', description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return confirming ? (
    <div className={cx('w-full animate-enter space-y-2 rounded-control bg-subtle p-4 text-left text-sm')}>
      <p className="text-ink-2">
        Cancels <strong className="text-ink">{formatPaise(payment.amountPaise)}</strong> on the terminal and marks the bill refunded. Only possible on the day it was paid.
      </p>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="plain" onClick={() => setConfirming(false)}>
          Keep payment
        </Button>
        <Button size="sm" variant="danger" loading={busy} disabled={busy} onClick={() => void run()} className="bg-danger-tint">
          Void payment
        </Button>
      </div>
    </div>
  ) : (
    <Button size="sm" variant="plain" icon={Undo2} onClick={() => setConfirming(true)}>
      Void on terminal (today only)…
    </Button>
  );
}
