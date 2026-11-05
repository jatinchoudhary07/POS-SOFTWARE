import { useEffect, useRef, useState } from 'react';

/** Eases a number from its last shown value to `target` (starts at 0 on first render). */
export function useCountUp(target: number, duration = 900) {
  const [value, setValue] = useState(0);
  const shown = useRef(0);

  useEffect(() => {
    const from = shown.current;
    if (from === target) return;
    let frame = 0;
    let start: number | null = null;
    const step = (now: number) => {
      start ??= now;
      const t = Math.min((now - start) / duration, 1);
      const next = t === 1 ? target : from + (target - from) * (1 - Math.pow(1 - t, 3));
      shown.current = next;
      setValue(next);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);

  return value;
}
