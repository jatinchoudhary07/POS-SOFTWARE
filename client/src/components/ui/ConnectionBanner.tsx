import { RotateCw, WifiOff } from 'lucide-react';
import { useLiveOrders } from '../../state/LiveOrders';
import { Button } from './Button';

/**
 * Shown on the live screens while real-time updates are unavailable. The screen keeps
 * working with the last known orders and refreshes over REST every 10 s meanwhile.
 */
export function ConnectionBanner() {
  const { connection, lastSyncedAt, syncError, reconnect } = useLiveOrders();
  if (connection === 'live' && !syncError) return null;
  if (connection === 'connecting' && !syncError) return null; // brief on start-up; header shows it

  const checked = lastSyncedAt?.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return (
    <div
      role="status"
      className="mx-4 mb-1 flex animate-enter items-center gap-3 rounded-control bg-warning-tint px-4 py-2.5 text-sm text-warning lg:mx-6"
    >
      <WifiOff size={18} className="shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">
          {syncError && connection === 'live' ? 'Could not refresh orders. ' : 'Live updates paused — reconnecting. '}
        </span>
        {syncError ? syncError : 'Showing the last known orders'}
        {checked && ` (checked ${checked})`}.
      </p>
      <Button size="sm" variant="secondary" icon={RotateCw} onClick={reconnect}>
        Retry now
      </Button>
    </div>
  );
}
