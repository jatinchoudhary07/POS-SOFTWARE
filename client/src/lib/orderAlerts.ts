import { useSyncExternalStore } from 'react';

/**
 * Sound, vibration and system notifications for new / ready orders.
 * Browsers only allow sound after a tap on the page, so the audio engine is unlocked by the first
 * touch or key press; system notifications additionally need the user to allow them once.
 */

const KEY = 'orderAlertsOn';
const listeners = new Set<() => void>();
let audio: AudioContext | null = null;

export function alertsEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

export function setAlertsEnabled(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* private mode: the choice just isn't remembered */
  }
  listeners.forEach((fn) => fn());
}

const subscribeAlerts = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const useAlertsEnabled = () => useSyncExternalStore(subscribeAlerts, alertsEnabled, () => true);

export function unlockAudio() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audio ??= new Ctx();
    if (audio.state === 'suspended') void audio.resume();
  } catch {
    /* no audio available */
  }
}

/** A short chime: three rising notes for a new order, two for "ready". */
export function chime(kind: 'new' | 'ready') {
  if (!audio || audio.state !== 'running') return;
  const notes = kind === 'new' ? [784, 988, 1319] : [988, 1319];
  const t0 = audio.currentTime + 0.02;
  notes.forEach((freq, i) => {
    const osc = audio!.createOscillator();
    const gain = audio!.createGain();
    const start = t0 + i * 0.16;
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.35, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
    osc.connect(gain).connect(audio!.destination);
    osc.start(start);
    osc.stop(start + 0.32);
  });
}

export const buzz = () => navigator.vibrate?.([220, 90, 220]);

export const canNotifyOutsidePage = () => typeof Notification !== 'undefined';

export async function askNotificationPermission() {
  if (typeof Notification === 'undefined' || Notification.permission !== 'default') return;
  try {
    await Notification.requestPermission();
  } catch {
    /* unsupported or blocked */
  }
}

/** A system notification, only while this tab is in the background (the page itself shows a toast otherwise). */
export function systemNotify(title: string, body: string, tag: string) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
  try {
    const n = new Notification(title, { body, tag, icon: '/favicon.ico' });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* some mobile browsers only allow notifications through a service worker */
  }
}
