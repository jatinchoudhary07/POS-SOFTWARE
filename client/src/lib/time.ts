export const formatClock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** "just now", "4 min", "1 h 12 min" */
export function formatElapsed(fromIso: string, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - Date.parse(fromIso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export const minutesSince = (fromIso: string, nowMs: number) => (nowMs - Date.parse(fromIso)) / 60_000;
