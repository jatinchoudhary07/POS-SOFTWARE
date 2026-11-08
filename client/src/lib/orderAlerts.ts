import { useSyncExternalStore } from 'react';

/**
 * Sound, vibration and system notifications for new / ready orders.
 *
 * Two clearly different sounds, so the people hearing them know at once what happened:
 *  - 'new'    (kitchen)   a loud triple BELL ring: an order, or more items, arrived.
 *  - 'ready'  (reception) a soft rising four-note MARIMBA run: the kitchen finished an order.
 *  - 'cancel' (kitchen)   two low falling buzzes: stop, the order was cancelled.
 *
 * Browsers only allow sound after a tap on the page, so the audio engine is unlocked by touches and
 * key presses (from the moment the app loads, including the sign-in tap) and re-woken on every later
 * one, because phones suspend it when the screen locks. System notifications additionally need the
 * user to allow them once.
 */

export type AlertKind = 'new' | 'ready' | 'cancel';

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

/** Creates the audio engine (inside a tap) and wakes it if the phone put it to sleep. Cheap to call again and again. */
export function unlockAudio() {
  try {
    // iPhone: play through the media channel, so the ring/silent switch does not mute the alerts.
    const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    if (session) session.type = 'playback';
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    if (!audio) {
      audio = new Ctx();
      // A one-sample silent sound inside the tap fully unlocks audio on iOS.
      const src = audio.createBufferSource();
      src.buffer = audio.createBuffer(1, 1, 22050);
      src.connect(audio.destination);
      src.start(0);
    }
    if (audio.state !== 'running') void audio.resume().catch(() => undefined);
  } catch {
    /* no audio available */
  }
}

// Wake the sound on any touch/key from the moment the app loads (the sign-in tap counts), and when the app is shown again.
if (typeof window !== 'undefined') {
  for (const type of ['pointerdown', 'touchend', 'click', 'keydown'] as const) {
    window.addEventListener(type, unlockAudio, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && unlockAudio());
}

type Ctx = BaseAudioContext;

/** One bell strike: a bright fundamental with the inharmonic overtones that make it sound metallic. */
function bell(ctx: Ctx, out: AudioNode, t: number, freq: number, volume: number) {
  const partials: [number, number, number][] = [
    [1, 1, 1.5],
    [2, 0.55, 1.0],
    [2.76, 0.4, 0.7],
    [5.4, 0.2, 0.4],
  ]; // [multiple of the pitch, loudness, ring time in seconds]
  for (const [mult, amp, ring] of partials) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq * mult;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume * amp, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + ring);
    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(t + ring + 0.05);
  }
}

/** One soft marimba-like note: a quick-fading triangle wave with a little octave on top. */
function pluck(ctx: Ctx, out: AudioNode, t: number, freq: number, volume: number) {
  for (const [mult, amp, ring] of [
    [1, 1, 0.5],
    [2, 0.25, 0.18],
  ] as const) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq * mult;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume * amp, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + ring);
    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(t + ring + 0.05);
  }
}

/** A dull low buzz for "stop". */
function buzzer(ctx: Ctx, out: AudioNode, t: number, freq: number, volume: number) {
  const osc = ctx.createOscillator();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.value = freq;
  filter.type = 'lowpass';
  filter.frequency.value = 900;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.02);
  gain.gain.setValueAtTime(volume, t + 0.28);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
  osc.connect(filter).connect(gain).connect(out);
  osc.start(t);
  osc.stop(t + 0.45);
}

/** Schedules the sound on any audio context (exported so it can also be rendered offline and measured). Returns its length in seconds. */
export function scheduleAlertSound(ctx: Ctx, kind: AlertKind, start: number): number {
  const master = ctx.createGain();
  master.gain.value = kind === 'new' ? 0.78 : 1; // the bell is the loudest, so it gets headroom to stay clean
  master.connect(ctx.destination);
  if (kind === 'new') {
    // loud triple ring, a kitchen bell: ding - ding - DING (higher)
    bell(ctx, master, start, 988, 0.5);
    bell(ctx, master, start + 0.34, 988, 0.5);
    bell(ctx, master, start + 0.68, 1319, 0.6);
    return 2.2;
  }
  if (kind === 'ready') {
    // gentle rising run on a marimba: C - E - G - C
    [523, 659, 784, 1047].forEach((f, i) => pluck(ctx, master, start + i * 0.12, f, 0.55));
    return 1.1;
  }
  buzzer(ctx, master, start, 330, 0.4);
  buzzer(ctx, master, start + 0.45, 247, 0.4);
  return 1;
}

/** Plays the sound for `kind`. If the browser has not been given a tap yet it stays silent (the toast still shows). */
export function chime(kind: AlertKind) {
  unlockAudio();
  const ctx = audio;
  if (!ctx) return;
  const play = () => {
    if (ctx.state === 'running') scheduleAlertSound(ctx, kind, ctx.currentTime + 0.03);
  };
  if (ctx.state === 'running') play();
  else void ctx.resume().then(play, () => undefined);
}

/** Vibration (Android): a different pattern for each alert, like the sounds. */
export const buzz = (kind: AlertKind = 'new') =>
  navigator.vibrate?.(kind === 'new' ? [320, 110, 320, 110, 520] : kind === 'ready' ? [90, 70, 90, 70, 160] : [700, 150, 300]);

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
