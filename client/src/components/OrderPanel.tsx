import {
  ArrowLeft,
  CakeSlice,
  ChevronDown,
  CircleAlert,
  Clock,
  Coffee,
  CookingPot,
  CreditCard,
  CupSoda,
  Hamburger,
  Loader2,
  Minus,
  Package,
  Pizza,
  Plus,
  Printer,
  Salad,
  Sandwich,
  Trash2,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type Dispatch } from 'react';
import { api } from '../api/client';
import type { TableDetailDTO, TableTileDTO } from '../api/types';
import { cx } from '../lib/cx';
import { formatPaise } from '../lib/money';
import { formatClock } from '../lib/time';
import { useLiveOrders } from '../state/LiveOrders';
import {
  cartItemCount,
  cartProblem,
  phoneProblem,
  cartSubtotal,
  lineTotal,
  MAX_CUSTOMER_NAME,
  MAX_CUSTOMER_PHONE,
  MAX_NOTES,
  MAX_QTY,
  MAX_TABLE,
  type CartAction,
  type CartLine,
  type CartState,
} from '../state/cart';
import { useReceiptPrinter } from './ReceiptPrinter';
import { Button, IconButton } from './ui/Button';
import { PackTag } from './ui/PackTag';
import { StatusBadge } from './ui/StatusBadge';
import { useToast } from './ui/Toast';

// Matching icons for line items
const CART_ICONS: [RegExp, LucideIcon][] = [
  [/pizza/i, Pizza],
  [/burger/i, Hamburger],
  [/sandwich|roll|wrap/i, Sandwich],
  [/coffee|tea|chai|latte|cappuccino/i, Coffee],
  [/salad/i, Salad],
  [/curry|pasta/i, CookingPot],
  [/drink|beverage|juice|shake/i, CupSoda],
  [/dessert|sweet|cake/i, CakeSlice],
];
const cartIconFor = (name: string): LucideIcon =>
  CART_ICONS.find(([re]) => re.test(name))?.[1] ?? UtensilsCrossed;

interface Props {
  cart: CartState;
  dispatch: Dispatch<CartAction>;
  tables: string[];
  diningTables?: TableTileDTO[];
  submitting: boolean;
  onSubmit: () => void;
  variant?: 'sidebar' | 'sheet';
  onClose?: () => void;
  onOpenTableCheckout?: (tableId: number) => void;
  onBackToTables?: () => void;
}

/** Last known running orders per table (kept while the cart is closed and reopened). */
const detailCache = new Map<number, TableDetailDTO>();

const fieldClass =
  'w-full rounded-full bg-slate-50 text-[14px] border border-slate-200/80 px-4 py-2 font-medium text-slate-800 shadow-2xs focus:border-[#ff8548] focus:bg-white focus:outline-none transition-all';

function LineRow({ line, dispatch }: { line: CartLine; dispatch: Dispatch<CartAction> }) {
  const ItemIcon = cartIconFor(line.name);

  return (
    <li className={cx('animate-enter px-4 py-3 border-b border-slate-100 last:border-b-0', !line.available && 'bg-rose-50')}>
      <div className="flex items-center gap-3">
        {/* Squircle Food Thumbnail (Purr'Coffee style) */}
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px] bg-[#fff6ee] text-[#ff8548] border border-[#ffeedd] shadow-2xs">
          <ItemIcon size={22} strokeWidth={1.8} aria-hidden />
        </div>

        {/* Name & Pricing */}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-1">
            <h4 className="truncate text-sm font-bold text-slate-900 leading-tight">
              {line.name}
            </h4>
            <span className="shrink-0 text-sm font-bold text-slate-900 tabular-nums">
              {formatPaise(lineTotal(line))}
            </span>
          </div>

          <div className="mt-0.5 flex items-center justify-between text-xs text-slate-400">
            <span>{formatPaise(line.unitPricePaise)} each</span>

            {/* Stepper Pill in Cart */}
            <div className="inline-flex items-center rounded-full bg-slate-100/90 p-0.5 border border-slate-200/60 shadow-2xs">
              <button
                type="button"
                onClick={() => dispatch({ type: 'decrement', menuItemId: line.menuItemId })}
                className="flex h-6 w-6 items-center justify-center rounded-full bg-white text-slate-700 shadow-2xs hover:bg-slate-200 active:scale-95 transition-all cursor-pointer"
                aria-label={`Decrease ${line.name}`}
              >
                <Minus size={11} strokeWidth={2.5} />
              </button>
              <span className="w-6 text-center text-xs font-bold text-slate-900 tabular-nums">
                {line.quantity}
              </span>
              <button
                type="button"
                disabled={line.quantity >= MAX_QTY || !line.available}
                onClick={() => dispatch({ type: 'increment', menuItemId: line.menuItemId })}
                className="flex h-6 w-6 items-center justify-center rounded-full bg-white text-slate-700 shadow-2xs hover:bg-slate-200 active:scale-95 transition-all cursor-pointer disabled:opacity-40"
                aria-label={`Increase ${line.name}`}
              >
                <Plus size={11} strokeWidth={2.5} />
              </button>
            </div>
          </div>

          {!line.available && (
            <div className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-rose-600">
              <CircleAlert size={12} aria-hidden /> Unavailable — remove this item
            </div>
          )}
        </div>

        {/* Delete button */}
        <button
          type="button"
          onClick={() => dispatch({ type: 'remove', menuItemId: line.menuItemId })}
          className="text-slate-300 hover:text-rose-500 transition-colors p-1"
          title={`Remove ${line.name}`}
        >
          <Trash2 size={15} />
        </button>
      </div>
    </li>
  );
}

export function OrderPanel({
  cart,
  dispatch,
  tables,
  diningTables,
  submitting,
  onSubmit,
  variant = 'sidebar',
  onClose,
  onOpenTableCheckout,
  onBackToTables,
}: Props) {
  const toast = useToast();
  const { subscribe } = useLiveOrders();
  const { print: printReceipt, printing } = useReceiptPrinter();
  const watchedTableId = cart.orderType === 'DINE_IN' ? (cart.tableId ?? null) : null;
  // The table's running orders. The last answer for each table is remembered, so reopening a table shows its bill at
  // once instead of an empty cart while it loads, and a failed or late refresh never wipes what is already on screen.
  const [tableDetail, setTableDetail] = useState<TableDetailDTO | null>(watchedTableId ? (detailCache.get(watchedTableId) ?? null) : null);
  const detailTicket = useRef(0);

  const loadDetail = useCallback(async (tableId: number) => {
    const ticket = ++detailTicket.current;
    try {
      const d = await api.getTableDetails(tableId);
      if (ticket !== detailTicket.current) return; // a newer request (or another table) has taken over
      detailCache.set(tableId, d);
      setTableDetail(d);
    } catch {
      // keep showing the last known orders; the next live update will try again
    }
  }, []);

  useEffect(() => {
    if (watchedTableId) {
      setTableDetail(detailCache.get(watchedTableId) ?? null);
      void loadDetail(watchedTableId);
    } else {
      detailTicket.current++;
      setTableDetail(null);
    }
  }, [watchedTableId, loadDetail]);

  useEffect(() => {
    if (!watchedTableId) return;
    return subscribe(() => void loadDetail(watchedTableId));
  }, [subscribe, watchedTableId, loadDetail]);

  const newDraftTotal = cartSubtotal(cart);
  const count = cartItemCount(cart);
  const problem = cartProblem(cart);
  const canSubmit = !problem && !submitting;
  // The phone number is only checked when the order is placed, so nothing nags while it is being typed.
  const [phoneTried, setPhoneTried] = useState(false);
  const phoneBad = phoneProblem(cart) !== null;

  const existingOrders = tableDetail?.orders ?? [];
  const existingSubtotal = existingOrders.reduce((sum, o) => sum + o.subtotalPaise, 0);
  const runningGrandTotal = existingSubtotal + newDraftTotal;

  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    if (!confirmClear) return;
    const t = setTimeout(() => setConfirmClear(false), 3000);
    return () => clearTimeout(t);
  }, [confirmClear]);
  useEffect(() => setConfirmClear(false), [cart.requestId]);

  return (
    <aside
      aria-label="Current order"
      className={cx(
        'flex flex-col h-full min-h-0 bg-white border-l border-slate-200/80 shadow-[0_0_30px_rgba(30,41,59,0.03)]',
        variant === 'sheet' ? 'w-full flex-1' : 'w-[350px] shrink-0 xl:w-[390px]',
      )}
    >
      {/* Top Header: Purr'Coffee Style (Cart + Order #) */}
      <div className={cx('px-5 pb-3', variant === 'sheet' ? 'pt-3' : 'pt-5')}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {onClose ? (
              <IconButton icon={ChevronDown} variant="secondary" aria-label="Back to menu" title="Back to menu" onClick={onClose} className="-ml-1" />
            ) : onBackToTables ? (
              <button
                type="button"
                onClick={onBackToTables}
                className="inline-flex items-center gap-1 text-xs font-bold text-[#ff8548] hover:underline cursor-pointer mr-1"
              >
                <ArrowLeft size={14} /> Tables
              </button>
            ) : null}
            <h2 className="text-2xl font-extrabold tracking-tight text-slate-900">
              Cart
            </h2>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-slate-400">
              {cart.orderType === 'DINE_IN' && cart.tableNumber
                ? `Table ${cart.tableNumber}`
                : `Order #${cart.requestId.substring(0, 6)}`}
            </span>
            {count > 0 && (
              <span className="rounded-full bg-[#ffede3] text-[#ff8548] font-bold text-xs px-2 py-0.5">
                {count}
              </span>
            )}
          </div>
        </div>

        {/* Order Mode Badge: Fixed Mode (no toggle between dine in and pickup) */}
        {cart.orderType === 'TAKEAWAY' ? (
          <div className="mt-3.5 flex items-center justify-between rounded-full bg-[#ffede3] px-3.5 py-2 text-xs font-bold text-[#ff8548] border border-[#ff8548]/25 shadow-2xs">
            <div className="flex items-center gap-2">
              <Package size={14} />
              <span>Pickup (Packing)</span>
            </div>
            <span className="text-[11px] font-semibold text-[#ff8548]/80">Takeaway</span>
          </div>
        ) : (
          <div className="mt-3.5 flex items-center justify-between rounded-full bg-[#ffede3] px-3.5 py-2 text-xs font-bold text-[#ff8548] border border-[#ff8548]/25 shadow-2xs">
            <div className="flex items-center gap-2">
              <UtensilsCrossed size={14} />
              <span>Dine In</span>
            </div>
            {cart.tableNumber ? (
              <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-bold text-[#ff8548] shadow-2xs border border-[#ff8548]/20">
                Table {cart.tableNumber}
              </span>
            ) : (
              <span className="text-[11px] font-semibold text-[#ff8548]/80">Table Service</span>
            )}
          </div>
        )}

        {/* Table Selector (when Dine-in) */}
        {cart.orderType === 'DINE_IN' && (
          <div className="mt-2.5">
            {diningTables && diningTables.length > 0 ? (
              <select
                value={cart.tableId ? String(cart.tableId) : cart.tableNumber}
                onChange={(e) => {
                  const val = e.target.value;
                  if (!val) {
                    dispatch({ type: 'setTable', tableNumber: '', tableId: null });
                    return;
                  }
                  const matched = diningTables.find((dt) => String(dt.id) === val || dt.name === val);
                  if (matched) {
                    dispatch({ type: 'setTable', tableNumber: matched.name, tableId: matched.id });
                  } else {
                    dispatch({ type: 'setTable', tableNumber: val, tableId: null });
                  }
                }}
                className={fieldClass}
              >
                <option value="">Select table for dining...</option>
                {diningTables.map((t) => (
                  <option key={t.id} value={String(t.id)}>
                    {t.name}{t.capacity ? ` (${t.capacity} seats)` : ''} — {t.status === 'OCCUPIED' ? `Occupied (${t.activeOrderCount} KOT)` : 'Available'}
                  </option>
                ))}
              </select>
            ) : tables.length > 0 ? (
              <select
                value={cart.tableNumber}
                onChange={(e) => dispatch({ type: 'setTable', tableNumber: e.target.value })}
                className={fieldClass}
              >
                <option value="">Choose table...</option>
                {tables.map((t) => (
                  <option key={t} value={t}>Table {t}</option>
                ))}
              </select>
            ) : (
              <input
                value={cart.tableNumber}
                maxLength={MAX_TABLE}
                inputMode="numeric"
                placeholder="Table number (e.g. 1, 2)..."
                onChange={(e) => dispatch({ type: 'setTable', tableNumber: e.target.value })}
                className={fieldClass}
              />
            )}
          </div>
        )}
      </div>

      {/* Cart Items List */}
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-slate-100">
        {cart.orderType === 'DINE_IN' && existingOrders.length > 0 ? (
          <div className="p-4 space-y-3">
            {/* Existing KOTs */}
            <div className="flex items-center justify-between pb-1">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Running KOTs ({existingOrders.length})
              </span>
              <span className="text-xs font-bold tabular-nums text-slate-800">
                {formatPaise(existingSubtotal)}
              </span>
            </div>

            {existingOrders.map((kot, idx) => (
              <div key={kot.id} className="rounded-[16px] border border-slate-200/80 bg-slate-50/70 p-3 text-xs shadow-2xs">
                <div className="flex items-center justify-between border-b border-slate-200/60 pb-2 mb-2">
                  <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-bold text-slate-700 shadow-2xs">
                    KOT #{idx + 1} &bull; #{kot.orderNumber}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-slate-400 font-medium flex items-center gap-1">
                      <Clock size={11} /> {formatClock(kot.createdAt)}
                    </span>
                    <StatusBadge status={kot.status} />
                  </div>
                </div>

                <ul className="space-y-1">
                  {kot.items.map((i) => (
                    <li key={i.id} className="flex justify-between items-baseline text-slate-700">
                      <span className="truncate pr-2">
                        <strong className="font-bold mr-1 text-slate-900">{i.quantity}&times;</strong> {i.itemName}
                        {i.packed && <PackTag className="ml-1.5 align-middle" />}
                      </span>
                      <span className="font-semibold text-slate-900 shrink-0">
                        {formatPaise(i.lineTotalPaise)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            {/* New Draft Items */}
            {cart.lines.length > 0 ? (
              <div className="rounded-[18px] border-2 border-dashed border-[#ff8548]/50 bg-[#fff9f5] p-3 shadow-2xs">
                <div className="flex items-center justify-between border-b border-[#ff8548]/20 pb-2 mb-2">
                  <span className="font-bold text-xs uppercase tracking-wide text-[#ff8548]">
                    New Items (KOT #{existingOrders.length + 1})
                  </span>
                  <span className="text-[11px] font-bold text-[#ff8548]">{cart.packed ? 'To pack' : 'Ready to send'}</span>
                </div>
                <ul className="divide-y divide-slate-100">
                  {cart.lines.map((l) => (
                    <LineRow key={l.menuItemId} line={l} dispatch={dispatch} />
                  ))}
                </ul>
              </div>
            ) : (
              <div className="rounded-[14px] border border-dashed border-slate-200 p-3 text-center text-xs text-slate-400 bg-slate-50/50">
                + Select items from the menu to add to this table
              </div>
            )}
          </div>
        ) : cart.lines.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center text-slate-400">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
              <UtensilsCrossed size={22} aria-hidden />
            </span>
            <div>
              <p className="font-bold text-slate-700 text-sm">Your cart is empty</p>
              <p className="mt-1 text-xs text-slate-400">Tap items on the left to add them to this order.</p>
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {cart.lines.map((l) => (
              <LineRow key={l.menuItemId} line={l} dispatch={dispatch} />
            ))}
          </ul>
        )}
      </div>

      {/* Bottom Sticky Action Area: Purr'Coffee Financials + Place Order */}
      <div
        className={cx(
          'space-y-3.5 border-t border-slate-100 bg-[#faf8f5]/80 p-5',
          variant === 'sheet' ? 'pb-[calc(1.25rem+env(safe-area-inset-bottom))]' : '',
        )}
      >
        {/* Dine-in guest wants these dishes packed: same table, same bill, the kitchen sees "PACK" on each */}
        {cart.orderType === 'DINE_IN' && cart.lines.length > 0 && (
          <button
            type="button"
            role="switch"
            aria-checked={cart.packed}
            onClick={() => dispatch({ type: 'setPacked', packed: !cart.packed })}
            className={cx(
              'flex w-full items-center gap-2.5 rounded-2xl border px-3 py-1.5 text-left transition-all active:scale-[0.99]',
              cart.packed ? 'border-[#ff8548] bg-[#ffede3]' : 'border-slate-200/80 bg-white',
            )}
          >
            <span className={cx('flex h-7 w-7 shrink-0 items-center justify-center rounded-full', cart.packed ? 'bg-[#ff8548] text-white' : 'bg-slate-100 text-slate-400')}>
              <Package size={16} aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-bold leading-tight text-slate-900">Pack these items</span>
              <span className="block truncate text-[11px] leading-tight text-slate-500">
                {cart.packed ? 'Kitchen packs them. Same bill.' : 'Guest takes these away'}
              </span>
            </span>
            <span className={cx('relative h-6 w-10 shrink-0 rounded-full transition-colors', cart.packed ? 'bg-[#ff8548]' : 'bg-slate-300')} aria-hidden>
              <span className={cx('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', cart.packed ? 'left-[18px]' : 'left-0.5')} />
            </span>
          </button>
        )}

        {/* Optional customer details: small labels above the fields keep the fields themselves clean */}
        <div className="grid grid-cols-2 gap-2">
          <label className="block min-w-0">
            <span className="mb-1 block pl-1.5 text-[10px] font-semibold tracking-wide text-slate-400">Customer name · optional</span>
            <input
              value={cart.customerName}
              maxLength={MAX_CUSTOMER_NAME}
              autoComplete="off"
              placeholder="Name"
              onChange={(e) => dispatch({ type: 'setCustomer', name: e.target.value })}
              className="h-9 min-w-0 w-full rounded-full bg-white px-3.5 text-xs text-slate-800 placeholder:text-slate-300 border border-slate-200/80 outline-none focus:border-[#ff8548]"
            />
          </label>
          <label className="block min-w-0">
            <span className="mb-1 block pl-1.5 text-[10px] font-semibold tracking-wide text-slate-400">Phone · optional</span>
            <input
              value={cart.customerPhone}
              maxLength={MAX_CUSTOMER_PHONE}
              inputMode="numeric"
              autoComplete="off"
              placeholder="10-digit number"
              aria-invalid={phoneTried && phoneBad}
              onChange={(e) => dispatch({ type: 'setCustomer', phone: e.target.value })}
              className={cx(
                'h-9 min-w-0 w-full rounded-full bg-white px-3.5 text-xs text-slate-800 placeholder:text-slate-300 border outline-none',
                phoneTried && phoneBad ? 'border-rose-400 focus:border-rose-500' : 'border-slate-200/80 focus:border-[#ff8548]',
              )}
            />
            {phoneTried && phoneBad && (
              <span role="alert" className="mt-1 block pl-1.5 text-[10px] font-medium leading-tight text-rose-500">
                Please enter a valid 10-digit mobile number
              </span>
            )}
          </label>
        </div>

        {/* Notes Input */}
        <label className="block">
          <span className="mb-1 block pl-1.5 text-[10px] font-semibold tracking-wide text-slate-400">Notes for the kitchen</span>
          <input
            value={cart.notes}
            maxLength={MAX_NOTES}
            placeholder="Special instructions"
            onChange={(e) => dispatch({ type: 'setNotes', notes: e.target.value })}
            className="h-9 min-w-0 w-full rounded-full bg-white px-3.5 text-xs text-slate-800 placeholder:text-slate-300 border border-slate-200/80 outline-none focus:border-[#ff8548]"
          />
        </label>

        {/* Purr'Coffee Financial Summary */}
        <div className="space-y-1.5 text-xs text-slate-500">
          <div className="flex justify-between">
            <span>{existingOrders.length > 0 ? 'Items (all orders)' : 'Items'}</span>
            <span className="font-semibold text-slate-800 tabular-nums">
              {formatPaise(runningGrandTotal)}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Discounts</span>
            <span className="font-semibold text-emerald-600 tabular-nums">-₹0.00</span>
          </div>
          <div className="flex items-baseline justify-between border-t border-slate-200/80 pt-2 text-slate-900">
            <span className="text-sm font-bold">Total</span>
            <span className="text-xl font-extrabold text-slate-900 tabular-nums">
              {formatPaise(runningGrandTotal > 0 && existingOrders.length > 0 ? runningGrandTotal : newDraftTotal)}
            </span>
          </div>
        </div>

        {/* Big Purr'Coffee CTA: Place an Order */}
        <div className="space-y-2 pt-1">
          {cart.lines.length > 0 && (
            <div className="flex gap-2">
              {confirmClear ? (
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'reset' })}
                  className="px-3.5 py-3 rounded-full bg-rose-100 hover:bg-rose-200 text-rose-700 text-xs font-bold transition-all"
                >
                  Clear?
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmClear(true)}
                  className="px-3.5 py-3 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-semibold transition-all"
                  title="Clear Cart"
                >
                  <Trash2 size={15} />
                </button>
              )}

              <button
                type="button"
                disabled={!canSubmit}
                onClick={() => {
                  setPhoneTried(phoneBad);
                  if (!phoneBad) onSubmit();
                }}
                className="flex-1 py-3.5 rounded-full bg-[#ff8548] hover:bg-[#f07436] text-white font-extrabold text-sm shadow-[0_6px_20px_rgba(255,133,72,0.35)] active:scale-[0.98] transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                {submitting ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    <span>Placing order...</span>
                  </>
                ) : (
                  <>
                    <span>Place an order</span>
                    <span className="opacity-80 tabular-nums font-semibold">&bull; {formatPaise(newDraftTotal)}</span>
                  </>
                )}
              </button>
            </div>
          )}

          {/* Settle Bill for occupied tables */}
          {cart.tableId && existingOrders.length > 0 && onOpenTableCheckout && (
            <div className="flex gap-2 pt-1">
              <Button
                size="md"
                variant="secondary"
                icon={Printer}
                title="Print Bill Receipt"
                disabled={printing}
                onClick={async () => {
                  try {
                    await printReceipt(cart.tableId!);
                  } catch {
                    toast({ tone: 'error', title: 'Could not print table receipt' });
                  }
                }}
                className="shrink-0 px-3.5 rounded-full"
              >
                Print
              </Button>
              <Button
                size="md"
                variant={cart.lines.length === 0 ? 'primary' : 'secondary'}
                icon={CreditCard}
                onClick={() => onOpenTableCheckout(cart.tableId!)}
                className="flex-1 font-bold text-xs sm:text-sm rounded-full"
              >
                Settle Bill &bull; {formatPaise(tableDetail?.runningTotalPaise ?? existingSubtotal)}
              </Button>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
