import { ArrowRight, ChefHat, CircleAlert, Clock, Eye, EyeOff, Heart, KeyRound, Loader2, Lock, MessageCircle, ReceiptText, User, UtensilsCrossed } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import { cx } from '../lib/cx';
import { useAuth } from '../state/Auth';

const RESTAURANT_NAME = import.meta.env.VITE_RESTAURANT_NAME || 'Two Hearts Cafe';

// Staff without a login message the owner on WhatsApp (country code + number, digits only).
const OWNER_WHATSAPP = import.meta.env.VITE_OWNER_WHATSAPP || '919929143867';
const LOGIN_REQUEST_MESSAGE = `Hello! I work at ${RESTAURANT_NAME} and need a login for the POS.

Name: 
Role (Reception / Kitchen): 

Please create my login. Thank you!`;
const OWNER_WHATSAPP_URL = `https://wa.me/${OWNER_WHATSAPP}?text=${encodeURIComponent(LOGIN_REQUEST_MESSAGE)}`;

// Fine film grain laid over the coloured header on phones.
const GRAIN =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .55 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")";

const desktopField =
  'h-13 w-full rounded-2xl border border-transparent bg-fill/70 pl-12 pr-12 text-[15px] font-medium text-ink placeholder:text-ink-3 ' +
  'outline-none transition focus:border-accent/60 focus:bg-white focus:ring-4 focus:ring-accent/15';
const phoneField =
  'h-14 w-full bg-[#f4f4f4] px-6 text-base font-medium text-ink placeholder:text-[#8b8b8b] outline-none transition ' +
  'focus:bg-[#ededed] focus:ring-2 focus:ring-[#e9724c]/40';

/** Two overlapping hearts: the cafe's mark. */
function HeartsMark({ className }: { className?: string }) {
  return (
    <span className={cx('relative flex items-center justify-center rounded-[26px] bg-white/20 shadow-xl ring-1 ring-white/40 backdrop-blur-md', className)}>
      <Heart size={34} fill="currentColor" strokeWidth={0} className="absolute -translate-x-3 -translate-y-1 -rotate-12 text-white/70" aria-hidden />
      <Heart size={38} fill="currentColor" strokeWidth={0} className="absolute translate-x-2.5 translate-y-1 rotate-12 text-white drop-shadow" aria-hidden />
    </span>
  );
}

/** True from tablet width up; the phone gets its own layout. */
function useIsDesktop() {
  const query = '(min-width: 768px)';
  const [match, setMatch] = useState(() => (typeof window === 'undefined' ? false : window.matchMedia(query).matches));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return match;
}

/**
 * Sign-in screen. There is deliberately no role picker: the server decides the role from the
 * account that signs in.
 */
export function LoginView({ reason }: { reason?: 'expired' | 'logged-out' }) {
  const { login } = useAuth();
  const isDesktop = useIsDesktop();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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

  const canSubmit = !busy && !!username.trim() && !!password;

  const notices = (
    <>
      {reason === 'expired' && (
        <p role="status" className="flex items-center gap-2 rounded-2xl bg-warning-tint px-4 py-3 text-sm font-medium text-warning">
          <Clock size={16} className="shrink-0" aria-hidden /> Your session ended. Please sign in again.
        </p>
      )}
      {setupRequired && (
        <p className="flex gap-2 rounded-2xl bg-accent-tint px-4 py-3 text-sm text-accent-hover">
          <KeyRound size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            No logins exist yet. On the reception computer, run <code className="font-semibold">npm run auth:setup</code> to create the
            Superadmin.
          </span>
        </p>
      )}
    </>
  );

  const errorBox = error && (
    <p role="alert" className="flex items-start gap-2 rounded-2xl bg-danger-tint px-4 py-3 text-sm font-medium text-danger">
      <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden /> {error}
    </p>
  );

  // ---------------------------------------------------------------- phone
  if (!isDesktop) {
    return (
      <div className="flex min-h-full flex-col bg-gradient-to-b from-[#ee7d52] to-[#e8634a]">
        <header className="relative flex min-h-[max(15.5rem,38svh)] shrink-0 flex-col items-center justify-center overflow-hidden px-6 pb-14 pt-10 text-center text-white">
          {/* soft shapes */}
          <span aria-hidden className="absolute -left-14 top-16 h-44 w-44 animate-float rounded-full bg-[#d8b768] motion-reduce:animate-none" />
          <span aria-hidden className="absolute -right-16 bottom-4 h-44 w-44 animate-float rounded-full bg-[#4fb98a] [animation-delay:-3s] motion-reduce:animate-none" />
          <span aria-hidden className="absolute inset-0 opacity-25 mix-blend-soft-light" style={{ backgroundImage: GRAIN }} />
          <HeartsMark className="relative h-20 w-20" />
          <h1 className="relative mt-4 text-[1.9rem] font-extrabold leading-tight tracking-tight">Welcome back</h1>
          <p className="relative mt-1 text-sm font-semibold text-white/85">{RESTAURANT_NAME}</p>
        </header>

        <main className="relative -mt-9 flex flex-1 animate-sheet-up flex-col rounded-t-[40px] bg-white px-6 pb-8 pt-8 shadow-[0_-10px_40px_-12px_rgba(90,30,10,0.35)]">
          <form onSubmit={submit} className="flex flex-1 flex-col">
            <div className="space-y-3">
              {notices}
              <label className="block">
                <span className="sr-only">Username</span>
                <input
                  autoFocus
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className={cx(phoneField, 'rounded-full')}
                />
              </label>
              <div className="flex gap-1.5">
                <label className="block flex-1">
                  <span className="sr-only">Password or PIN</span>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    placeholder="Password or PIN"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={cx(phoneField, 'rounded-l-full')}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="flex h-14 w-16 shrink-0 items-center justify-center rounded-r-full bg-[#f4f4f4] text-[#5b5b5b] transition active:bg-[#e6e6e6]"
                >
                  {showPassword ? <EyeOff size={20} aria-hidden /> : <Eye size={20} aria-hidden />}
                </button>
              </div>
              {errorBox}
            </div>

            <button
              type="submit"
              disabled={!canSubmit}
              className="mt-6 flex h-14 w-full items-center justify-center gap-2 rounded-full bg-black text-base font-bold text-white transition duration-150 active:scale-[0.985] disabled:opacity-35"
            >
              {busy ? <Loader2 size={20} className="animate-spin" aria-hidden /> : 'Sign in'}
            </button>

            <div className="mt-auto flex flex-col items-center gap-3 pt-8 text-center">
              <p className="text-[13px] leading-relaxed text-[#6b6b6b]">Don't have a login yet?</p>
              <a
                href={OWNER_WHATSAPP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-12 items-center gap-2 rounded-full border border-[#d9d9d9] px-6 text-[15px] font-semibold text-black transition active:scale-[0.98] active:bg-[#f4f4f4]"
              >
                <MessageCircle size={18} className="text-[#25a244]" aria-hidden /> Ask the owner on WhatsApp
              </a>
            </div>
          </form>
        </main>
      </div>
    );
  }

  // -------------------------------------------------------------- desktop
  return (
    <div className="relative flex min-h-full overflow-hidden bg-gradient-to-br from-[#ffb36b] via-[#ff7a45] to-[#e8345f]">
      {/* soft light shapes drifting in the background */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <span className="absolute -left-24 -top-24 h-80 w-80 animate-float rounded-full bg-white/25 blur-3xl motion-reduce:animate-none" />
        <span className="absolute -bottom-32 right-[-6rem] h-96 w-96 animate-float rounded-full bg-[#ffd27a]/40 blur-3xl [animation-delay:-3s] motion-reduce:animate-none" />
        <span className="absolute left-1/2 top-1/3 h-56 w-56 animate-float rounded-full bg-[#ff3d7f]/30 blur-3xl [animation-delay:-5s] motion-reduce:animate-none" />
        <Heart size={64} fill="currentColor" strokeWidth={0} className="absolute left-[8%] top-[62%] rotate-[-14deg] text-white/10" />
        <Heart size={96} fill="currentColor" strokeWidth={0} className="absolute right-[10%] top-[10%] rotate-[16deg] text-white/10" />
      </div>

      <main className="relative mx-auto my-auto flex w-full max-w-5xl items-center justify-between gap-16 px-5 py-10">
        {/* brand */}
        <section className="flex max-w-sm animate-enter flex-col items-start text-left text-white">
          <HeartsMark className="h-20 w-20" />
          <h1 className="mt-5 text-5xl font-extrabold leading-tight tracking-tight drop-shadow-sm">{RESTAURANT_NAME}</h1>
          <p className="mt-4 text-lg font-medium text-white/85">Every order, every table, every payment — in one place.</p>
          <ul className="mt-6 flex flex-wrap gap-2">
            {[
              [UtensilsCrossed, 'Orders'],
              [ChefHat, 'Kitchen'],
              [ReceiptText, 'Billing'],
            ].map(([Icon, label]) => {
              const I = Icon as typeof UtensilsCrossed;
              return (
                <li key={label as string} className="flex items-center gap-1.5 rounded-full bg-white/15 px-3.5 py-1.5 text-sm font-semibold ring-1 ring-white/25 backdrop-blur">
                  <I size={15} aria-hidden /> {label as string}
                </li>
              );
            })}
          </ul>
        </section>

        {/* sign-in card */}
        <section className="w-full max-w-sm animate-card-rise">
          <form
            onSubmit={submit}
            className="space-y-5 rounded-[28px] bg-white/90 p-7 shadow-[0_30px_70px_-20px_rgba(120,20,40,0.55)] ring-1 ring-white/60 backdrop-blur-xl"
          >
            <div>
              <h2 className="text-2xl font-extrabold tracking-tight text-ink">Welcome back</h2>
              <p className="mt-1 text-sm font-medium text-ink-2">Sign in to start your shift</p>
            </div>
            {notices}

            <label className="block">
              <span className="mb-1.5 block text-[13px] font-semibold text-ink-2">Username</span>
              <span className="relative block">
                <User size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
                <input
                  autoFocus
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="Your username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className={desktopField}
                />
              </span>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-[13px] font-semibold text-ink-2">Password or PIN</span>
              <span className="relative block">
                <Lock size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
                <input
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={desktopField}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-xl text-ink-3 transition hover:bg-fill hover:text-ink"
                >
                  {showPassword ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
                </button>
              </span>
            </label>

            {errorBox}

            <button
              type="submit"
              disabled={!canSubmit}
              className={cx(
                'group flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-base font-bold text-white transition duration-200',
                canSubmit
                  ? 'bg-gradient-to-r from-[#ff8548] to-[#f43f5e] shadow-[0_14px_30px_-10px_rgba(244,63,94,0.75)] hover:-translate-y-0.5 hover:shadow-[0_18px_34px_-10px_rgba(244,63,94,0.85)] active:translate-y-0 active:scale-[0.99]'
                  : 'cursor-not-allowed bg-fill-strong text-ink-3',
              )}
            >
              {busy ? (
                <Loader2 size={20} className="animate-spin" aria-hidden />
              ) : (
                <>
                  Sign in <ArrowRight size={19} className="transition group-enabled:group-hover:translate-x-1" aria-hidden />
                </>
              )}
            </button>
          </form>
          <p className="mt-5 text-center text-sm font-medium text-white/90">
            No login yet?{' '}
            <a href={OWNER_WHATSAPP_URL} target="_blank" rel="noopener noreferrer" className="font-bold underline underline-offset-4">
              Ask the owner on WhatsApp
            </a>
          </p>
          <p className="mt-3 text-center text-xs font-medium text-white/80">
            Made with <Heart size={11} fill="currentColor" strokeWidth={0} className="inline -translate-y-px" aria-hidden /> for {RESTAURANT_NAME}
          </p>
        </section>
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
