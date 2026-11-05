import { Bell, BellOff } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { isFullOrder, type LiveOrder } from '../api/types';
import { askNotificationPermission, buzz, chime, setAlertsEnabled, systemNotify, unlockAudio, useAlertsEnabled } from '../lib/orderAlerts';
import { useUser } from '../state/Auth';
import { useLiveOrders } from '../state/LiveOrders';
import { cx } from '../lib/cx';
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
 * Kitchen login: alerts for every NEW order. Reception / Superadmin: alerts when an order turns READY.
 * Plays a chime, vibrates (Android), shows a toast, flashes the tab title and, if allowed, sends a
 * system notification while the tab is in the background.
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

  // Browsers allow sound only after the first tap/keypress on the page.
  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

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
        chime('ready');
        buzz();
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
      chime(isNew || isAdded ? 'new' : 'ready');
      buzz();
      systemNotify(title, body, `order-${order.id}`);
      if (document.visibilityState !== 'visible') {
        unseen.current += 1;
        document.title = `(${unseen.current}) ${isNew ? 'New order' : isAdded ? 'Items added' : 'Order ready'} · ${baseTitle.current}`;
      }
    });
  }, [enabled, role, subscribe, toast]);

  return null;
}

/** Header button: turn order alerts on or off. Turning them on also unlocks sound and asks for notification permission. */
export function AlertBell() {
  const enabled = useAlertsEnabled();
  return (
    <IconButton
      icon={enabled ? Bell : BellOff}
      variant="plain"
      aria-label={enabled ? 'Turn order alerts off' : 'Turn order alerts on'}
      aria-pressed={enabled}
      title={enabled ? 'Order alerts on (tap to mute)' : 'Order alerts off'}
      className={cx(enabled ? 'text-accent' : 'text-ink-3')}
      onClick={() => {
        const next = !enabled;
        setAlertsEnabled(next);
        if (next) {
          unlockAudio();
          chime('ready'); // a test chime so you know the sound works
          void askNotificationPermission();
        }
      }}
    />
  );
}
