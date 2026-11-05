import { useCallback, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import type { LiveOrder, OrderStatus } from '../api/types';
import { useToast } from '../components/ui/Toast';
import { useLiveOrders } from './LiveOrders';

/**
 * Runs a status change for a button: blocks double taps per order, shows a spinner, and on
 * failure shows the server's message. If the order was changed elsewhere first (409), the
 * screen re-syncs so it shows the real state instead of a stale ticket.
 */
export function useStatusAction() {
  const { updateStatus, resync } = useLiveOrders();
  const toast = useToast();
  const inFlight = useRef(new Set<number>());
  const [pending, setPending] = useState<ReadonlySet<number>>(new Set());

  const run = useCallback(
    async (order: LiveOrder, to: OrderStatus) => {
      if (inFlight.current.has(order.id)) return;
      inFlight.current.add(order.id);
      setPending(new Set(inFlight.current));
      try {
        await updateStatus(order.id, to);
      } catch (e) {
        const message = e instanceof ApiError ? e.message : 'Unexpected error. Please try again.';
        toast({ tone: 'error', title: `Could not update #${order.orderNumber}`, description: message });
        if (e instanceof ApiError && ['INVALID_TRANSITION', 'CONFLICT', 'NOT_FOUND', 'ORDER_CANCELLED'].includes(e.code)) void resync();
      } finally {
        inFlight.current.delete(order.id);
        setPending(new Set(inFlight.current));
      }
    },
    [updateStatus, resync, toast],
  );

  return { run, isPending: (id: number) => pending.has(id) };
}
