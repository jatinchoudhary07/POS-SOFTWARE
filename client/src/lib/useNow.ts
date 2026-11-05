import { useEffect, useState } from 'react';
import { serverNow } from './serverClock';

/** Server-corrected "now", refreshed on an interval (for elapsed-time labels). */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const t = setInterval(() => setNow(serverNow()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
