import {
  BellRing,
  CheckCheck,
  CircleAlert,
  CircleCheck,
  ClipboardList,
  Clock,
  CreditCard,
  Flame,
  LayoutGrid,
  Loader2,
  Package,
  Pencil,
  Printer,
  Receipt,
  RotateCw,
  Search,
  Send,
  StickyNote,
  User,
  UtensilsCrossed,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { isFullOrder, type LiveOrder, type Order, type OrderStatus } from '../api/types';
import { cx } from '../lib/cx';
import { formatPaise } from '../lib/money';
import { formatClock, formatElapsed } from '../lib/time';
import { useNow } from '../lib/useNow';
import { useLiveOrders } from '../state/LiveOrders';
import { recentOrders } from '../state/orders';
import { useStatusAction } from '../state/useStatusAction';
import { CancelOrderSheet, EditOrderSheet } from './OrderCorrections';
import { useReceiptPrinter } from './ReceiptPrinter';
import { Button, IconButton } from './ui/Button';
import { ConnectionBanner } from './ui/ConnectionBanner';
import { FilterMenu } from './ui/FilterMenu';
import { PaymentBadge } from './ui/PaymentBadge';
import { useToast } from './ui/Toast';

const FILTERS = [
  { key: 'READY', label: 'Ready', icon: BellRing, tone: 'text-emerald-600' },
  { key: 'PREPARING', label: 'Preparing', icon: Flame, tone: 'text-amber-500' },
  { key: 'NEW', label: 'Sent to kitchen', icon: Send, tone: 'text-blue-600' },
  { key: 'COMPLETED', label: 'Served', icon: CheckCheck, tone: 'text-slate-600' },
  { key: 'ALL', label: 'All orders', icon: LayoutGrid, tone: 'text-slate-500' },
] as const;

type FilterKey = (typeof FILTERS)[number]['key'];

const isSettled = (o: Order) => o.paymentStatus === 'PAID' || o.paymentStatus === 'REFUNDED';

function OrderCard({
  order,
  highlighted,
  pending,
  now,
  onServe,
  onCheckout,
  onEdit,
  onCancel,
}: {
  order: Order;
  highlighted: boolean;
  pending: boolean;
  now: number;
  onServe: () => void;
  onCheckout: () => void;
  onEdit?: () => void;
  onCancel?: () => void;
}) {
  const toast = useToast();
  const { print, printing } = useReceiptPrinter();
  const [printingThis, setPrintingThis] = useState(false);
  const dineIn = order.orderType === 'DINE_IN';
  const isReady = order.status === 'READY';
  const isPreparing = order.status === 'PREPARING';
  const isNew = order.status === 'NEW';
  const isPaid = order.paymentStatus === 'PAID';

  const handlePrint = async () => {
    setPrintingThis(true);
    try {
      await print(order.id);
    } catch {
      toast({ tone: 'error', title: 'Could not print receipt' });
    } finally {
      setPrintingThis(false);
    }
  };

  return (
    <article
      aria-label={`Order ${order.orderNumber}`}
      className={cx(
        'group relative flex flex-col rounded-[22px] backdrop-blur-xl border p-4.5 sm:p-5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg',
        isReady
          ? 'border-emerald-300/80 bg-emerald-50/50 shadow-[0_4px_20px_rgba(16,185,129,0.06)]'
          : isPreparing
            ? 'border-amber-300/80 bg-amber-50/50 shadow-[0_4px_20px_rgba(245,158,11,0.06)]'
            : isNew
              ? 'border-blue-300/80 bg-blue-50/40 shadow-[0_4px_20px_rgba(59,130,246,0.06)]'
              : 'border-white/80 bg-white/80 shadow-[0_4px_20px_-2px_rgba(15,23,42,0.04)]',
        highlighted && 'ring-2 ring-accent ring-offset-2',
      )}
    >
      {/* Top Header Row */}
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-lg font-black tracking-tight text-ink tabular-nums">
              #{order.orderNumber}
            </span>
            {dineIn ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-fill px-2.5 py-0.5 text-xs font-semibold text-ink">
                <UtensilsCrossed size={12} className="text-accent" aria-hidden />
                <span>{order.tableNumber ? `Table ${order.tableNumber}` : 'Dine-in'}</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-accent-tint px-2.5 py-0.5 text-xs font-bold text-accent">
                <Package size={12} aria-hidden />
                <span>Packing</span>
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-ink-2 tabular-nums">
            <Clock size={12} className="text-ink-3 shrink-0" aria-hidden />
            <span className="font-medium text-ink-1">{formatElapsed(order.createdAt, now)}</span>
            <span className="text-ink-3">&bull;</span>
            <span>{formatClock(order.createdAt)}</span>
          </div>
        </div>

        {/* Badges Cluster */}
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          {/* Kitchen status badge */}
          {isReady ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-950 px-2.5 py-1 text-xs font-bold border border-emerald-300 shadow-2xs">
              <BellRing size={12} className="animate-bounce" aria-hidden /> Ready
            </span>
          ) : isPreparing ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-950 px-2.5 py-1 text-xs font-bold border border-amber-300">
              <Flame size={12} aria-hidden /> Preparing
            </span>
          ) : isNew ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 text-blue-900 px-2.5 py-1 text-xs font-semibold border border-blue-300">
              <Send size={12} aria-hidden /> Sent
            </span>
          ) : order.status === 'COMPLETED' ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-fill text-ink-2 px-2.5 py-1 text-xs font-medium border border-line">
              <CheckCheck size={12} aria-hidden /> {dineIn ? 'Served' : 'Completed'}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-danger-tint text-danger px-2.5 py-1 text-xs font-semibold">
              Cancelled
            </span>
          )}

          {/* Payment status badge */}
          {isPaid ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200/90 px-2 py-0.5 text-[11px] font-semibold">
              <CircleCheck size={12} className="text-emerald-600" aria-hidden />
              <span>{order.paymentMethod === 'CREDIT' ? 'On credit' : `Paid${order.paymentMethod === 'UPI_MANUAL' ? ' · UPI' : order.paymentMethod === 'CASH' ? ' · Cash' : ''}`}</span>
            </span>
          ) : order.paymentStatus === 'UNPAID' ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 text-amber-900 border border-amber-200/90 px-2 py-0.5 text-[11px] font-semibold">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" aria-hidden />
              <span>Unpaid</span>
            </span>
          ) : (
            <PaymentBadge status={order.paymentStatus} method={order.paymentMethod} />
          )}
        </div>
      </div>

      {(order.customerName || order.customerPhone) && (
        <p className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-2">
          <span className="inline-flex items-center gap-1 font-semibold text-ink">
            <User size={12} aria-hidden /> {order.customerName || 'Customer'}
          </span>
          {order.customerPhone && (
            <a href={`tel:${order.customerPhone.replace(/[^0-9+]/g, '')}`} className="font-medium tabular-nums text-accent-hover hover:underline">
              {order.customerPhone}
            </a>
          )}
        </p>
      )}

      {/* Items Breakdown */}
      <ul className="mt-3.5 space-y-1.5 border-t border-line/60 pt-3 text-[14px]">
        {order.items.map((i) => (
          <li key={i.id} className="flex items-baseline justify-between gap-2">
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="flex h-5 w-6 shrink-0 items-center justify-center rounded bg-fill text-xs font-bold tabular-nums text-ink">
                {i.quantity}&times;
              </span>
              <span className="truncate font-medium text-ink">{i.itemName}</span>
            </div>
            <span className="shrink-0 tabular-nums font-semibold text-ink-2">{formatPaise(i.lineTotalPaise)}</span>
          </li>
        ))}
      </ul>

      {/* Special Notes (if any) */}
      {order.notes && (
        <div className="mt-3 flex items-start gap-2 rounded-control bg-warning-tint/80 border border-warning/20 px-3 py-2 text-xs font-medium text-warning">
          <StickyNote size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span className="break-words">{order.notes}</span>
        </div>
      )}

      {/* Bottom Summary & Actions */}
      <div className="mt-auto pt-3.5">
        <div className="flex items-baseline justify-between border-t border-line/70 pt-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-ink-3">
            {order.itemCount} {order.itemCount === 1 ? 'item' : 'items'}
          </span>
          <div className="text-right">
            <span className="block text-xl font-black tabular-nums tracking-tight text-ink">
              {formatPaise(order.billTotalPaise ?? order.subtotalPaise)}
            </span>
            <span className="block text-[11px] font-medium text-ink-3">
              {isSettled(order) ? 'Total Paid' : order.billTotalPaise ? 'Total Due' : 'Subtotal (before tax)'}
            </span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="mt-3 flex items-center gap-2">
          {order.status === 'CANCELLED' ? (
            <p className="w-full rounded-control bg-fill px-3 py-2 text-center text-xs font-medium text-ink-2">
              Cancelled{order.cancelReason ? ` · ${order.cancelReason}` : ''}
            </p>
          ) : isReady && !dineIn && !isSettled(order) ? (
            // A ready packing order that is not paid yet: only Checkout here. "Hand over" appears on the next
            // screen once it is paid (a Hand Over button here made the card vanish before the customer had paid).
            <Button variant="primary" icon={CreditCard} onClick={onCheckout} className="w-full font-bold shadow-xs py-2 text-sm">
              Checkout &bull; {formatPaise(order.billTotalPaise ?? order.subtotalPaise)}
            </Button>
          ) : isReady ? (
            <>
              <Button
                variant="success"
                icon={CheckCheck}
                loading={pending}
                disabled={pending}
                onClick={onServe}
                className="flex-1 font-bold shadow-xs py-2 text-sm"
              >
                {dineIn ? 'Mark Served' : 'Hand Over'}
              </Button>
              {isSettled(order) ? (
                <Button
                  variant="secondary"
                  icon={Printer}
                  loading={printing && printingThis}
                  disabled={printing}
                  onClick={handlePrint}
                  className="px-3"
                  title="Print Receipt"
                >
                  Receipt
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  icon={CreditCard}
                  onClick={onCheckout}
                  className="px-3 font-semibold"
                >
                  Checkout
                </Button>
              )}
            </>
          ) : isSettled(order) ? (
            <div className="flex w-full gap-2">
              <Button
                variant="secondary"
                icon={Printer}
                loading={printing && printingThis}
                disabled={printing}
                onClick={handlePrint}
                className="flex-1 font-semibold"
              >
                Print Receipt
              </Button>
              <Button
                variant="plain"
                icon={Receipt}
                onClick={onCheckout}
                className="px-3 text-xs text-ink-2"
                title="View Bill Details"
              >
                Details
              </Button>
            </div>
          ) : (
            <Button
              variant="primary"
              icon={CreditCard}
              onClick={onCheckout}
              className="w-full font-bold shadow-xs py-2 text-sm"
            >
              Checkout &bull; {formatPaise(order.billTotalPaise ?? order.subtotalPaise)}
            </Button>
          )}
        </div>
        {(onEdit || onCancel) && (
          <div className="mt-2 flex items-center justify-end gap-1 text-xs">
            {onEdit && (
              <button type="button" onClick={onEdit} className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 font-semibold text-ink-2 transition-colors hover:bg-fill hover:text-ink">
                <Pencil size={13} aria-hidden /> Edit items
              </button>
            )}
            {onCancel && (
              <button type="button" onClick={onCancel} className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 font-semibold text-danger transition-colors hover:bg-danger-tint">
                <X size={13} aria-hidden /> Cancel order
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function isCreatedToday(isoString: string): boolean {
  if (!isoString) return false;
  const d = new Date(isoString);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

export function OrdersView({ highlightId, onCheckout }: { highlightId: number | null; onCheckout: (orderId: number) => void }) {
  const { orders, loaded, syncError, resync } = useLiveOrders();
  const { run, isPending } = useStatusAction();
  const [editing, setEditing] = useState<Order | null>(null);
  const [cancelling, setCancelling] = useState<Order | null>(null);
  const now = useNow(10_000);
  // Default view is set to READY as requested
  const [filter, setFilter] = useState<FilterKey>('READY');
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // This tab is for today only; earlier orders are in Sales -> Order history.
  const scopedOrders = useMemo(() => {
    const filtered = new Map<number, LiveOrder>();
    for (const [id, o] of orders.entries()) {
      if (isCreatedToday(o.createdAt)) filtered.set(id, o);
    }
    return filtered;
  }, [orders, now]);

  const counts = useMemo(() => {
    const c: Partial<Record<OrderStatus, number>> = {};
    for (const o of scopedOrders.values()) {
      const s = o.status as OrderStatus;
      c[s] = (c[s] ?? 0) + 1;
    }
    return c;
  }, [scopedOrders]);

  const visible = useMemo(() => {
    let list = recentOrders(scopedOrders, filter === 'ALL' ? undefined : filter).filter(isFullOrder);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((o) => {
        if (o.orderNumber.toLowerCase().includes(q)) return true;
        if (o.tableNumber && o.tableNumber.toLowerCase().includes(q)) return true;
        if (o.notes && o.notes.toLowerCase().includes(q)) return true;
        return o.items.some((i) => i.itemName.toLowerCase().includes(q));
      });
    }
    return list;
  }, [scopedOrders, filter, search]);

  async function refresh() {
    setRefreshing(true);
    await resync();
    setRefreshing(false);
  }

  return (
    <div className="flex min-h-0 min-w-0 w-full max-w-full flex-1 flex-col overflow-x-hidden">
      {/* Top Header Bar - Apple Glassmorphism */}
      <div className="relative z-20 border-b border-white/70 bg-white/70 px-4 py-3.5 backdrop-blur-2xl sm:px-6 shadow-[0_1px_12px_rgba(15,23,42,0.02)]">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-[#ffede3] text-[#ff8548] shadow-2xs ring-1 ring-[#ff8548]/20">
                <ClipboardList size={18} aria-hidden />
              </span>
              <div>
                <h1 className="text-xl font-bold tracking-tight text-slate-900">Orders</h1>
                <p className="flex items-center gap-2 text-xs font-medium text-slate-500">
                  <span>{scopedOrders.size} today</span>
                  <span>&bull;</span>
                  <span className="text-amber-600 font-semibold">{(counts.READY ?? 0) + (counts.PREPARING ?? 0) + (counts.NEW ?? 0)} active in kitchen</span>
                </p>
              </div>
            </div>

            <div className="sm:hidden">
              <IconButton
                icon={RotateCw}
                variant="secondary"
                aria-label="Refresh orders"
                onClick={refresh}
                disabled={refreshing}
                className={refreshing ? 'animate-spin' : ''}
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Search Input */}
            <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
              <Search size={15} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Search orders…" aria-label="Search by order number, table or dish"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-9.5 w-full rounded-full bg-slate-100/80 hover:bg-slate-100 border border-slate-200/60 focus:border-slate-400 focus:bg-white pr-8 pl-9.5 text-xs sm:text-sm text-slate-900 outline-none backdrop-blur-md shadow-2xs transition-all"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute top-1/2 right-3 -translate-y-1/2 text-slate-400 hover:text-slate-900 cursor-pointer"
                  aria-label="Clear search"
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {/* Status filter: a dropdown, on the same line as the search */}
            <FilterMenu
              label="Filter by status"
              value={filter}
              onChange={setFilter}
              options={FILTERS.map((f) => ({ value: f.key, label: f.label, icon: f.icon, tone: f.tone, count: f.key === 'ALL' ? scopedOrders.size : (counts[f.key] ?? 0) }))}
            />

            <div className="hidden sm:block">
              <IconButton
                icon={RotateCw}
                variant="secondary"
                aria-label="Refresh orders"
                onClick={refresh}
                disabled={refreshing}
                className={refreshing ? 'animate-spin' : ''}
              />
            </div>
          </div>
        </div>
      </div>

      <ConnectionBanner />

      {/* Main Content Area */}
      <div className="min-h-0 min-w-0 w-full max-w-full flex-1 overflow-y-auto p-4 sm:p-6 pb-24 md:pb-6">
        {!loaded ? (
          syncError ? (
            <div role="alert" className="flex items-center gap-2.5 rounded-control bg-danger-tint px-4 py-3 text-sm font-medium text-danger">
              <CircleAlert size={18} className="shrink-0" aria-hidden /> {syncError}
            </div>
          ) : (
            <div className="flex h-64 items-center justify-center gap-2 text-ink-2">
              <Loader2 size={22} className="animate-spin text-accent" aria-hidden />
              <span>Loading orders...</span>
            </div>
          )
        ) : visible.length === 0 ? (
          <div className="flex h-72 flex-col items-center justify-center rounded-card border border-dashed border-line p-8 text-center">
            {filter === 'READY' ? (
              <>
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200 shadow-2xs">
                  <BellRing size={26} aria-hidden />
                </span>
                <p className="mt-3 text-base font-bold text-ink">No orders are ready to serve</p>
                <p className="mt-1 max-w-md text-xs sm:text-sm text-ink-2">
                  Orders marked ready by the kitchen will appear here instantly for serving.
                </p>
                {(counts.PREPARING ?? 0) > 0 && (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={Flame}
                    onClick={() => setFilter('PREPARING')}
                    className="mt-4"
                  >
                    View preparing orders ({counts.PREPARING})
                  </Button>
                )}
              </>
            ) : filter === 'PREPARING' ? (
              <>
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-50 text-amber-600 border border-amber-200 shadow-2xs">
                  <Flame size={26} aria-hidden />
                </span>
                <p className="mt-3 text-base font-bold text-ink">No orders currently preparing</p>
                <p className="mt-1 text-xs sm:text-sm text-ink-2">Food currently cooking in the kitchen will show up here.</p>
              </>
            ) : search ? (
              <>
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-fill text-ink-3">
                  <Search size={24} aria-hidden />
                </span>
                <p className="mt-3 text-base font-bold text-ink">No orders match "{search}"</p>
                <p className="mt-1 text-xs text-ink-2">Try searching by a different table number or item name.</p>
                <Button size="sm" variant="plain" onClick={() => setSearch('')} className="mt-3">
                  Clear search
                </Button>
              </>
            ) : (
              <>
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-fill text-ink-3">
                  <ClipboardList size={26} aria-hidden />
                </span>
                <p className="mt-3 text-base font-bold text-ink">No orders today</p>
                <p className="mt-1 text-xs text-ink-2">Orders placed today will appear here. Earlier orders are in Sales, under Order history.</p>
              </>
            )}
          </div>
        ) : (
          <div className="grid w-full min-w-0 max-w-full grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 sm:gap-4">
            {visible.map((o) => (
              <OrderCard
                key={o.id}
                order={o}
                highlighted={o.id === highlightId}
                pending={isPending(o.id)}
                now={now}
                onServe={() => void run(o, 'COMPLETED')}
                onCheckout={() => onCheckout(o.id)}
                // Unpaid orders can be corrected only before the kitchen starts: edit items or cancel.
                onEdit={o.status === 'NEW' && o.paymentStatus === 'UNPAID' && !o.items.some((i) => i.sentToKitchen) ? () => setEditing(o) : undefined}
                onCancel={o.status === 'NEW' && (o.paymentStatus === 'UNPAID' || o.paymentStatus === 'FAILED') ? () => setCancelling(o) : undefined}
              />
            ))}
          </div>
        )}
      </div>
      {editing && <EditOrderSheet key={editing.id} order={editing} onClose={() => setEditing(null)} />}
      {cancelling && <CancelOrderSheet key={cancelling.id} order={cancelling} onClose={() => setCancelling(null)} />}
    </div>
  );
}
