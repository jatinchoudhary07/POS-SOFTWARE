import { BellRing, CircleAlert, CircleCheck, Share, SquarePlus, Volume2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { cx } from '../lib/cx';
import { chime, setAlertsEnabled, unlockAudio, useAlertsEnabled } from '../lib/orderAlerts';
import { disablePush, enablePush, getPushState, refreshPush, type PushState } from '../lib/push';
import { useUser } from '../state/Auth';
import { BottomSheet } from './ui/BottomSheet';
import { Button } from './ui/Button';

/** Reads the current lock-screen alert state, and lets the caller re-read it after an action. */
export function usePushState() {
  const [state, setState] = useState<PushState | null>(null);
  const reload = useCallback(() => getPushState().then(setState), []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return [state, reload, setState] as const;
}

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5 rounded-2xl bg-subtle p-4 ring-1 ring-line">
      <h4 className="flex items-center gap-2 text-sm font-bold">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-tint text-accent">{icon}</span>
        {title}
      </h4>
      {children}
    </section>
  );
}

function Steps({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="space-y-2 text-sm text-ink-2">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2.5">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-fill-strong text-[11px] font-bold text-ink">{i + 1}</span>
          <span className="min-w-0">{it}</span>
        </li>
      ))}
    </ol>
  );
}

/** What to do (or what is happening) for alerts while the phone is locked, depending on the phone. */
function LockScreenAlerts({ state, onChange, reload }: { state: PushState | null; onChange: (s: PushState) => void; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function turnOn() {
    setBusy(true);
    setNote(null);
    try {
      onChange(await enablePush());
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'Could not turn it on. Please try again.');
      reload();
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.pushTest();
      setNote(r.sentTo > 0 ? 'Sent. Lock your phone now: the alert should arrive in a few seconds.' : 'This phone is not registered yet. Turn the alerts on first.');
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'Could not send the test.');
    } finally {
      setBusy(false);
    }
  }

  if (state === null) return <p className="text-sm text-ink-2">Checking…</p>;
  switch (state) {
    case 'on':
      return (
        <>
          <p className="flex items-start gap-2 text-sm font-medium text-success-hover">
            <CircleCheck size={16} className="mt-0.5 shrink-0" aria-hidden /> On. You get a notification even when the screen is locked or the app is closed. The phone plays its usual notification sound.
          </p>
          <Button variant="secondary" size="sm" loading={busy} onClick={() => void test()}>
            Send me a test alert
          </Button>
          {note && <p className="text-xs font-medium text-ink-2">{note}</p>}
        </>
      );
    case 'off':
      return (
        <>
          <p className="text-sm text-ink-2">Not on yet. Turn it on to be told about orders even when this phone is locked or the app is closed.</p>
          <Button variant="primary" size="sm" icon={BellRing} loading={busy} onClick={() => void turnOn()}>
            Turn on
          </Button>
          {note && <p className="text-xs font-medium text-danger">{note}</p>}
        </>
      );
    case 'blocked':
      return (
        <p className="flex items-start gap-2 text-sm text-ink-2">
          <CircleAlert size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
          <span>
            Notifications are blocked for this app. Open the phone’s <strong>Settings → Notifications → Two Hearts</strong> (or the browser’s site settings), allow them, then come back here.
          </span>
        </p>
      );
    case 'needs-install':
      return (
        <>
          <p className="text-sm text-ink-2">On an iPhone, alerts for a locked phone work only once this app is added to the Home Screen:</p>
          <Steps
            items={[
              <>
                Tap the <Share size={14} className="mx-0.5 inline -translate-y-px" aria-hidden /> <strong>Share</strong> button in Safari.
              </>,
              <>
                Choose <SquarePlus size={14} className="mx-0.5 inline -translate-y-px" aria-hidden /> <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
              </>,
              <>
                Open <strong>Two Hearts</strong> from the Home Screen, sign in, and come back to this panel to turn the alerts on.
              </>,
            ]}
          />
        </>
      );
    case 'server-off':
      return <p className="text-sm text-ink-2">Alerts for a locked phone are not switched on at the server yet. Ask whoever looks after the server.</p>;
    default:
      return <p className="text-sm text-ink-2">This browser can’t show alerts when the phone is locked. On Android use Chrome; on an iPhone use Safari and add the app to the Home Screen.</p>;
  }
}

/** The panel behind the bell: mute, hear the sound, and set up alerts for a locked phone. */
export function AlertsSheet({ onClose }: { onClose: () => void }) {
  const enabled = useAlertsEnabled();
  const { role } = useUser();
  const [state, reload, setState] = usePushState();
  const kitchen = role === 'KITCHEN';

  function toggle() {
    const next = !enabled;
    setAlertsEnabled(next);
    if (next) {
      unlockAudio();
      chime(kitchen ? 'new' : 'ready');
      void refreshPush().then(reload);
    } else {
      void disablePush().then(reload);
    }
  }

  return (
    <BottomSheet title="Order alerts" onClose={onClose}>
      <div className="space-y-4 pt-1">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={toggle}
          className={cx('flex w-full items-center justify-between gap-3 rounded-2xl px-4 py-3.5 text-left transition-all active:scale-[0.98]', enabled ? 'bg-success-tint' : 'bg-fill')}
        >
          <span>
            <span className="block text-[15px] font-bold">{enabled ? 'Alerts on' : 'Muted'}</span>
            <span className="block text-xs text-ink-2">{enabled ? (kitchen ? 'You are told about every new order.' : 'You are told when the kitchen has an order ready.') : 'No sounds and no notifications on this phone.'}</span>
          </span>
          <span className={cx('relative h-7 w-12 shrink-0 rounded-full transition-colors', enabled ? 'bg-success' : 'bg-line-strong')} aria-hidden>
            <span className={cx('absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all', enabled ? 'left-[22px]' : 'left-0.5')} />
          </span>
        </button>

        {enabled && (
          <>
            <Card icon={<Volume2 size={15} aria-hidden />} title="While the app is open">
              <p className="text-sm text-ink-2">
                {kitchen ? 'A loud bell rings when a new order, or more items, arrive. A low buzz means an order was cancelled.' : 'A soft marimba tune plays when the kitchen marks an order ready.'}
              </p>
              <Button variant="secondary" size="sm" icon={Volume2} onClick={() => (unlockAudio(), chime(kitchen ? 'new' : 'ready'))}>
                Play the sound
              </Button>
            </Card>

            <Card icon={<BellRing size={15} aria-hidden />} title="When the phone is locked or the app is closed">
              <LockScreenAlerts state={state} onChange={setState} reload={() => void reload()} />
            </Card>
          </>
        )}

        <p className="px-1 text-xs leading-relaxed text-ink-3">Signing out stops all alerts on this phone. Alerts are never sent to a login that has been signed out.</p>
      </div>
    </BottomSheet>
  );
}

const DISMISSED = 'pushPromptDismissed';
const dismissed = () => {
  try {
    return localStorage.getItem(DISMISSED) === '1';
  } catch {
    return false;
  }
};

/** A small, dismissible reminder to turn on alerts for a locked phone (shown until it is on, blocked, or dismissed). */
export function PushPrompt() {
  const enabled = useAlertsEnabled();
  const [state, reload, setState] = usePushState();
  const [hidden, setHidden] = useState(dismissed);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!enabled || hidden || (state !== 'off' && state !== 'needs-install')) return open ? <AlertsSheet onClose={() => (setOpen(false), void reload())} /> : null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED, '1');
    } catch {
      /* not remembered */
    }
    setHidden(true);
  };

  return (
    <>
      <div role="region" aria-label="Alerts for a locked phone" className="fixed inset-x-3 bottom-[5.75rem] z-40 mx-auto flex max-w-md animate-card-rise items-center gap-3 rounded-2xl bg-ink px-3.5 py-3 text-white shadow-toast md:bottom-6">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15">
          <BellRing size={18} aria-hidden />
        </span>
        <p className="min-w-0 flex-1 text-[13px] leading-snug">{state === 'off' ? 'Get order alerts even when your phone is locked.' : 'Add this app to your Home Screen to get alerts when your phone is locked.'}</p>
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          onClick={async () => {
            if (state === 'needs-install') return setOpen(true);
            setBusy(true);
            try {
              setState(await enablePush());
            } catch {
              setOpen(true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {state === 'off' ? 'Turn on' : 'How'}
        </Button>
        <button type="button" aria-label="Not now" onClick={dismiss} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white">
          <X size={16} aria-hidden />
        </button>
      </div>
      {open && <AlertsSheet onClose={() => (setOpen(false), void reload())} />}
    </>
  );
}
