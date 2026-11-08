import { useEffect } from 'react';
import { api } from '../api/client';

const PING_EVERY_MS = 20_000;

/**
 * Keeps the connection to the server open and ready.
 *
 * Opening a fresh secure connection to a far-away server costs about a second, and phones (iPhone
 * Safari most of all) close an idle connection quickly. Without this, the first tap after a pause -
 * typically "Place an order" - waits for that handshake. A tiny request every 20 seconds, plus one
 * the moment the app comes back to the screen or is first touched, means the tap goes out on a warm
 * connection. It does nothing while the app is hidden.
 */
export function useKeepWarm() {
  useEffect(() => {
    const ping = () => {
      if (document.visibilityState === 'visible') api.authStatus().catch(() => undefined);
    };
    ping();
    const timer = window.setInterval(ping, PING_EVERY_MS);
    // Right after the phone is unlocked / the tab is shown again, and on the first touch after a quiet spell.
    let lastTouch = 0;
    const onTouch = () => {
      const now = Date.now();
      if (now - lastTouch > 8_000) ping();
      lastTouch = now;
    };
    document.addEventListener('visibilitychange', ping);
    window.addEventListener('pageshow', ping);
    window.addEventListener('online', ping);
    document.addEventListener('pointerdown', onTouch, { passive: true });
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', ping);
      window.removeEventListener('pageshow', ping);
      window.removeEventListener('online', ping);
      document.removeEventListener('pointerdown', onTouch);
    };
  }, []);
}
