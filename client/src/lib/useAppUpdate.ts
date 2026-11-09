import { useEffect } from 'react';

const CHECK_EVERY_MS = 3 * 60_000;
const FIRST_CHECK_MS = 20_000;
const MIN_GAP_BETWEEN_RELOADS_MS = 60_000;
const RELOAD_KEY = 'pos.updateReloadedAt';

/** The file name of the main script this page is running, e.g. /assets/index-C1R7Yn4k.js (none in development). */
const runningBundle = () => document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute('src') ?? null;

/** The main script the server would hand out right now. */
async function latestBundle(): Promise<string | null> {
  const res = await fetch('/', { cache: 'no-store', headers: { Accept: 'text/html' } });
  if (!res.ok) return null;
  const html = await res.text();
  return /<script[^>]+type="module"[^>]+src="([^"]*\/assets\/[^"]+\.js)"/.exec(html)?.[1] ?? null;
}

/** Never reload in the middle of typing, or on a payment screen. A reload is otherwise harmless: the unsent order is kept on the phone. */
const safeToReload = () => {
  const el = document.activeElement;
  const typing = el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
  return !typing && !window.location.pathname.startsWith('/checkout');
};

/**
 * Keeps every phone and computer on the newest version without anyone pressing "hard refresh".
 *
 * A phone that leaves the app open for days never loads a new version by itself. This checks quietly
 * (when the app is opened or comes back to the screen, and every few minutes) and, when the server has a
 * newer version, reloads the page at a safe moment. At most one reload a minute, so it can never loop.
 */
export function useAppUpdate() {
  useEffect(() => {
    const current = runningBundle();
    if (!current) return; // development server: nothing to compare
    let stopped = false;
    let outdated = false;

    const reloadIfSafe = () => {
      if (!outdated || stopped || !safeToReload()) return;
      try {
        const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
        if (Date.now() - last < MIN_GAP_BETWEEN_RELOADS_MS) return;
        sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
      } catch {
        /* storage blocked: the once-a-check cadence still keeps this from looping */
      }
      window.location.reload();
    };

    const check = async () => {
      if (stopped || document.visibilityState !== 'visible') return;
      try {
        const latest = await latestBundle();
        if (latest && latest !== current) outdated = true;
      } catch {
        /* offline or the server is restarting: try again later */
      }
      reloadIfSafe();
    };

    const first = window.setTimeout(() => void check(), FIRST_CHECK_MS);
    const timer = window.setInterval(() => void check(), CHECK_EVERY_MS);
    const onShow = () => void check();
    document.addEventListener('visibilitychange', onShow);
    window.addEventListener('online', onShow);
    // a newer version was found while the person was typing or paying: reload as soon as they are done
    const onIdle = () => window.setTimeout(reloadIfSafe, 1500);
    document.addEventListener('focusout', onIdle);
    return () => {
      stopped = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onShow);
      window.removeEventListener('online', onShow);
      document.removeEventListener('focusout', onIdle);
    };
  }, []);
}
