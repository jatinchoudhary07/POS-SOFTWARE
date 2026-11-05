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

export const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const shortDate = (k: string) => fromKey(k).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
