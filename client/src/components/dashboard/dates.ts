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

/** The cafe trades from 11am to 11pm. The hourly chart always shows at least these hours. */
export const TRADING_FIRST_HOUR = 11;
export const TRADING_LAST_HOUR = 23;

/**
 * Which hours the hourly chart covers: always the full trading day (11am to 11pm), so the picture looks the same
 * every day, and wider only when a sale happened outside those hours (an 8am order shows from 8am, a midnight one
 * to midnight). Every sale is always on the chart, whatever hour the cafe really opened or closed that day.
 */
export function hourWindow(activeHours: number[]): { lo: number; hi: number } {
  return {
    lo: Math.min(TRADING_FIRST_HOUR, ...activeHours),
    hi: Math.max(TRADING_LAST_HOUR, ...activeHours),
  };
}

export const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const shortDate = (k: string) => fromKey(k).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
