import { Minus, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import type { Order } from '../api/types';
import { cx } from '../lib/cx';
import { formatPaise } from '../lib/money';
import { useLiveOrders } from '../state/LiveOrders';
import { BottomSheet } from './ui/BottomSheet';
import { Button } from './ui/Button';
import { inputClass, labelClass } from './ui/fields';
import { useToast } from './ui/Toast';

const REASONS = ['Customer left', 'Wrong order', 'Duplicate order', 'Item not available', 'Changed mind'];

/** Cancel an unpaid order: pick or type a reason. The server decides who may cancel what. */
export function CancelOrderSheet({ order, onClose }: { order: Order; onClose: () => void }) {
  const toast = useToast();
  const { ingest } = useLiveOrders();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { order: cancelled } = await api.cancelOrder(order.id, reason.trim());
      ingest(cancelled);
      toast({ tone: 'success', title: `#${order.orderNumber} cancelled` });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel the order');
      setBusy(false);
    }
  }

  return (
    <BottomSheet title={`Cancel #${order.orderNumber}`} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3 pt-1">
        <p className="rounded-2xl bg-subtle p-3 text-sm text-ink-2">
          The kitchen has not started this order yet. Once cancelled, it is crossed out on the kitchen screen and will not count as a sale.
        </p>
        <div>
          <span className={labelClass}>Reason</span>
          <div className="flex flex-wrap gap-2">
            {REASONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setReason(r)}
                className={cx(
                  'rounded-full px-3 py-1.5 text-xs font-semibold transition-all active:scale-95',
                  reason === r ? 'bg-accent text-white' : 'bg-fill text-ink-2 hover:text-ink',
                )}
              >
                {r}
              </button>
            ))}
          </div>
          <input aria-label="Reason" maxLength={200} placeholder="or type a reason…" value={reason} onChange={(e) => setReason(e.target.value)} className={cx(inputClass, 'mt-2 h-11')} />
        </div>
        {error && (
          <p role="alert" className="rounded-2xl bg-danger-tint px-3 py-2 text-sm font-medium text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button size="sm" variant="plain" onClick={onClose}>
            Keep order
          </Button>
          <Button size="sm" variant="danger" type="submit" icon={Trash2} loading={busy} disabled={busy || reason.trim().length < 3}>
            Cancel order
          </Button>
        </div>
      </form>
    </BottomSheet>
  );
}

/** Change quantities or remove items on an order the kitchen has not started. To add dishes, place another order. */
export function EditOrderSheet({ order, onClose }: { order: Order; onClose: () => void }) {
  const toast = useToast();
  const { ingest } = useLiveOrders();
  const [qty, setQty] = useState(() => new Map(order.items.map((i) => [i.menuItemId ?? 0, i.quantity])));
  const [notes, setNotes] = useState(order.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lines = order.items.filter((i) => i.menuItemId !== null);
  const total = lines.reduce((n, i) => n + i.unitPricePaise * (qty.get(i.menuItemId ?? 0) ?? 0), 0);
  const kept = lines.filter((i) => (qty.get(i.menuItemId ?? 0) ?? 0) > 0);
  const changed = notes.trim() !== (order.notes ?? '') || lines.some((i) => qty.get(i.menuItemId ?? 0) !== i.quantity);
  const set = (id: number, q: number) => setQty((m) => new Map(m).set(id, Math.max(0, Math.min(99, q))));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const { order: updated } = await api.replaceOrderItems(
        order.id,
        kept.map((i) => ({ menuItemId: i.menuItemId!, quantity: qty.get(i.menuItemId!)! })),
        notes.trim(),
      );
      ingest(updated);
      toast({ tone: 'success', title: `#${order.orderNumber} updated` });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the order');
      setBusy(false);
    }
  }

  return (
    <BottomSheet title={`Edit #${order.orderNumber}`} onClose={onClose}>
      <div className="space-y-3 pt-1">
        <ul className="space-y-2">
          {lines.map((i) => {
            const q = qty.get(i.menuItemId!) ?? 0;
            return (
              <li key={i.id} className={cx('flex items-center gap-3 rounded-2xl bg-subtle p-3 transition-opacity', q === 0 && 'opacity-50')}>
                <span className="min-w-0 flex-1">
                  <span className={cx('block truncate text-sm font-semibold', q === 0 && 'line-through')}>{i.itemName}</span>
                  <span className="text-xs text-ink-2 tabular-nums">{formatPaise(i.unitPricePaise)} each</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <button type="button" aria-label={`One less ${i.itemName}`} onClick={() => set(i.menuItemId!, q - 1)} className="flex h-9 w-9 items-center justify-center rounded-full bg-surface shadow-control transition-all active:scale-90">
                    <Minus size={16} />
                  </button>
                  <span className="w-7 text-center text-sm font-bold tabular-nums">{q}</span>
                  <button type="button" aria-label={`One more ${i.itemName}`} onClick={() => set(i.menuItemId!, q + 1)} className="flex h-9 w-9 items-center justify-center rounded-full bg-surface shadow-control transition-all active:scale-90">
                    <Plus size={16} />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
        <label className="block">
          <span className={labelClass}>Note for the kitchen</span>
          <input maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} className={cx(inputClass, 'h-11')} />
        </label>
        <div className="flex items-center justify-between rounded-2xl bg-accent-tint px-4 py-3">
          <span className="text-sm font-semibold">New subtotal</span>
          <span className="text-lg font-bold tabular-nums">{formatPaise(total)}</span>
        </div>
        <p className="text-xs text-ink-2">To add more dishes, place another order for the same table. Removing every item? Cancel the order instead.</p>
        {error && (
          <p role="alert" className="rounded-2xl bg-danger-tint px-3 py-2 text-sm font-medium text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button size="sm" variant="plain" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" loading={busy} disabled={busy || kept.length === 0 || !changed} onClick={() => void save()}>
            Save changes
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}
