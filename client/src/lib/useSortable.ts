import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * Drag-to-reorder that works with a finger as well as a mouse.
 *
 *  - Touch: press and hold for a moment, then drag. Moving before the hold ends is a normal scroll.
 *  - Mouse: press and move a few pixels.
 *  - The other items slide aside while you drag, and the dragged one follows the pointer.
 *  - Dragging near the edge of the scrolling area scrolls it by itself (up/down and left/right),
 *    so an item can be taken from the bottom of a long list to the top in one go.
 *  - The new order is reported once, when the item is dropped.
 *
 * Render the items in `order`, spread `itemProps(id)` on each item's outer element, and put
 * `containerRef` on the element that holds them.
 */

const HOLD_MS = 220;
const TOUCH_SLOP_PX = 10;
const MOUSE_SLOP_PX = 5;
const EDGE_PX = 80;
const MAX_SCROLL_PX_PER_FRAME = 22;
const SWAP_COOLDOWN_MS = 110;
const SETTLE_MS = 200;

type Axis = 'x' | 'y';

interface Gesture {
  id: number;
  pointerId: number;
  pointerType: string;
  el: HTMLElement;
  startX: number;
  startY: number;
  x: number;
  y: number;
  grabX: number;
  grabY: number;
  tx: number;
  ty: number;
  active: boolean;
  timer: number;
  raf: number;
  order: number[];
  lastSwap: number;
  scrollX: HTMLElement | null;
  scrollY: HTMLElement | null;
}

/** The closest ancestor that can scroll along `axis` (the page itself counts). */
function findScroller(from: HTMLElement, axis: Axis): HTMLElement | null {
  for (let p = from.parentElement; p; p = p.parentElement) {
    const style = getComputedStyle(p);
    const overflow = axis === 'x' ? style.overflowX : style.overflowY;
    const room = axis === 'x' ? p.scrollWidth > p.clientWidth + 1 : p.scrollHeight > p.clientHeight + 1;
    if (!room) continue;
    if (p === document.documentElement || p === document.body) return document.documentElement;
    if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') return p;
  }
  return null;
}

function scrollStep(depth: number) {
  return Math.ceil(Math.min(1, Math.max(0, depth)) * MAX_SCROLL_PX_PER_FRAME);
}

export function useSortable({ ids, onReorder, disabled = false }: { ids: number[]; onReorder: (ids: number[]) => void; disabled?: boolean }) {
  const [order, setOrder] = useState(ids);
  const [draggingId, setDraggingId] = useState<number | null>(null);

  const nodes = useRef(new Map<number, HTMLElement>());
  const container = useRef<HTMLElement | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const positions = useRef(new Map<number, { x: number; y: number }>());
  const swallowClickUntil = useRef(0);

  const latest = useRef({ ids, onReorder, disabled, order });
  latest.current = { ids, onReorder, disabled, order };

  // Follow the order given from outside (loading, saving, adding an item) whenever nothing is being dragged.
  const idsKey = ids.join(',');
  useEffect(() => {
    if (!gesture.current?.active) setOrder(ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  // The order to draw: our own order, but never missing or showing items the list no longer has.
  const shown = useMemo(() => {
    const known = new Set(ids);
    const have = new Set(order);
    return [...order.filter((id) => known.has(id)), ...ids.filter((id) => !have.has(id))];
  }, [order, ids]);

  latest.current.order = shown; // what a drag starts from: the order on screen

  // Slide items to their new places (FLIP) whenever the order changes.
  useLayoutEffect(() => {
    const base = container.current?.getBoundingClientRect();
    const next = new Map<number, { x: number; y: number }>();
    for (const [id, el] of nodes.current) {
      const r = el.getBoundingClientRect();
      const g = gesture.current;
      const lifted = g?.active && g.id === id;
      // For the dragged item, leave out the offset that keeps it under the pointer.
      const pos = { x: r.left - (base?.left ?? 0) - (lifted ? g.tx : 0), y: r.top - (base?.top ?? 0) - (lifted ? g.ty : 0) };
      next.set(id, pos);
      const prev = positions.current.get(id);
      if (!prev || lifted) continue;
      const dx = prev.x - pos.x;
      const dy = prev.y - pos.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      void el.offsetWidth; // apply the start position before animating
      el.style.transition = `transform 190ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
      el.style.transform = '';
      el.addEventListener('transitionend', () => (el.style.transition = ''), { once: true });
    }
    positions.current = next;
  }, [shown.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // While an item is held, stop the page from scrolling under the finger.
  useEffect(() => {
    const block = (e: TouchEvent) => {
      if (gesture.current?.active && e.cancelable) e.preventDefault();
    };
    window.addEventListener('touchmove', block, { passive: false });
    return () => window.removeEventListener('touchmove', block);
  }, []);

  const handlers = useMemo(() => {
    function autoScroll(g: Gesture) {
      const run = (scroller: HTMLElement | null, axis: Axis) => {
        if (!scroller) return;
        const whole = scroller === document.documentElement;
        const b = whole ? { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth } : scroller.getBoundingClientRect();
        const pos = axis === 'y' ? g.y : g.x;
        const lo = (axis === 'y' ? b.top : b.left) + EDGE_PX;
        const hi = (axis === 'y' ? b.bottom : b.right) - EDGE_PX;
        const delta = pos < lo ? -scrollStep((lo - pos) / EDGE_PX) : pos > hi ? scrollStep((pos - hi) / EDGE_PX) : 0;
        if (delta === 0) return;
        if (axis === 'y') scroller.scrollTop += delta;
        else scroller.scrollLeft += delta;
      };
      run(g.scrollY, 'y');
      run(g.scrollX, 'x');
    }

    function tick() {
      const g = gesture.current;
      if (!g?.active) return;
      autoScroll(g);

      // Keep the dragged item under the pointer, wherever its slot is right now.
      const r = g.el.getBoundingClientRect();
      const naturalLeft = r.left - g.tx + (r.width - g.el.offsetWidth) / 2;
      const naturalTop = r.top - g.ty + (r.height - g.el.offsetHeight) / 2;
      g.tx = g.x - g.grabX - naturalLeft;
      g.ty = g.y - g.grabY - naturalTop;
      g.el.style.transform = `translate3d(${g.tx}px, ${g.ty}px, 0) scale(1.05)`;

      // Move into the slot of whichever other item the pointer is over.
      const now = performance.now();
      if (now - g.lastSwap > SWAP_COOLDOWN_MS) {
        let target: number | null = null;
        for (const [id, el] of nodes.current) {
          if (id === g.id) continue;
          const b = el.getBoundingClientRect();
          if (g.x >= b.left && g.x <= b.right && g.y >= b.top && g.y <= b.bottom) {
            target = id;
            break;
          }
        }
        if (target !== null) {
          const from = g.order.indexOf(g.id);
          const to = g.order.indexOf(target);
          if (from >= 0 && to >= 0 && from !== to) {
            const next = g.order.slice();
            next.splice(from, 1);
            next.splice(to, 0, g.id);
            g.order = next;
            g.lastSwap = now;
            setOrder(next);
          }
        }
      }
      g.raf = requestAnimationFrame(tick);
    }

    function begin(g: Gesture) {
      if (gesture.current !== g || g.active) return;
      window.clearTimeout(g.timer);
      const r = g.el.getBoundingClientRect();
      g.grabX = g.x - r.left;
      g.grabY = g.y - r.top;
      g.active = true;
      g.order = latest.current.order.slice();
      g.scrollX = findScroller(g.el, 'x');
      g.scrollY = findScroller(g.el, 'y');
      const s = g.el.style;
      s.position = 'relative';
      s.zIndex = '50';
      s.transition = 'none';
      s.willChange = 'transform';
      s.filter = 'drop-shadow(0 14px 18px rgba(30, 41, 59, 0.28))';
      s.cursor = 'grabbing';
      navigator.vibrate?.(12);
      setDraggingId(g.id);
      g.raf = requestAnimationFrame(tick);
    }

    function stopListening() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    }

    function move(e: PointerEvent) {
      const g = gesture.current;
      if (!g || e.pointerId !== g.pointerId) return;
      g.x = e.clientX;
      g.y = e.clientY;
      if (g.active) {
        if (e.cancelable) e.preventDefault();
        return;
      }
      const distance = Math.hypot(g.x - g.startX, g.y - g.startY);
      if (g.pointerType === 'mouse') {
        if (distance > MOUSE_SLOP_PX) begin(g);
      } else if (distance > TOUCH_SLOP_PX) {
        // the finger moved before the hold finished: this is a scroll, not a drag
        window.clearTimeout(g.timer);
        gesture.current = null;
        stopListening();
      }
    }

    function end(e: PointerEvent) {
      const g = gesture.current;
      if (!g || e.pointerId !== g.pointerId) return;
      window.clearTimeout(g.timer);
      cancelAnimationFrame(g.raf);
      stopListening();
      gesture.current = null;
      if (!g.active) return;

      swallowClickUntil.current = performance.now() + 350; // the drop must not also count as a tap
      const s = g.el.style;
      s.transition = `transform ${SETTLE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1), filter ${SETTLE_MS}ms ease`;
      s.transform = '';
      s.filter = '';
      s.cursor = '';
      window.setTimeout(() => {
        s.position = '';
        s.zIndex = '';
        s.willChange = '';
        s.transition = '';
      }, SETTLE_MS + 40);
      setDraggingId(null);
      if (g.order.join(',') !== latest.current.ids.join(',')) latest.current.onReorder(g.order);
    }

    function start(id: number, e: ReactPointerEvent<HTMLElement>) {
      if (latest.current.disabled || gesture.current) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const el = nodes.current.get(id);
      if (!el) return;
      const g: Gesture = {
        id,
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        el,
        startX: e.clientX,
        startY: e.clientY,
        x: e.clientX,
        y: e.clientY,
        grabX: 0,
        grabY: 0,
        tx: 0,
        ty: 0,
        active: false,
        timer: 0,
        raf: 0,
        order: [],
        lastSwap: 0,
        scrollX: null,
        scrollY: null,
      };
      gesture.current = g;
      if (e.pointerType !== 'mouse') g.timer = window.setTimeout(() => begin(g), HOLD_MS);
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    }

    function destroy() {
      const g = gesture.current;
      if (g) {
        window.clearTimeout(g.timer);
        cancelAnimationFrame(g.raf);
      }
      stopListening();
    }

    return { start, destroy };
  }, []);

  useEffect(() => handlers.destroy, [handlers]);

  const containerRef = useCallback((el: HTMLElement | null) => {
    container.current = el;
  }, []);

  /** Props for the outer element of one item. */
  const itemProps = (id: number) => ({
    ref: (el: HTMLElement | null) => {
      if (el) nodes.current.set(id, el);
      else nodes.current.delete(id);
    },
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => handlers.start(id, e),
    onClickCapture: (e: ReactMouseEvent<HTMLElement>) => {
      if (performance.now() < swallowClickUntil.current) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    onContextMenu: (e: ReactMouseEvent<HTMLElement>) => {
      if (gesture.current) e.preventDefault(); // no "copy / save image" menu while a finger is holding an item
    },
    onDragStart: (e: React.DragEvent<HTMLElement>) => e.preventDefault(),
    className: 'select-none [-webkit-touch-callout:none]',
  });

  return { order: shown, draggingId, containerRef, itemProps };
}
