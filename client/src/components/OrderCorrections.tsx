import { ArrowLeft, Loader2, Minus, Plus, Replace, Search, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import type { MenuCategory, MenuItem, Order } from '../api/types';
import { cx } from '../lib/cx';
import { formatPaise } from '../lib/money';
import { useLiveOrders } from '../state/LiveOrders';
import { BottomSheet } from './ui/BottomSheet';
import { Button } from './ui/Button';
import { FilterMenu } from './ui/FilterMenu';
import { inputClass, labelClass } from './ui/fields';
import { PackTag } from './ui/PackTag';
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

interface EditLine {
  key: string;
  menuItemId: number;
  name: string;
  unitPricePaise: number;
  quantity: number;
  /** packed to take away (dine-in orders only) */
  packed?: boolean;
}

const MAX_LINE_QTY = 99;

/** The menu, to add a dish to an order or to swap one dish for another. */
function MenuPicker({ onPick, onBack, replacing }: { onPick: (item: MenuItem) => void; onBack: () => void; replacing: string | null }) {
  const [menu, setMenu] = useState<MenuCategory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState('ALL');
  const [query, setQuery] = useState('');

  useEffect(() => {
    api
      .getMenu()
      .then(setMenu)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the menu'));
  }, []);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const cats = (menu ?? []).filter((c) => category === 'ALL' || `c${c.id}` === category);
    return cats.flatMap((c) => c.items).filter((i) => !q || i.name.toLowerCase().includes(q));
  }, [menu, category, query]);

  return (
    <div className="space-y-3 pt-1">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="plain" icon={ArrowLeft} onClick={onBack}>
          Back
        </Button>
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-ink-2">{replacing ? `Replace “${replacing}” with…` : 'Pick a dish to add'}</p>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-slate-400" aria-hidden />
          <input
            autoFocus
            type="search"
            aria-label="Search dishes"
            placeholder="Search dishes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-9.5 w-full rounded-full border border-slate-200/60 bg-slate-100/80 pr-3 pl-9.5 text-sm text-slate-900 outline-none transition-all focus:border-slate-400 focus:bg-white"
          />
        </div>
        <FilterMenu
          label="Category"
          value={category}
          onChange={setCategory}
          options={[{ value: 'ALL', label: 'All dishes' }, ...(menu ?? []).map((c) => ({ value: `c${c.id}`, label: c.name }))]}
        />
      </div>
      {error ? (
        <p role="alert" className="rounded-2xl bg-danger-tint px-3 py-2 text-sm font-medium text-danger">
          {error}
        </p>
      ) : !menu ? (
        <p className="flex items-center justify-center gap-2 py-10 text-sm text-ink-2">
          <Loader2 size={16} className="animate-spin" aria-hidden /> Loading the menu…
        </p>
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-2">No dish matches.</p>
      ) : (
        <ul className="max-h-[46dvh] space-y-1.5 overflow-y-auto pr-0.5">
          {items.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                disabled={!i.isAvailable}
                onClick={() => onPick(i)}
                className="flex w-full items-center gap-3 rounded-2xl bg-subtle px-3.5 py-2.5 text-left transition-all enabled:active:scale-[0.98] enabled:hover:bg-surface enabled:hover:shadow-card disabled:opacity-45"
              >
                <span className={cx('inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border-[1.5px]', i.isVeg ? 'border-emerald-600' : 'border-rose-600')} aria-label={i.isVeg ? 'Vegetarian' : 'Non-vegetarian'}>
                  <span className={cx('h-1.5 w-1.5 rounded-full', i.isVeg ? 'bg-emerald-600' : 'bg-rose-600')} />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{i.name}</span>
                {i.isAvailable ? <span className="shrink-0 text-sm font-bold tabular-nums">{formatPaise(i.pricePaise)}</span> : <span className="shrink-0 text-xs font-semibold text-ink-3">Out</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Change an order the kitchen has not started: quantities, add a dish, swap a dish for another, or the note.
 * Prices always come from the menu on the server; what is shown here is only an estimate.
 */
export function EditOrderSheet({ order, onClose }: { order: Order; onClose: () => void }) {
  const toast = useToast();
  const { ingest } = useLiveOrders();
  const original = useMemo(
    () =>
      order.items
        .filter((i) => i.menuItemId !== null)
        .map<EditLine>((i) => ({ key: `o${i.id}`, menuItemId: i.menuItemId!, name: i.itemName, unitPricePaise: i.unitPricePaise, quantity: i.quantity, packed: i.packed === true })),
    [order],
  );
  const [lines, setLines] = useState<EditLine[]>(original);
  const [notes, setNotes] = useState(order.notes ?? '');
  // null = the edit screen; otherwise the menu is open (to add, or to replace the line with this key)
  const [picker, setPicker] = useState<null | { replaceKey: string | null }>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kept = lines.filter((l) => l.quantity > 0);
  const total = kept.reduce((n, l) => n + l.unitPricePaise * l.quantity, 0);
  const signature = (list: EditLine[]) =>
    list
      .filter((l) => l.quantity > 0)
      .map((l) => `${l.menuItemId}:${l.quantity}:${l.packed ? 1 : 0}`)
      .sort()
      .join(',');
  const changed = notes.trim() !== (order.notes ?? '') || signature(lines) !== signature(original);
  const setQty = (key: string, q: number) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, quantity: Math.max(0, Math.min(MAX_LINE_QTY, q)) } : l)));

  /** Adds a dish (one more if it is already on the order), or swaps it in for the line being replaced. */
  function pick(item: MenuItem) {
    setLines((ls) => {
      const existing = ls.find((l) => l.menuItemId === item.id && !l.packed);
      const target = picker?.replaceKey ? ls.find((l) => l.key === picker.replaceKey) : undefined;
      if (target) {
        if (existing && existing.key !== target.key) {
          // the new dish is already on the order: fold the swapped line's quantity into it
          return ls.filter((l) => l.key !== target.key).map((l) => (l.key === existing.key ? { ...l, quantity: Math.min(MAX_LINE_QTY, Math.max(l.quantity, 0) + Math.max(target.quantity, 1)) } : l));
        }
        // a replacement always comes in as at least one (the old dish may already have been taken down to 0)
        return ls.map((l) => (l.key === target.key ? { ...l, menuItemId: item.id, name: item.name, unitPricePaise: item.pricePaise, quantity: Math.max(l.quantity, 1) } : l));
      }
      if (existing) return ls.map((l) => (l.key === existing.key ? { ...l, quantity: Math.min(MAX_LINE_QTY, Math.max(l.quantity, 0) + 1) } : l));
      return [...ls, { key: `n${item.id}`, menuItemId: item.id, name: item.name, unitPricePaise: item.pricePaise, quantity: 1 }];
    });
    setPicker(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const { order: updated } = await api.replaceOrderItems(
        order.id,
        kept.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity, ...(l.packed ? { packed: true } : {}) })),
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

  const replacing = picker?.replaceKey ? (lines.find((l) => l.key === picker.replaceKey)?.name ?? null) : null;

  return (
    <BottomSheet title={picker ? (replacing ? 'Replace dish' : 'Add a dish') : `Edit #${order.orderNumber}`} onClose={onClose}>
      {picker ? (
        <MenuPicker onPick={pick} onBack={() => setPicker(null)} replacing={replacing} />
      ) : (
        <div className="space-y-3 pt-1">
          <ul className="space-y-2">
            {lines.map((l) => (
              <li key={l.key} className={cx('flex items-center gap-2 rounded-2xl bg-subtle p-3 transition-opacity', l.quantity === 0 && 'opacity-50')}>
                <span className="min-w-0 flex-1">
                  <span className={cx('block truncate text-sm font-semibold', l.quantity === 0 && 'line-through')}>{l.name} {l.packed && <PackTag className="ml-1 align-middle" />}</span>
                  <span className="text-xs text-ink-2 tabular-nums">{formatPaise(l.unitPricePaise)} each</span>
                </span>
                <button
                  type="button"
                  aria-label={`Replace ${l.name} with another dish`}
                  title="Replace with another dish"
                  onClick={() => setPicker({ replaceKey: l.key })}
                  className="flex h-9 shrink-0 items-center gap-1 rounded-full bg-surface px-2.5 text-xs font-semibold text-ink-2 shadow-control transition-all active:scale-90"
                >
                  <Replace size={14} aria-hidden /> <span className="max-sm:sr-only">Replace</span>
                </button>
                <span className="flex shrink-0 items-center gap-1">
                  <button type="button" aria-label={`One less ${l.name}`} onClick={() => setQty(l.key, l.quantity - 1)} className="flex h-9 w-9 items-center justify-center rounded-full bg-surface shadow-control transition-all active:scale-90">
                    <Minus size={16} />
                  </button>
                  <span className="w-6 text-center text-sm font-bold tabular-nums">{l.quantity}</span>
                  <button type="button" aria-label={`One more ${l.name}`} onClick={() => setQty(l.key, l.quantity + 1)} className="flex h-9 w-9 items-center justify-center rounded-full bg-surface shadow-control transition-all active:scale-90">
                    <Plus size={16} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setPicker({ replaceKey: null })}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-line-strong text-sm font-semibold text-accent transition-all hover:bg-accent-tint active:scale-[0.98]"
          >
            <Plus size={16} aria-hidden /> Add a dish
          </button>
          <label className="block">
            <span className={labelClass}>Note for the kitchen</span>
            <input maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} className={cx(inputClass, 'h-11')} />
          </label>
          <div className="flex items-center justify-between rounded-2xl bg-accent-tint px-4 py-3">
            <span className="text-sm font-semibold">New subtotal</span>
            <span className="text-lg font-bold tabular-nums">{formatPaise(total)}</span>
          </div>
          <p className="text-xs text-ink-2">
            {kept.length === 0
              ? 'Nothing is left on this order. Add a dish to save it, or go back and cancel the order.'
              : !changed
                ? 'Change a quantity, add or replace a dish, or edit the note, then save.'
                : 'You can change the order like this until the kitchen starts it.'}
          </p>
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
      )}
    </BottomSheet>
  );
}
