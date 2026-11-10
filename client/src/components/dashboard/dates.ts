export const toKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const fromKey = (k: string) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
};

export const shiftDay = (k: string, days: number) => {
  const d = fromKey(k);
  d.setDate(d.getDate() + days);
  return toKey(d);
};

export type Preset = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'custom';

export const PRESET_LABELS: Record<Preset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  month: 'This month',
  custom: 'Custom',
};

export function presetRange(p: Exclude<Preset, 'custom'>): { from: string; to: string } {
  const today = toKey(new Date());
  switch (p) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: shiftDay(today, -1), to: shiftDay(today, -1) };
    case '7d':
      return { from: shiftDay(today, -6), to: today };
    case '30d':
      return { from: shiftDay(today, -29), to: today };
    case 'month':
      return { from: `${today.slice(0, 8)}01`, to: today };
  }
}

/**
 * Which hours the hourly chart covers. It starts at the first hour that actually had a sale (a cafe that opened at 11
 * shows 11, not a fixed earlier hour) and ends at the last one, with at least a few bars so it never looks cramped.
 * A day with no sales shows a normal trading day (10am to 8pm).
 */
export function hourWindow(activeHours: number[]): { lo: number; hi: number } {
  if (activeHours.length === 0) return { lo: 10, hi: 20 };
  const lo = Math.min(...activeHours);
  const last = Math.max(...activeHours);
  return { lo, hi: Math.min(23, Math.max(last, lo + 6)) };
}

export const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const shortDate = (k: string) => fromKey(k).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
