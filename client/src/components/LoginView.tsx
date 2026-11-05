import { ChefHat, CircleAlert, Clock, KeyRound, Loader2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import { cx } from '../lib/cx';
import { useAuth } from '../state/Auth';
import { Button } from './ui/Button';
import { inputClass, labelClass } from './ui/fields';

const RESTAURANT_NAME = import.meta.env.VITE_RESTAURANT_NAME || 'Two Hearts Cafe';

/**
 * Sign-in screen. There is deliberately no role picker: the server decides the role from the
 * account that signs in.
 */
export function LoginView({ reason }: { reason?: 'expired' | 'logged-out' }) {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [setupRequired, setSetupRequired] = useState(false);

  useEffect(() => {
    api
      .authStatus()
      .then((s) => setSetupRequired(s.setupRequired))
      .catch(() => {});
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      // The app now renders the right landing screen for this login.
    } catch (err) {
      setPassword('');
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <main className="w-full max-w-sm animate-enter">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-[20px] bg-[#ff8548] text-white shadow-md shadow-[#ff8548]/30">
            <ChefHat size={32} aria-hidden />
          </span>
          <h1 className="mt-4 text-2xl font-bold tracking-tight text-ink">{RESTAURANT_NAME}</h1>
          <p className="mt-1 text-sm font-medium text-ink-2">Sign in to continue</p>
        </div>

        {reason === 'expired' && (
          <p role="status" className="mb-4 flex items-center gap-2 rounded-control bg-warning-tint px-4 py-3 text-sm text-warning">
            <Clock size={16} className="shrink-0" aria-hidden /> Your session ended. Please sign in again.
          </p>
        )}
        {setupRequired && (
          <p className="mb-4 flex gap-2 rounded-control bg-accent-tint px-4 py-3 text-sm text-accent-hover">
            <KeyRound size={16} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              No logins exist yet. On the reception computer, run <code className="font-semibold">npm run auth:setup</code> to create the
              Superadmin.
            </span>
          </p>
        )}

        <form onSubmit={submit} className="space-y-4 rounded-card bg-surface p-6 shadow-card">
          <label className="block">
            <span className={labelClass}>Username</span>
            <input
              autoFocus
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className={cx(inputClass, 'h-12')}
            />
          </label>
          <label className="block">
            <span className={labelClass}>Password or PIN</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={cx(inputClass, 'h-12')}
            />
          </label>
          {error && (
            <p role="alert" className="flex items-start gap-2 text-sm font-medium text-danger">
              <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden /> {error}
            </p>
          )}
          <Button type="submit" size="lg" variant="primary" loading={busy} disabled={busy || !username.trim() || !password} className="w-full">
            Sign in
          </Button>
        </form>
      </main>
    </div>
  );
}

export function FullScreenLoading() {
  return (
    <div className="flex h-full items-center justify-center text-ink-2">
      <Loader2 size={22} className="animate-spin" aria-label="Loading" />
    </div>
  );
}
