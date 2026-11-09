import { Router, type CookieOptions, type Request } from 'express';
import { z } from 'zod';
import { USER_ROLES } from '../db/schema';
import { requireRole, requireSession, sessionToken } from '../lib/auth';
import { SESSION_COOKIE } from '../lib/cookies';
import { MAX_PASSWORD_LENGTH } from '../lib/password';
import { LOGIN_NAME_MESSAGE, LOGIN_NAME_PATTERN, type AuthService } from '../services/authService';

// Username + password only. There is deliberately no "role" field: the role comes from the account.
/** Browsers cap a cookie's life at about 400 days, so that is the longest we ask for. */
const COOKIE_LIFETIME_MS = 400 * 24 * 60 * 60_000;

const loginSchema = z
  .object({
    username: z.string().trim().min(1, 'Enter your username').max(64),
    password: z.string().min(1, 'Enter your password').max(MAX_PASSWORD_LENGTH),
  })
  .strict();

const loginName = z.string().trim().regex(LOGIN_NAME_PATTERN, LOGIN_NAME_MESSAGE);
const currentPassword = z.string().min(1, 'Enter your current password to confirm').max(MAX_PASSWORD_LENGTH);

const createAccountSchema = z
  .object({
    role: z.enum(USER_ROLES),
    username: loginName,
    password: z.string().min(1, 'Enter a password').max(MAX_PASSWORD_LENGTH),
  })
  .strict();

const updateAccountSchema = z
  .object({
    username: loginName.optional(),
    password: z.string().max(MAX_PASSWORD_LENGTH).optional(),
    role: z.enum(USER_ROLES).optional(),
    isActive: z.boolean().optional(),
    currentPassword,
  })
  .strict()
  .refine((v) => v.username !== undefined || v.password !== undefined || v.role !== undefined || v.isActive !== undefined, 'Nothing to change');

const deleteAccountSchema = z.object({ currentPassword }).strict();
const idParam = z.coerce.number().int().positive();

export interface AuthRouterOptions {
  /** 'auto' = Secure cookie only when the request arrived over HTTPS. */
  cookieSecure: 'auto' | boolean;
}

export function authRouter(auth: AuthService, opts: AuthRouterOptions): Router {
  const router = Router();

  const cookieOptions = (req: Request, expires?: Date): CookieOptions => ({
    httpOnly: true, // not readable by page scripts
    sameSite: 'strict', // not sent on requests started by other websites
    secure: opts.cookieSecure === 'auto' ? req.secure : opts.cookieSecure,
    path: '/',
    ...(expires ? { expires } : {}),
  });

  // Public: lets the login page say "no accounts yet — run the setup command".
  router.get('/status', (_req, res) => {
    res.json({ setupRequired: !auth.hasSuperadmin() });
  });

  router.post('/login', async (req, res) => {
    const { username, password } = loginSchema.parse(req.body);
    const { token, session } = await auth.login(username, password, req.socket.remoteAddress ?? 'unknown');
    // A long-lived cookie (not a browser "session" cookie that a phone may drop when the app is closed), so the
    // person stays signed in until they sign out. The server still enforces its own limits, if any are configured.
    res.cookie(SESSION_COOKIE, token, cookieOptions(req, new Date(Date.now() + COOKIE_LIFETIME_MS)));
    res.json({ user: session.user, expiresAt: session.expiresAt.toISOString() });
  });

  router.post('/logout', (req, res) => {
    const session = auth.validate(sessionToken(req));
    if (session) auth.logout(session.sessionId);
    res.clearCookie(SESSION_COOKIE, cookieOptions(req));
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    const s = requireSession(res);
    // Every time the app is opened the cookie's life starts over.
    res.cookie(SESSION_COOKIE, sessionToken(req)!, cookieOptions(req, new Date(Date.now() + COOKIE_LIFETIME_MS)));
    res.json({ user: s.user, expiresAt: s.expiresAt.toISOString() });
  });

  // Superadmin: manage logins (any number per role).
  router.get('/accounts', requireRole('SUPERADMIN'), (_req, res) => {
    res.json({ accounts: auth.listAccounts() });
  });

  router.post('/accounts', requireRole('SUPERADMIN'), async (req, res) => {
    const input = createAccountSchema.parse(req.body);
    const account = await auth.createAccount(requireSession(res), input);
    res.status(201).json({ account, accounts: auth.listAccounts() });
  });

  router.put('/accounts/:id', requireRole('SUPERADMIN'), async (req, res) => {
    const input = updateAccountSchema.parse(req.body);
    const account = await auth.updateAccount(requireSession(res), idParam.parse(req.params.id), input);
    res.json({ account, accounts: auth.listAccounts() });
  });

  router.delete('/accounts/:id', requireRole('SUPERADMIN'), async (req, res) => {
    const { currentPassword: pw } = deleteAccountSchema.parse(req.body);
    await auth.deleteAccount(requireSession(res), idParam.parse(req.params.id), pw);
    res.json({ accounts: auth.listAccounts() });
  });

  return router;
}
