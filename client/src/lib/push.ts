import { api } from '../api/client';

/**
 * Alerts that reach this phone while its screen is locked or the app is in the background (Web Push).
 *
 * - Android Chrome: works in the browser, no install needed.
 * - iPhone: only works once the app is added to the Home Screen and opened from there (an Apple rule).
 * The phone plays its own normal notification sound for these; the bell / marimba sounds play while the app is open.
 */

export type PushState =
  | 'unsupported' // this browser cannot do it at all
  | 'needs-install' // iPhone / iPad in Safari: add to the Home Screen first
  | 'server-off' // the server has no keys set up
  | 'blocked' // the person said "don't allow"
  | 'off' // possible, not turned on yet
  | 'on';

const hasPushApis = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isApple = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isInstalledApp = () => (navigator as unknown as { standalone?: boolean }).standalone === true || window.matchMedia('(display-mode: standalone)').matches;

/** Registers the small background worker that shows the alerts. Safe to call on every start. */
export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch {
    /* no worker (private mode, old browser): the in-app alerts still work */
  }
}

function keyBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const raw = atob((base64Url + '='.repeat((4 - (base64Url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function currentSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return { reg, sub: await reg.pushManager.getSubscription() };
}

/** What can be done on this phone right now. */
export async function getPushState(): Promise<PushState> {
  if (!hasPushApis()) return isApple() && !isInstalledApp() ? 'needs-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  try {
    const key = await api.pushKey();
    if (!key.enabled) return 'server-off';
    const { sub } = await currentSubscription();
    return sub && Notification.permission === 'granted' ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

async function subscribeAndSave(publicKey: string) {
  const { reg, sub: existing } = await currentSubscription();
  const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  await api.pushSubscribe(sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } });
}

/** Turns alerts for a locked phone on. Must be called from a tap (the phone asks for permission). */
export async function enablePush(): Promise<PushState> {
  if (!hasPushApis()) return getPushState();
  if (Notification.permission === 'default') await Notification.requestPermission();
  if (Notification.permission !== 'granted') return getPushState();
  const key = await api.pushKey();
  if (!key.enabled) return 'server-off';
  await subscribeAndSave(key.publicKey);
  return 'on';
}

/**
 * On every start while signed in and not muted: if the person already allowed notifications, make sure this
 * phone is registered to the current sign-in (renews it, and moves it over if a different login is now using the phone).
 */
export async function refreshPush() {
  if (!hasPushApis() || Notification.permission !== 'granted') return;
  try {
    const key = await api.pushKey();
    if (key.enabled) await subscribeAndSave(key.publicKey);
  } catch {
    /* offline: try again next time */
  }
}

/** Mute: this phone stops getting alerts while locked. */
export async function disablePush() {
  if (!hasPushApis()) return;
  try {
    const { sub } = await currentSubscription();
    if (!sub) return;
    await api.pushUnsubscribe(sub.endpoint).catch(() => undefined);
    await sub.unsubscribe();
  } catch {
    /* already gone */
  }
}
