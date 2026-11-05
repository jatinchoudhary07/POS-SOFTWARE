import { Banknote, CheckCheck, ChevronRight, HandCoins, Loader2, Phone, Search, Smartphone, Users, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { CreditCustomer, CreditCustomerDetail, CreditSale } from '../api/types';
import { parseRupeesToPaise } from '../lib/amounts';
import { cx } from '../lib/cx';
import { newRequestId } from '../lib/id';
import { formatPaise } from '../lib/money';
import { useCountUp } from './dashboard/useCountUp';
import { BottomSheet } from './ui/BottomSheet';
import { Button } from './ui/Button';
import { inputClass, labelClass } from './ui/fields';
import { SegmentedControl } from './ui/SegmentedControl';
import { useToast } from './ui/Toast';

const when = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
};

const ago = (iso: string) => {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
};

const AVATARS = ['bg-orange-100 text-orange-600', 'bg-teal-100 text-teal-600', 'bg-sky-100 text-sky-600', 'bg-violet-100 text-violet-600', 'bg-rose-100 text-rose-600', 'bg-amber-100 text-amber-600'];

/** Customers who took food on credit and still owe money. Tap one to see which bills are left and collect payment. */
export function CreditBook({ light = false }: { light?: boolean }) {
  const [customers, setCustomers] = useState<CreditCustomer[] | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++latest.current;
    try {
      const rows = await api.creditCustomers({ q: q.trim() || undefined });
      if (ticket !== latest.current) return;
      setCustomers(rows);
      setError(null);
    } catch (e) {
      if (ticket === latest.current) setError(e instanceof ApiError ? e.message : 'Could not load the credit book');
    }
  }, [q]);

  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const total = customers?.reduce((n, c) => n + c.outstandingPaise, 0) ?? 0;
  const animated = useCountUp(total, 900);

  return (
    <section aria-label="Credit" className="mx-auto w-full max-w-2xl animate-enter">
      <div className={cx('rounded-[28px] p-4 sm:p-5', light ? 'bg-surface shadow-card' : 'bg-white/85 shadow-[0_10px_40px_-12px_rgba(120,80,40,0.18)] ring-1 ring-white backdrop-blur-xl')}>
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-amber-100 text-amber-600">
            <HandCoins size={22} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-slate-500">Total left to collect</p>
            <p className="text-2xl font-black tracking-tight text-slate-900 tabular-nums">{formatPaise(Math.round(animated))}</p>
          </div>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600 tabular-nums">
            {customers?.length ?? 0} {customers?.length === 1 ? 'customer' : 'customers'}
          </span>
        </div>

        <div className="relative mt-3">
          <Search size={16} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-slate-400" aria-hidden />
          <input
            type="search"
            aria-label="Search customers"
            placeholder="Search name or phone…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-11 w-full rounded-full border border-transparent bg-slate-100/80 pr-10 pl-10 text-sm text-slate-900 outline-none transition-all placeholder:text-slate-400 focus:border-orange-300 focus:bg-white focus:shadow-[0_0_0_4px_rgba(251,146,60,0.15)]"
          />
          {q && (
            <button type="button" aria-label="Clear search" onClick={() => setQ('')} className="absolute top-1/2 right-3 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 hover:bg-slate-200 hover:text-slate-700">
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-3 rounded-2xl bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
          {error}
        </p>
      )}

      {!customers ? (
        <div className="space-y-2.5 pt-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[76px] animate-pulse rounded-[22px] bg-white/70" style={{ animationDelay: `${i * 90}ms` }} />
          ))}
        </div>
      ) : customers.length === 0 ? (
        <div className="mt-3 rounded-[28px] bg-white/70 px-6 py-14 text-center animate-fade">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
            <CheckCheck size={24} aria-hidden />
          </span>
          <p className="mt-3 font-bold text-slate-800">{q ? 'No customer found' : 'Nothing left to collect'}</p>
          <p className="mt-1 text-sm text-slate-500">{q ? 'Try another name or number.' : 'Bills put on credit will show up here until they are paid.'}</p>
        </div>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {customers.map((c, i) => (
            <li key={c.id} className="animate-card-rise" style={{ animationDelay: `${Math.min(i, 12) * 45}ms` }}>
              <button
                type="button"
                onClick={() => setOpenId(c.id)}
                className="group flex w-full items-center gap-3 rounded-[22px] bg-white/90 p-3.5 text-left shadow-[0_4px_18px_-6px_rgba(120,80,40,0.14)] ring-1 ring-white transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_10px_26px_-8px_rgba(120,80,40,0.25)] active:scale-[0.985]"
              >
                <span className={cx('flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-base font-black transition-transform duration-300 group-hover:scale-105', AVATARS[c.id % AVATARS.length])}>
                  {c.name.charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold text-slate-900">{c.name}</span>
                  <span className="block text-xs text-slate-500 tabular-nums">{c.phone}</span>
                  <span className="block text-[11px] text-slate-400">
                    {c.openBills} {c.openBills === 1 ? 'bill' : 'bills'} · last activity {ago(c.lastActivityAt)}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Left</span>
                  <span className="block text-base font-extrabold text-rose-600 tabular-nums">{formatPaise(c.outstandingPaise)}</span>
                </span>
                <ChevronRight size={16} className="shrink-0 text-slate-300 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      {openId !== null && (
        <CreditCustomerSheet
          key={openId}
          customerId={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => void load()}
        />
      )}
    </section>
  );
}

/** Bottom sheet: how much is left, bill by bill, with a form to record money received. */
function CreditCustomerSheet({ customerId, onClose, onChanged }: { customerId: number; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<CreditCustomerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which bill the payment goes to; null = oldest bills first.
  const [target, setTarget] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'CASH' | 'UPI_MANUAL'>('CASH');
  const [verified, setVerified] = useState(false);
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const keyRef = useRef(newRequestId());
  const formRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.creditCustomer(customerId).then(setData).catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load this customer'));
  }, [customerId]);

  const targetSale = data?.sales.find((s) => s.id === target) ?? null;
  const owed = targetSale ? targetSale.remainingPaise : (data?.customer.outstandingPaise ?? 0);
  const paise = parseRupeesToPaise(amount);
  const tooMuch = paise !== null && paise > owed;
  const canSave = paise !== null && paise > 0 && !tooMuch && (method === 'CASH' || verified) && !busy;

  async function save() {
    if (!data || paise === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.collectCredit(customerId, {
        amountPaise: paise,
        method,
        idempotencyKey: keyRef.current,
        ...(targetSale ? { creditSaleId: targetSale.id } : {}),
        ...(method === 'UPI_MANUAL' ? { manuallyVerified: true, ...(ref.trim() ? { providerReference: ref.trim() } : {}) } : {}),
      });
      keyRef.current = newRequestId();
      setData(r);
      setAmount('');
      setVerified(false);
      setRef('');
      setTarget(null);
      onChanged();
      toast({
        tone: 'success',
        title: `${formatPaise(paise)} received from ${r.customer.name}`,
        description: r.customer.outstandingPaise > 0 ? `${formatPaise(r.customer.outstandingPaise)} still left.` : 'All paid up.',
      });
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err && err.status !== 0 && err.status < 500) keyRef.current = newRequestId();
      setError(err ? (err.status === 0 ? `${err.message} Nothing was recorded twice, tap the button again.` : err.message) : 'Could not record the payment');
    } finally {
      setBusy(false);
    }
  }

  const c = data?.customer;
  return (
    <BottomSheet title={c ? c.name : 'Customer'} onClose={onClose}>
      {!data ? (
        <p className="flex items-center justify-center gap-2 py-10 text-sm text-ink-2">
          {error ?? (
            <>
              <Loader2 size={16} className="animate-spin" aria-hidden /> Loading…
            </>
          )}
        </p>
      ) : (
        <div className="space-y-4 pt-1">
          <div className="flex items-end justify-between gap-3 rounded-[22px] bg-subtle p-4">
            <div className="min-w-0">
              <a href={`tel:${data.customer.phone}`} className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent-hover tabular-nums hover:underline">
                <Phone size={14} aria-hidden /> {data.customer.phone}
              </a>
              <p className="mt-2 text-xs font-medium text-ink-2">Left to pay</p>
              <p className={cx('text-3xl font-black tracking-tight tabular-nums', data.customer.outstandingPaise > 0 ? 'text-rose-600' : 'text-emerald-600')}>
                {formatPaise(data.customer.outstandingPaise)}
              </p>
            </div>
            <dl className="space-y-0.5 text-right text-xs text-ink-2">
              <div>
                Total on credit <dd className="inline font-semibold text-ink tabular-nums">{formatPaise(data.customer.givenPaise)}</dd>
              </div>
              <div>
                Paid back <dd className="inline font-semibold text-emerald-600 tabular-nums">{formatPaise(data.customer.collectedPaise)}</dd>
              </div>
            </dl>
          </div>

          {data.customer.outstandingPaise > 0 && (
            <div ref={formRef} className="space-y-3 rounded-[22px] bg-accent-wash p-4 ring-1 ring-accent-tint">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-bold">Collect payment</h4>
                <span className="text-xs text-ink-2">
                  {targetSale ? (
                    <>
                      For bill <strong>#{targetSale.orderNumbers.join(', #')}</strong>{' '}
                      <button type="button" onClick={() => setTarget(null)} className="font-semibold text-accent-hover underline">
                        change
                      </button>
                    </>
                  ) : (
                    'Oldest bills are paid first'
                  )}
                </span>
              </div>
              <label className="block">
                <span className={labelClass}>Amount received</span>
                <span className="relative block">
                  <span className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-lg font-semibold text-ink-3">₹</span>
                  <input
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    aria-invalid={tooMuch || (amount !== '' && paise === null)}
                    className={cx(inputClass, 'h-12 pl-9 text-xl font-semibold tabular-nums')}
                  />
                </span>
              </label>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => setAmount((owed / 100).toFixed(2))}>
                  All {formatPaise(owed)}
                </Button>
                {owed >= 20000 && (
                  <Button size="sm" variant="secondary" onClick={() => setAmount((Math.round(owed / 2 / 100)).toFixed(2))}>
                    Half
                  </Button>
                )}
              </div>
              {tooMuch && <p className="text-sm font-medium text-danger">That is more than the {formatPaise(owed)} still left.</p>}
              {amount !== '' && paise === null && <p className="text-sm font-medium text-danger">Enter an amount like 500 or 250.50</p>}

              <SegmentedControl
                label="How was it paid"
                value={method}
                onChange={(m) => {
                  setMethod(m);
                  setVerified(false);
                }}
                segments={[
                  { value: 'CASH', label: 'Cash', icon: Banknote },
                  { value: 'UPI_MANUAL', label: 'UPI', icon: Smartphone },
                ]}
              />
              {method === 'UPI_MANUAL' && (
                <div className="animate-fade space-y-2">
                  <input value={ref} maxLength={64} onChange={(e) => setRef(e.target.value)} placeholder="UPI reference / UTR (optional)" className={cx(inputClass, 'h-10')} />
                  <label className="flex items-start gap-3 rounded-control bg-surface p-3 text-sm">
                    <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--color-accent)]" />
                    <span>I checked in my merchant app or bank that this money was received.</span>
                  </label>
                </div>
              )}

              {error && (
                <p role="alert" className="rounded-2xl bg-danger-tint px-3 py-2 text-sm font-medium text-danger">
                  {error}
                </p>
              )}
              <Button size="lg" variant="primary" icon={CheckCheck} loading={busy} disabled={!canSave} onClick={() => void save()} className="w-full">
                {paise ? `Record ${formatPaise(paise)} received` : 'Record payment'}
              </Button>
            </div>
          )}

          <div>
            <h4 className="mb-2 flex items-center gap-2 text-sm font-bold">
              <Users size={15} aria-hidden className="text-ink-3" /> Bills on credit
            </h4>
            <ul className="space-y-2.5">
              {data.sales.map((s) => (
                <SaleCard
                  key={s.id}
                  sale={s}
                  selected={target === s.id}
                  onCollect={() => {
                    setTarget(s.id);
                    setAmount((s.remainingPaise / 100).toFixed(2));
                    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  }}
                />
              ))}
            </ul>
          </div>
        </div>
      )}
    </BottomSheet>
  );
}

function SaleCard({ sale: s, selected, onCollect }: { sale: CreditSale; selected: boolean; onCollect: () => void }) {
  const [open, setOpen] = useState(false);
  const done = s.remainingPaise === 0;
  const pct = Math.round((s.paidPaise / s.amountPaise) * 100);
  return (
    <li className={cx('rounded-[20px] p-3.5 ring-1 transition-all', selected ? 'bg-accent-wash ring-accent' : 'bg-subtle ring-line', done && 'opacity-70')}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold">
            #{s.orderNumbers.join(', #')}
            {s.tableName && <span className="font-medium text-ink-2"> · Table {s.tableName}</span>}
          </p>
          <p className="text-[11px] text-ink-3">{when(s.createdAt)}</p>
        </div>
        {done ? (
          <span className="rounded-full bg-success-tint px-2.5 py-0.5 text-[11px] font-bold text-success-hover">Paid</span>
        ) : (
          <span className="text-right">
            <span className="block text-[10px] font-semibold tracking-wide text-ink-3 uppercase">Left</span>
            <span className="block text-base font-extrabold text-rose-600 tabular-nums">{formatPaise(s.remainingPaise)}</span>
          </span>
        )}
      </div>
      <p className="mt-1.5 line-clamp-2 text-xs text-ink-2">{s.itemsSummary}</p>

      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-fill-strong/60">
        <div className="h-full rounded-full bg-emerald-400 transition-all duration-700" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-ink-2 tabular-nums">
        <span>
          Bill {formatPaise(s.amountPaise)} · Paid {formatPaise(s.paidPaise)}
        </span>
        <span className="flex items-center gap-3">
          {s.receipts.length > 0 && (
            <button type="button" onClick={() => setOpen((o) => !o)} className="font-semibold text-ink-2 underline">
              {open ? 'Hide' : `${s.receipts.length} payment${s.receipts.length === 1 ? '' : 's'}`}
            </button>
          )}
          {!done && (
            <button type="button" onClick={onCollect} className="rounded-full bg-accent px-3 py-1 font-bold text-white transition-all active:scale-95">
              Collect
            </button>
          )}
        </span>
      </div>

      {open && (
        <ul className="mt-2 animate-fade space-y-1 border-t border-line pt-2 text-xs">
          {s.receipts.map((r) => (
            <li key={r.id} className="flex items-center justify-between text-ink-2">
              <span>
                {when(r.createdAt)} · {r.method === 'CASH' ? 'Cash' : 'UPI'}
                {r.providerReference ? ` · ${r.providerReference}` : ''}
              </span>
              <span className="font-semibold text-emerald-600 tabular-nums">+{formatPaise(r.amountPaise)}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
