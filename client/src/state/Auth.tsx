import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, setUnauthenticatedHandler } from '../api/client';
import type { User } from '../api/types';
import { LANDING_PATH } from './permissions';

type AuthState =
  | { status: 'loading' }
  | { status: 'signed-out'; reason?: 'expired' | 'logged-out' }
  | { status: 'signed-in'; user: User };

interface AuthValue {
  state: AuthState;
  login: (username: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
  /** Called when the server rejects the session (expired, revoked). */
  expire: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** The signed-in user. Only use inside screens rendered after login. */
export function useUser(): User {
  const { state } = useAuth();
  if (state.status !== 'signed-in') throw new Error('Not signed in');
  return state.user;
}

/**
 * Who is signed in, as reported by the server (GET /api/auth/me). The session itself is an
 * HttpOnly cookie that page scripts cannot read; the role always comes from the server.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    api
      .me()
      .then(({ user }) => setState({ status: 'signed-in', user }))
      .catch(() => setState({ status: 'signed-out' }));
  }, []);

  const expire = useCallback(() => {
    setState((s) => (s.status === 'signed-in' ? { status: 'signed-out', reason: 'expired' } : s));
  }, []);

  // Any API call answered with 401 (session expired or revoked) returns to the login screen.
  useEffect(() => {
    setUnauthenticatedHandler(expire);
    return () => setUnauthenticatedHandler(null);
  }, [expire]);

  const login = useCallback(async (username: string, password: string) => {
    const { user } = await api.login(username, password);
    // A fresh sign-in always starts on the login's landing screen (a reload keeps the URL).
    window.history.replaceState(null, '', LANDING_PATH[user.role]);
    setState({ status: 'signed-in', user });
    return user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
    }
    setState({ status: 'signed-out', reason: 'logged-out' });
  }, []);

  const value = useMemo(() => ({ state, login, logout, expire }), [state, login, logout, expire]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
