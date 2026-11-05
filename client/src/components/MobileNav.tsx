import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { User } from '../api/types';
import { cx } from '../lib/cx';
import { navItemsFor, type NavView, type View } from './Header';

interface Props {
  view: View;
  role: User['role'];
  onViewChange: (v: NavView) => void;
}

/**
 * Mobile bottom navigation dock with Apple-style frosted glass theme:
 * - Floating dark glass capsule dock with backdrop blur
 * - Luminous cyan-blue ambient top glow
 * - Smoothly sliding bright white capsule pill, strictly centered on the active tab
 * - Zero overflow on outer ends
 */
export function MobileNav({ view, role, onViewChange }: Props) {
  const items = navItemsFor(role);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const trackRef = useRef<HTMLDivElement>(null);
  const [pillStyle, setPillStyle] = useState<{ left: number; width: number; height: number } | null>(null);

  const current = view === 'checkout' ? 'orders' : view === 'new' ? 'tables' : view;
  const activeIndex = Math.max(0, items.findIndex((i) => i.value === current));

  const updatePill = useCallback(() => {
    const btn = buttonRefs.current[activeIndex];
    if (!btn) return;
    const left = btn.offsetLeft + btn.offsetWidth / 2;
    // Keep pill proportional and safely within button boundaries
    const width = Math.min(Math.max(btn.offsetWidth - 10, 42), 50);
    const height = 36;
    setPillStyle({ left, width, height });
  }, [activeIndex]);

  useLayoutEffect(() => {
    updatePill();
  }, [updatePill, activeIndex, items.length]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const ro = new ResizeObserver(() => updatePill());
    ro.observe(track);
    window.addEventListener('resize', updatePill);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', updatePill);
    };
  }, [updatePill]);

  if (items.length < 2) return null;

  return (
    <nav
      aria-label="Screens"
      className="pointer-events-none z-30 shrink-0 px-3 pt-2 pb-[max(0.6rem,env(safe-area-inset-bottom))] select-none md:hidden"
    >
      <div className="pointer-events-auto relative mx-auto w-full max-w-[420px]">
        {/* Ambient cyan-blue top lighting halo */}
        <div className="pointer-events-none absolute -top-2.5 inset-x-10 h-5 rounded-full bg-cyan-400/20 blur-md" />

        {/* Dynamic ambient glow tracking the active pill */}
        {pillStyle && (
          <div
            className="pointer-events-none absolute -top-3 h-7 w-16 -translate-x-1/2 rounded-full bg-cyan-400/35 blur-lg"
            style={{
              left: `${pillStyle.left + 10}px`,
              transition: 'left 280ms cubic-bezier(0.25, 1, 0.5, 1)',
            }}
          />
        )}

        {/* Apple-style Frosted Glass Dock Container */}
        <div className="relative flex h-[54px] w-full items-center rounded-full border border-white/15 bg-[#0c0e18]/85 px-2.5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.25),0_16px_36px_-6px_rgba(0,0,0,0.6),0_0_20px_rgba(14,165,233,0.15)] backdrop-blur-2xl">
          {/* Inner Buttons Track */}
          <div ref={trackRef} className="relative flex h-full w-full items-center">
            {/* Sliding white pill capsule indicator */}
            {pillStyle && (
              <div
                className="pointer-events-none absolute top-1/2 -translate-y-1/2 -translate-x-1/2 rounded-full bg-white shadow-[0_4px_14px_rgba(0,0,0,0.35),0_1px_3px_rgba(0,0,0,0.2)] ring-1 ring-white/90"
                style={{
                  left: `${pillStyle.left}px`,
                  width: `${pillStyle.width}px`,
                  height: `${pillStyle.height}px`,
                  transition: 'left 280ms cubic-bezier(0.25, 1, 0.5, 1), width 280ms cubic-bezier(0.25, 1, 0.5, 1)',
                }}
              />
            )}

            {/* Navigation Buttons Row */}
            {items.map(({ value, label, icon: Icon }, idx) => {
              const active = value === current;
              return (
                <button
                  key={value}
                  ref={(el) => {
                    buttonRefs.current[idx] = el;
                  }}
                  type="button"
                  aria-label={label}
                  title={label}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => {
                    try {
                      navigator?.vibrate?.(10);
                    } catch {}
                    onViewChange(value);
                  }}
                  className="group relative z-10 flex h-full flex-1 items-center justify-center outline-none"
                >
                  <span
                    className={cx(
                      'flex items-center justify-center transition-all duration-200',
                      active
                        ? 'text-[#0c0e18] scale-105'
                        : 'text-white/60 group-hover:text-white group-active:scale-90',
                    )}
                  >
                    <Icon size={20} strokeWidth={active ? 2.5 : 2} aria-hidden />
                  </span>
                  <span className="sr-only">{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </nav>
  );
}
