import {
  Ban,
  BellRing,
  CircleAlert,
  Clock,
  CookingPot,
  Flame,
  Hash,
  Inbox,
  Loader2,
  RotateCw,
  Package,
  PlusCircle,
  StickyNote,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KitchenOrder } from '../api/types';
import { cx } from '../lib/cx';
import { formatClock, formatElapsed, minutesSince } from '../lib/time';
import { useNow } from '../lib/useNow';
import { useLiveOrders } from '../state/LiveOrders';
import { kitchenLanes } from '../state/orders';
import { useStatusAction } from '../state/useStatusAction';
import { Button } from './ui/Button';
import { PackTag } from './ui/PackTag';
import { ConnectionBanner } from './ui/ConnectionBanner';
import { SegmentedControl } from './ui/SegmentedControl';

// Tickets waiting longer than this (and not yet ready) get an amber timer.
const SLOW_MINUTES = 15;
// Orders younger than this are marked "Just in".
const JUST_IN_MINUTES = 1;

interface LaneConfig {
  key: 'NEW' | 'PREPARING' | 'READY';
  title: string;
  dot: string;
  empty: string;
  emptyIcon: LucideIcon;
}

const LANES: LaneConfig[] = [
  { key: 'NEW', title: 'New', dot: 'bg-accent', empty: 'No new orders', emptyIcon: Inbox },
  { key: 'PREPARING', title: 'Preparing', dot: 'bg-warning', empty: 'Nothing on the stove', emptyIcon: CookingPot },
  { key: 'READY', title: 'Ready', dot: 'bg-success', empty: 'Nothing waiting to be served', emptyIcon: BellRing },
];

function OrderNumber({ value }: { value: string }) {
  // "261021-007": the date part is muted, the daily number is what staff call out.
  const [date, seq] = value.split('-');
  return (
    <h3 className="text-[26px] leading-none font-semibold tracking-tight tabular-nums">
      <span className="sr-only">Order </span>
      <span className="text-base font-medium text-ink-2">{date}-</span>
      {seq}
    </h3>
  );
}

function Ticket({
  order,
  now,
  pending,
  onAdvance,
  cancelled = false,
  onDismiss,
}: {
  order: KitchenOrder;
  now: number;
  pending: boolean;
  onAdvance: () => void;
  /** The order was cancelled while it was in the kitchen: shown until someone taps "Got it". */
  cancelled?: boolean;
  onDismiss?: () => void;
}) {
  const dineIn = order.orderType === 'DINE_IN';
  const TypeIcon = dineIn ? UtensilsCrossed : Package;
  const waited = minutesSince(order.createdAt, now);
  const slow = order.status !== 'READY' && waited >= SLOW_MINUTES;
  const justIn = order.status === 'NEW' && waited < JUST_IN_MINUTES;
  const hasAdded = order.items.some((i) => i.sent) && order.items.some((i) => !i.sent);

  return (
    <article
      aria-label={`Order ${order.orderNumber}, ${order.status === 'NEW' ? 'new' : order.status.toLowerCase()}`}
      // Mounting in a lane (new order, or after a status change) plays the short enter animation.
      className={cx(
        'animate-enter rounded-card bg-surface p-4',
        cancelled ? 'shadow-[0_0_0_2px_var(--color-danger),0_6px_20px_-6px_rgb(0_0_0/0.15)]' : justIn ? 'shadow-[0_0_0_2px_var(--color-accent),0_6px_20px_-6px_rgb(0_0_0/0.15)]' : 'shadow-card',
      )}
    >
      {cancelled && (
        <p role="alert" className="mb-3 flex items-center gap-2 rounded-control bg-danger-tint px-3 py-2.5 text-[15px] font-bold text-danger">
          <Ban size={18} className="shrink-0" aria-hidden /> Order cancelled. Stop preparing it.
        </p>
      )}
      <div className={cx('flex items-start justify-between gap-3', cancelled && 'opacity-60')}>
        <OrderNumber value={order.orderNumber} />
        <span
          className={cx(
            'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-semibold tabular-nums',
            slow ? 'bg-warning-tint text-warning' : 'bg-fill text-ink-2',
          )}
          title={`Received ${formatClock(order.createdAt)}`}
        >
          <Clock size={14} aria-hidden />
          {formatElapsed(order.createdAt, now)}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-2">
        <span className="inline-flex items-center gap-1.5 font-semibold text-ink">
          <TypeIcon size={15} aria-hidden /> {dineIn ? 'Dine-in' : 'Packing (Takeaway / Delivery)'}
        </span>
        {order.tableNumber && (
          <span className="inline-flex items-center gap-1 font-semibold text-ink">
            <Hash size={15} aria-hidden /> Table {order.tableNumber}
          </span>
        )}
        <span className="tabular-nums">Received {formatClock(order.createdAt)}</span>
        {justIn && (
          <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-white">Just in</span>
        )}
      </div>

      {dineIn && order.items.some((i) => i.packed) && (
        <p className="mt-3 inline-flex items-center gap-1.5 rounded-control bg-accent-tint px-2.5 py-1 text-xs font-bold text-accent">
          <Package size={13} aria-hidden /> Some dishes are to be packed to take away
        </p>
      )}
      {hasAdded && (
        <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-xs font-bold text-white">
          <PlusCircle size={13} aria-hidden /> Items added to this order
        </p>
      )}
      <ul className={cx('space-y-1.5 border-t border-line pt-3', hasAdded ? 'mt-2' : 'mt-3', cancelled && 'line-through opacity-50')}>
        {order.items.map((i) => {
          // Once something was added, the lines the kitchen already took are shown quietly and the new ones stand out.
          const done = hasAdded && i.sent;
          return (
            <li key={i.id} className={cx('flex items-baseline gap-2 text-[17px] leading-snug', done && 'text-ink-3')}>
              <span className="w-9 shrink-0 font-semibold tabular-nums">{i.quantity}×</span>
              <span className={cx('font-medium', done && 'line-through decoration-1')}>{i.itemName}</span>
              {i.packed && <PackTag large className="self-center" />}
              {hasAdded && !i.sent && <span className="ml-auto rounded-full bg-accent-tint px-2 py-0.5 text-[11px] font-bold text-accent">NEW</span>}
              {done && <span className="ml-auto text-[11px] font-semibold">sent</span>}
            </li>
          );
        })}
      </ul>

      {order.notes && (
        <p className="mt-3 flex gap-2 rounded-control bg-warning-tint px-3 py-2.5 text-[15px] font-medium text-warning">
          <StickyNote size={17} className="mt-0.5 shrink-0" aria-hidden />
          <span>{order.notes}</span>
        </p>
      )}

      <div className="mt-4">
        {cancelled && (
          <Button size="lg" variant="secondary" onClick={onDismiss} className="w-full">
            Got it, remove
          </Button>
        )}
        {!cancelled && order.status === 'NEW' && (
          <Button size="lg" variant="primary" icon={Flame} loading={pending} disabled={pending} onClick={onAdvance} className="w-full">
            Start preparing
          </Button>
        )}
        {!cancelled && order.status === 'PREPARING' && (
          <Button size="lg" variant="success" icon={BellRing} loading={pending} disabled={pending} onClick={onAdvance} className="w-full">
            Mark ready
          </Button>
        )}
        {!cancelled && order.status === 'READY' && (
          <p className="flex h-12 items-center justify-center gap-2 rounded-control bg-success-tint text-[15px] font-semibold text-success">
            <BellRing size={17} aria-hidden /> Waiting to be served
          </p>
        )}
      </div>
    </article>
  );
}

export function KitchenView() {
  const { orders, loaded, syncError, resync, subscribe } = useLiveOrders();
  const { run, isPending } = useStatusAction();
  // Tickets cancelled while in the kitchen stay (in the column they were in) until someone taps "Got it".
  const [cancelled, setCancelled] = useState<Map<number, { order: KitchenOrder; lane: LaneConfig['key'] }>>(() => new Map());
  const ordersRef = useRef(orders);
  ordersRef.current = orders;
  useEffect(
    () =>
      subscribe(({ order }) => {
        if (order.status !== 'CANCELLED') return;
        const before = ordersRef.current.get(order.id);
        if (before && (before.status === 'NEW' || before.status === 'PREPARING' || before.status === 'READY')) {
          setCancelled((m) => new Map(m).set(order.id, { order: order as KitchenOrder, lane: before.status as LaneConfig['key'] }));
        }
      }),
    [subscribe],
  );
  const dismiss = (id: number) =>
    setCancelled((m) => {
      const next = new Map(m);
      next.delete(id);
      return next;
    });
  const now = useNow();
  const lanes = useMemo(() => kitchenLanes(orders), [orders]);
  // Phones show one column at a time, picked with the tabs above it.
  const [phoneLane, setPhoneLane] = useState<LaneConfig['key']>('NEW');

  return (
    <div className="flex min-h-0 min-w-0 w-full max-w-full flex-1 flex-col overflow-x-hidden">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 pt-4 pb-3 lg:px-6 lg:pt-5">
        <h2 className="text-xl font-semibold tracking-tight">Kitchen</h2>
        <p className="text-sm text-ink-2 tabular-nums">
          {lanes.NEW.length} new · {lanes.PREPARING.length} preparing · {lanes.READY.length} ready
        </p>
      </div>
      <ConnectionBanner />

      {!loaded ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-ink-2">
          {syncError ? (
            <>
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-danger-tint text-danger">
                <CircleAlert size={22} aria-hidden />
              </span>
              <p className="font-medium text-ink">{syncError}</p>
              <Button variant="primary" icon={RotateCw} onClick={() => void resync()}>
                Try again
              </Button>
            </>
          ) : (
            <p className="flex items-center gap-2">
              <Loader2 size={18} className="animate-spin" aria-hidden /> Loading orders…
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="px-4 pb-1 md:hidden">
            <SegmentedControl
              label="Kitchen column"
              value={phoneLane}
              onChange={setPhoneLane}
              segments={LANES.map((l) => ({ value: l.key, label: `${l.title} ${lanes[l.key].length}` }))}
            />
          </div>
          {/* Three columns; on tablets they scroll sideways instead of squeezing; phones show one. */}
          <div className="grid min-h-0 flex-1 auto-cols-[minmax(280px,1fr)] grid-flow-col gap-4 overflow-x-auto overflow-y-auto px-4 pt-2 pb-24 md:grid-rows-[minmax(0,1fr)] md:overflow-y-hidden md:pb-6 lg:px-6">
            {LANES.map((lane) => {
              const list = lanes[lane.key];
              const dead = [...cancelled.values()].filter((c) => c.lane === lane.key);
              const EmptyIcon = lane.emptyIcon;
              return (
                <section
                  key={lane.key}
                  aria-label={`${lane.title} orders`}
                  className={cx('flex-col rounded-[18px] bg-fill/60 p-2 md:flex md:min-h-0', lane.key === phoneLane ? 'flex' : 'hidden')}
                >
                  <header className="flex items-center gap-2 px-2.5 pt-1.5 pb-2.5">
                    <span className={cx('h-2.5 w-2.5 rounded-full', lane.dot)} aria-hidden />
                    <h3 className="text-[15px] font-semibold">{lane.title}</h3>
                    <span className="ml-auto rounded-full bg-surface px-2.5 py-0.5 text-sm font-semibold tabular-nums shadow-control">
                      {list.length}
                    </span>
                  </header>
                  <div className="space-y-3 p-1 md:min-h-0 md:flex-1 md:overflow-y-auto">
                    {dead.map(({ order }) => (
                      <Ticket key={`x${order.id}`} order={order} now={now} pending={false} onAdvance={() => {}} cancelled onDismiss={() => dismiss(order.id)} />
                    ))}
                    {list.length === 0 && dead.length === 0 ? (
                      <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-ink-2">
                        <EmptyIcon size={22} className="text-ink-3" aria-hidden />
                        {lane.empty}
                      </div>
                    ) : (
                      list.map((o) => (
                        <Ticket
                          key={o.id}
                          order={o}
                          now={now}
                          pending={isPending(o.id)}
                          onAdvance={() => void run(o, o.status === 'NEW' ? 'PREPARING' : 'READY')}
                        />
                      ))
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
