import { X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../lib/cx';

const FULL = 0.9; // share of the screen height when pulled all the way up
const DISMISS_PX = 110;
const EXPAND_PX = 50;

/**
 * Panel that slides up from the bottom over a dimmed backdrop. Mount it to open, call `onClose` to remove it.
 * Hold and drag the handle or title: up expands it, down shrinks it, and pulling far enough down closes it.
 */
export function BottomSheet({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  const [leaving, setLeaving] = useState(false);
  const [entered, setEntered] = useState(false);
  const [drag, setDrag] = useState({ y: 0, height: null as number | null, active: false });
  const panel = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ startY: number; startH: number; lastY: number; lastT: number; v: number } | null>(null);
  const expanded = useRef(false);
  const restH = useRef(0);

  const close = useCallback(() => {
    setLeaving(true);
    window.setTimeout(onClose, 220);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener('keydown', onKey);
    };
  }, [close]);

  const maxH = () => Math.round(window.innerHeight * FULL);

  function down(e: PointerEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest('button')) return;
    const h = panel.current?.offsetHeight ?? 0;
    if (!expanded.current) restH.current = h;
    gesture.current = { startY: e.clientY, startH: h, lastY: e.clientY, lastT: e.timeStamp, v: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ y: 0, height: h, active: true });
  }

  function move(e: PointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g) return;
    const dy = e.clientY - g.startY;
    const dt = Math.max(1, e.timeStamp - g.lastT);
    g.v = (e.clientY - g.lastY) / dt; // px per ms, positive = moving down
    g.lastY = e.clientY;
    g.lastT = e.timeStamp;
    setDrag(dy < 0 ? { y: 0, height: Math.min(maxH(), g.startH - dy), active: true } : { y: dy, height: g.startH, active: true });
  }

  function up() {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const dy = g.lastY - g.startY;
    const flickDown = g.v > 0.6;
    const flickUp = g.v < -0.6;

    if (dy > DISMISS_PX || flickDown) {
      if (expanded.current && dy < window.innerHeight * 0.35 && !flickDown) {
        expanded.current = false;
        setDrag({ y: 0, height: restH.current, active: false });
      } else {
        setDrag({ y: window.innerHeight, height: g.startH, active: false });
        close();
      }
    } else if ((dy < -EXPAND_PX || flickUp) && !expanded.current) {
      expanded.current = true;
      setDrag({ y: 0, height: maxH(), active: false });
    } else {
      setDrag({ y: 0, height: expanded.current ? maxH() : restH.current, active: false });
    }
  }

  const moving = drag.y !== 0 || drag.height !== null;

  // Portal to <body>: a transformed or blurred ancestor would otherwise make `fixed` relative to it, not the screen.
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center">
      <div
        aria-hidden
        onClick={close}
        className={cx('absolute inset-0 bg-slate-900/45 backdrop-blur-xs transition-opacity duration-200', leaving ? 'opacity-0' : 'animate-fade')}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        onAnimationEnd={(e) => e.target === e.currentTarget && setEntered(true)}
        className={cx(
          'relative flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-[30px] bg-surface shadow-[0_-20px_60px_-10px_rgba(30,41,59,0.35)]',
          !entered && (leaving ? 'animate-sheet-down' : 'animate-sheet-up'),
          entered && !drag.active && 'transition-[height,transform] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]',
          entered && leaving && 'duration-200 ease-in',
        )}
        style={entered && moving ? { height: drag.height ?? undefined, transform: `translateY(${leaving ? window.innerHeight : drag.y}px)` } : entered && leaving ? { transform: `translateY(${window.innerHeight}px)` } : undefined}
      >
        {/* Grab area: hold and drag to move the sheet */}
        <div
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          className="shrink-0 cursor-grab touch-none select-none active:cursor-grabbing"
        >
          <div className="mx-auto mt-2.5 h-1.5 w-10 rounded-full bg-line-strong" aria-hidden />
          <div className="flex items-start justify-between gap-3 px-5 pt-3 pb-2">
            <h3 className="min-w-0 text-lg font-bold tracking-tight">{title}</h3>
            <button
              type="button"
              aria-label="Close"
              onClick={close}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-fill text-ink-2 transition-all hover:text-ink active:scale-90"
            >
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
