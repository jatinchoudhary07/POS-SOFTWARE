import { HandCoins, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { CreditCustomer } from '../api/types';
import { cx } from '../lib/cx';
import { formatPaise } from '../lib/money';
import { Button } from './ui/Button';
import { inputClass, labelClass } from './ui/fields';

/**
 * Payment tab for "pay later": the bill goes on the customer's account. A name and a 10-digit phone
 * number are needed so the money can be collected later. A returning customer is recognised by phone.
 */
export function CreditPaymentForm({
  total,
  defaultName = '',
  defaultPhone = '',
  busy,
  onConfirm,
}: {
  total: number;
  defaultName?: string | null;
  defaultPhone?: string | null;
  busy: boolean;
  onConfirm: (name: string, phone: string) => void;
}) {
  const [name, setName] = useState(defaultName ?? '');
  const [phone, setPhone] = useState((defaultPhone ?? '').replace(/\D/g, '').slice(0, 10));
  const [tried, setTried] = useState(false);
  const [known, setKnown] = useState<CreditCustomer | null | 'loading'>(null);

  // Recognise a returning customer as soon as the number is complete.
  useEffect(() => {
    if (phone.length !== 10) {
      setKnown(null);
      return;
    }
    let live = true;
    setKnown('loading');
    api
      .creditLookup(phone)
      .then((c) => {
        if (!live) return;
        setKnown(c);
        if (c) setName((cur) => cur.trim() || c.name);
      })
      .catch(() => live && setKnown(null));
    return () => {
      live = false;
    };
  }, [phone]);

  const nameBad = name.trim().length === 0;
  const phoneBad = phone.length !== 10;
  const owes = known && known !== 'loading' ? known.outstandingPaise : 0;

  return (
    <form
      className="animate-fade space-y-2.5 lg:space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (!nameBad && !phoneBad) onConfirm(name.trim(), phone);
      }}
    >
      <label className="block">
        <span className={labelClass}>Customer phone number</span>
        <input
          inputMode="numeric"
          autoComplete="off"
          maxLength={10}
          value={phone}
          onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
          placeholder="10-digit mobile number"
          aria-invalid={tried && phoneBad}
          className={cx(inputClass, 'h-11 tabular-nums max-lg:h-10', tried && phoneBad && 'border-rose-400')}
        />
        {tried && phoneBad && <span className="mt-1 block text-xs font-medium text-rose-500">Please enter a valid 10-digit mobile number</span>}
      </label>

      <label className="block">
        <span className={labelClass}>Customer name</span>
        <input
          autoComplete="off"
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          aria-invalid={tried && nameBad}
          className={cx(inputClass, 'h-11 max-lg:h-10', tried && nameBad && 'border-rose-400')}
        />
        {tried && nameBad && <span className="mt-1 block text-xs font-medium text-rose-500">Please enter the customer's name</span>}
      </label>

      {known === 'loading' && (
        <p className="flex items-center gap-2 text-xs text-ink-2">
          <Loader2 size={13} className="animate-spin" aria-hidden /> Checking this number…
        </p>
      )}
      {known && known !== 'loading' && (
        <p className="animate-fade rounded-control bg-fill px-3 py-2.5 text-sm text-ink-2">
          Returning customer <strong className="text-ink">{known.name}</strong>
          {owes > 0 ? (
            <>
              {' '}
              already owes <strong className="tabular-nums text-danger">{formatPaise(owes)}</strong>. After this bill:{' '}
              <strong className="tabular-nums text-ink">{formatPaise(owes + total)}</strong>.
            </>
          ) : (
            '. Nothing owed right now.'
          )}
        </p>
      )}

      <Button type="submit" size="lg" variant="primary" icon={HandCoins} loading={busy} disabled={busy} className="w-full max-lg:h-12">
        Put on credit · {formatPaise(total)}
      </Button>
    </form>
  );
}
