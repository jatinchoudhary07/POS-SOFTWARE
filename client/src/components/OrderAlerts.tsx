import { Bell, BellOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { isFullOrder, type LiveOrder } from '../api/types';
import { buzz, chime, systemNotify, useAlertsEnabled } from '../lib/orderAlerts';
import { disablePush, refreshPush, registerServiceWorker } from '../lib/push';
import { useUser } from '../state/Auth';
import { useLiveOrders } from '../state/LiveOrders';
import { cx } from '../lib/cx';
import { AlertsSheet, PushPrompt } from './AlertsSheet';
import { IconButton } from './ui/Button';
import { useToast } from './ui/Toast';

const place = (o: LiveOrder) => (o.tableNumber ? `Table ${o.tableNumber}` : o.orderType === 'DINE_IN' ? 'Dine-in' : 'Packing');
const shortNumber = (o: LiveOrder) => o.orderNumber.split('-').pop() ?? o.orderNumber;
const itemsLine = (o: LiveOrder) =>
  o.items
    .slice(0, 3)
    .map((i) => `${i.quantity}× ${i.itemName}`)
    .join(', ') + (o.items.length > 3 ? ` +${o.items.length - 3} more` : '');

/**
 * Kitchen login: alerts for every NEW order (a loud bell). Reception / Superadmin: alerts when an order
 * turns READY (a soft marimba run). The two sounds are deliberately very different.
 * Also vibrates (Android), shows a toast, flashes the tab title and, if allowed, sends a system
 * notification while the tab is in the background.
 */
export function OrderAlerts() {
  const { role } = useUser();
  const { subscribe, orders } = useLiveOrders();
  const toast = useToast();
  const enabled = useAlertsEnabled();
  const ordersRef = useRef(orders);
  ordersRef.current = orders;
  const unseen = useRef(0);
  const baseTitle = useRef(document.title);

  // Lock-screen alerts follow the mute switch: muted = this phone is taken off the list, on = (re)registered to this sign-in.
  useEffect(() => {
    void registerServiceWorker().then(() => (enabled ? refreshPush() : disablePush()));
  }, [enabled]);

  // Clear the flashing title once the tab is looked at again.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      unseen.current = 0;
      document.title = baseTitle.current;
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    return subscribe(({ type, order }) => {
      const before = ordersRef.current.get(order.id);
      const isNew = role === 'KITCHEN' && type === 'created' && !before;
      // More food added to a table's running order: NEW again, or (while still NEW) with more items than before.
      const isAdded = role === 'KITCHEN' && type === 'updated' && !!before && order.status === 'NEW' && (before.status !== 'NEW' || order.itemCount > before.itemCount);
      const isReady = role !== 'KITCHEN' && type === 'updated' && order.status === 'READY' && !!before && before.status !== 'READY';
      // An order the kitchen was working on got cancelled: tell them to stop.
      if (role === 'KITCHEN' && type === 'updated' && order.status === 'CANCELLED' && !!before && before.status !== 'CANCELLED' && before.status !== 'COMPLETED') {
        toast({ tone: 'error', title: `Order #${shortNumber(order)} cancelled · ${place(order)}`, description: 'Stop preparing it.' });
        chime('cancel');
        buzz('cancel');
        systemNotify(`Order #${shortNumber(order)} cancelled`, 'Stop preparing it.', `order-${order.id}`);
        return;
      }
      if (!isNew && !isReady && !isAdded) return;

      const title = isNew
        ? `New order #${shortNumber(order)} · ${place(order)}`
        : isAdded
          ? `More items added to #${shortNumber(order)} · ${place(order)}`
          : `Order #${shortNumber(order)} is ready · ${place(order)}`;
      const body = isNew || isAdded ? itemsLine(order) : isFullOrder(order) && order.items.length ? itemsLine(order) : 'Ready to serve';

      toast({ tone: 'success', title, description: body });
      // Kitchen hears the loud bell for incoming food; reception / owner hear the soft marimba run for "ready".
      const kind = isNew || isAdded ? 'new' : 'ready';
      chime(kind);
      buzz(kind);
      systemNotify(title, body, `order-${order.id}`);
      if (document.visibilityState !== 'visible') {
        unseen.current += 1;
        document.title = `(${unseen.current}) ${isNew ? 'New order' : isAdded ? 'Items added' : 'Order ready'} · ${baseTitle.current}`;
      }
    });
  }, [enabled, role, subscribe, toast]);

  return <PushPrompt />;
}

/** Header button: opens the alerts panel (mute, hear the sound, set up alerts for a locked phone). */
export function AlertBell() {
  const enabled = useAlertsEnabled();
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton
        icon={enabled ? Bell : BellOff}
        variant="plain"
        aria-label="Order alerts settings"
        aria-haspopup="dialog"
        title={enabled ? 'Order alerts on' : 'Order alerts muted'}
        className={cx(enabled ? 'text-accent' : 'text-ink-3')}
        onClick={() => setOpen(true)}
      />
      {open && <AlertsSheet onClose={() => setOpen(false)} />}
    </>
  );
}
