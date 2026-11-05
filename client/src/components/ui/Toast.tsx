import { CircleAlert, CircleCheck, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '../../lib/cx';

type Tone = 'success' | 'error';

export interface ToastInput {
  tone: Tone;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}

interface ToastItem extends ToastInput {
  id: number;
  leaving: boolean;
}

const DURATION: Record<Tone, number> = { success: 4500, error: 8000 };
const EXIT_MS = 160;

const ToastContext = createContext<((t: ToastInput) => void) | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

/**
 * Toasts float over the content (fixed position), so showing or hiding one never
 * shifts the layout. Bottom-left on tablets and PCs; under the header on phones, clear of
 * the bottom tab bar and the order bar. Errors stay longer than successes and use role="alert".
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    window.setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), EXIT_MS);
  }, []);

  const show = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      // Keep at most 3 on screen.
      setToasts((ts) => [...ts.slice(-2), { ...input, id, leaving: false }]);
      timers.current.set(id, window.setTimeout(() => dismiss(id), DURATION[input.tone]));
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => map.forEach((t) => window.clearTimeout(t));
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {/* Bottom-left and narrow: away from the order panel, Send/Confirm buttons and search. */}
      <div className="pointer-events-none fixed bottom-4 left-4 z-50 hidden md:flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((t) => {
          const Icon = t.tone === 'success' ? CircleCheck : CircleAlert;
          return (
            <div
              key={t.id}
              role={t.tone === 'error' ? 'alert' : 'status'}
              className={cx(
                'pointer-events-auto flex w-full items-start gap-3 rounded-card bg-surface/95 py-3 pr-2 pl-4 shadow-toast backdrop-blur-xl',
                t.leaving ? 'animate-toast-out' : 'animate-toast-in',
              )}
            >
              <Icon
                size={20}
                className={cx('mt-0.5 shrink-0', t.tone === 'success' ? 'text-success' : 'text-danger')}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-ink">{t.title}</p>
                {t.description && <p className="mt-0.5 text-sm text-ink-2">{t.description}</p>}
              </div>
              {t.action && (
                <button
                  type="button"
                  onClick={() => {
                    t.action!.onClick();
                    dismiss(t.id);
                  }}
                  className="h-9 shrink-0 rounded-control px-3 text-sm font-semibold text-accent transition-colors hover:bg-accent-tint"
                >
                  {t.action.label}
                </button>
              )}
              <button
                type="button"
                aria-label="Dismiss notification"
                onClick={() => dismiss(t.id)}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-fill hover:text-ink"
              >
                <X size={16} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
