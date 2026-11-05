import { ChevronUp, ShoppingBag } from 'lucide-react';
import { formatPaise } from '../lib/money';
import { cartItemCount, cartSubtotal, type CartState } from '../state/cart';
import { AnimatedValue } from './ui/AnimatedValue';
import { pressable } from './ui/Button';
import { cx } from '../lib/cx';

/** Phones only: a pill bar under the menu that opens the current order full-screen. */
export function CartBar({ cart, onOpen }: { cart: CartState; onOpen: () => void }) {
  const count = cartItemCount(cart);
  if (count === 0 && !cart.tableId) return null;
  const subtotal = cartSubtotal(cart);
  return (
    <div className="shrink-0 animate-enter border-t border-slate-200/60 bg-white/85 backdrop-blur-xl px-3.5 py-2 md:hidden">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`View order: ${count} ${count === 1 ? 'item' : 'items'}, ${formatPaise(subtotal)}`}
        className={cx(
          'flex h-11 w-full items-center gap-2.5 rounded-full bg-[#ff8548] hover:bg-[#f07436] px-4 text-white shadow-md shadow-[#ff8548]/25 active:scale-[0.98] transition-all cursor-pointer',
          pressable,
        )}
      >
        {count > 0 ? (
          <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-white/25 px-2 text-xs font-bold tabular-nums">
            <AnimatedValue value={count} />
          </span>
        ) : (
          <span className="flex h-6 px-2 items-center justify-center rounded-full bg-white/25 text-xs font-bold">
            KOT
          </span>
        )}
        <span className="flex items-center gap-1.5 font-bold text-sm truncate">
          <ShoppingBag size={16} aria-hidden />
          {cart.tableNumber ? `Table ${cart.tableNumber}` : 'Cart'}
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-sm font-extrabold tabular-nums">
          {count > 0 ? formatPaise(subtotal) : 'View Bill'}
          <ChevronUp size={16} aria-hidden />
        </span>
      </button>
    </div>
  );
}
