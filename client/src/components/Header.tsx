// @refresh reset
import { ChartColumn, ChefHat, ClipboardList, CookingPot, LayoutGrid, LogOut, Settings, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { User } from '../api/types';
import { canView, ROLE_LABELS } from '../state/permissions';
import { AlertBell } from './OrderAlerts';
import { IconButton } from './ui/Button';
import { SegmentedControl } from './ui/SegmentedControl';

export type View = 'new' | 'tables' | 'orders' | 'kitchen' | 'sales' | 'settings' | 'checkout';
export type NavView = Exclude<View, 'checkout'>;

const NAV_ITEMS: { value: NavView; label: string; icon: LucideIcon }[] = [
  { value: 'tables', label: 'Tables', icon: LayoutGrid },
  { value: 'orders', label: 'Orders', icon: ClipboardList },
  { value: 'kitchen', label: 'Kitchen', icon: CookingPot },
  { value: 'sales', label: 'Sales', icon: ChartColumn },
  { value: 'settings', label: 'Settings', icon: Settings },
];

/** Only the screens this login may open (the server enforces the real permissions). */
export const navItemsFor = (role: User['role']) => NAV_ITEMS.filter((i) => canView(role, i.value));

interface Props {
  restaurantName: string;
  view: View;
  onViewChange: (v: NavView) => void;
  user: User;
  onLogout: () => void;
}

export function Header({ restaurantName, view, onViewChange, user, onLogout }: Props) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const navSegments = navItemsFor(user.role).filter((i) => i.value !== 'settings');

  return (
    // Apple-style translucent frosted glass header: content scrolls softly beneath it.
    <header className="relative z-20 grid h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 w-full max-w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 sm:gap-3 border-b border-white/70 bg-white/70 px-3.5 pt-[env(safe-area-inset-top)] backdrop-blur-2xl shadow-[0_1px_12px_rgba(15,23,42,0.03)] sm:px-4 md:h-16 md:grid-cols-[1fr_auto_1fr] md:gap-4 lg:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] bg-[#ff8548] text-white shadow-sm shadow-[#ff8548]/20 transition-transform hover:scale-105">
          <ChefHat size={20} strokeWidth={2.2} className="text-white" aria-hidden />
        </span>
        <div className="min-w-0 leading-tight">
          <h1 className="truncate text-base font-black tracking-tight text-ink">{restaurantName}</h1>
          <div className="text-xs font-medium text-ink-3">{view === 'kitchen' ? 'Kitchen display' : ROLE_LABELS[user.role]}</div>
        </div>
      </div>

      {/* Phones use the bottom tab bar (MobileNav) instead. */}
      {navSegments.length > 1 ? (
        <div className="hidden md:block">
          <SegmentedControl
            label="Screen"
            className={navSegments.length > 3 ? 'w-[260px] lg:w-[500px]' : 'w-[200px] lg:w-[380px]'}
            compact
            // Checkout belongs to Orders; New (order in progress) belongs to Tables; Settings has its own button.
            value={view === 'checkout' ? 'orders' : view === 'new' ? 'tables' : view}
            onChange={onViewChange}
            segments={navSegments}
          />
        </div>
      ) : (
        <span className="hidden md:block" />
      )}

      <div className="flex items-center justify-end gap-1.5 text-sm md:gap-3">
        <AlertBell />
        <time className="hidden font-medium whitespace-nowrap text-ink-2 tabular-nums xl:inline" dateTime={now.toISOString()}>
          {now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ·{' '}
          {now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </time>
        {/* On phones Settings is in the bottom tab bar. */}
        {canView(user.role, 'settings') && (
          <span className="hidden md:contents">
            <IconButton
              icon={Settings}
              variant={view === 'settings' ? 'secondary' : 'plain'}
              aria-label="Settings"
              aria-current={view === 'settings' ? 'page' : undefined}
              onClick={() => onViewChange('settings')}
            />
          </span>
        )}
        <span className="hidden text-right leading-tight lg:block">
          <span className="block text-sm font-semibold">{user.username}</span>
          <span className="block text-xs text-ink-2">{ROLE_LABELS[user.role]}</span>
        </span>
        <IconButton icon={LogOut} variant="plain" aria-label={`Sign out ${user.username}`} title="Sign out" onClick={onLogout} />
      </div>
    </header>
  );
}
