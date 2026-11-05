import type { Request, RequestHandler, Response } from 'express';
import type { UserRole } from '../db/schema';
import type { AuthService, AuthSession } from '../services/authService';
import { parseCookies, SESSION_COOKIE } from './cookies';
import { AppError } from './errors';

/**
 * Who is calling. Set ONLY from the server-side session found via the HttpOnly cookie —
 * never from anything in the request body, query or custom headers.
 */
export const currentSession = (res: Response): AuthSession | null => (res.locals.auth as AuthSession | undefined) ?? null;

export function sessionToken(req: Request): string | undefined {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE];
}

export function loadSession(auth: AuthService): RequestHandler {
  return (req, res, next) => {
    res.locals.auth = auth.validate(sessionToken(req));
    next();
  };
}

/** 401 without a valid session; 403 if the account's role isn't in `roles`. */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (_req, res, next) => {
    const s = currentSession(res);
    if (!s) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in');
    if (!roles.includes(s.user.role)) throw new AppError(403, 'FORBIDDEN', "Your login doesn't have permission to do that");
    next();
  };
}

export function requireSession(res: Response): AuthSession {
  const s = currentSession(res);
  if (!s) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in');
  return s;
}

/**
 * Defence in depth against cross-site requests (on top of SameSite=Strict cookies): a browser
 * request that changes data must come from this server's own origin or a listed CORS origin.
 */
export function sameOriginWrites(allowedOrigins: string[]): RequestHandler {
  return (req, _res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const origin = req.get('origin');
    if (!origin || allowedOrigins.includes(origin)) return next();
    try {
      const originHost = new URL(origin).host;
      if (originHost === req.get('host')) return next();
      const fwdHost = req.get('x-forwarded-host')?.split(',')[0].trim();
      if (fwdHost && originHost === fwdHost) return next();
    } catch {
      /* fall through */
    }
    throw new AppError(403, 'BAD_ORIGIN', 'Request from another website was blocked');
  };
}
