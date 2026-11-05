import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, gt, lt, ne, or, sql } from 'drizzle-orm';
import type { DB } from '../db/client';
import { sessions, users, USER_ROLES, type UserRole } from '../db/schema';
import type { EventBus } from '../events';
import { AppError } from '../lib/errors';
import { LoginLimiter } from '../lib/loginLimiter';
import { getDummyHash, hashPassword, verifyPassword } from '../lib/password';

export interface AuthUser {
  id: number;
  username: string;
  role: UserRole;
}

export interface AuthSession {
  user: AuthUser;
  /** SHA-256 of the cookie token (the DB key). */
  sessionId: string;
  expiresAt: Date;
}

export interface LoginAccountDTO {
  id: number;
  role: UserRole;
  username: string;
  isActive: boolean;
  passwordChangedAt: string;
  createdAt: string;
}

export interface AuthServiceOptions {
  /** Sliding inactivity timeout. */
  idleMs?: number;
  /** Hard limit regardless of activity. */
  maxMs?: number;
  now?: () => Date;
  /** Failures per username (default 5 per 15 min). */
  limiter?: LoginLimiter;
  /** Failures per client IP (default 20 per 15 min — looser, so one person can't lock out a shared PC). */
  ipLimiter?: LoginLimiter;
}

/** A login name: plain username, email address or mobile number (digits, optional leading +). */
export const LOGIN_NAME_PATTERN = /^[A-Za-z0-9._@+-]{3,64}$/;
export const LOGIN_NAME_MESSAGE = 'Enter a username, email address or mobile number (3–64 letters, digits, and . _ @ + -)';

export const MIN_PASSWORD_LENGTH: Record<UserRole, number> = { SUPERADMIN: 6, RECEPTION: 6, KITCHEN: 6 };

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
// Only write last-seen/expiry back to the DB once per minute per session (cheap sliding expiry).
const TOUCH_INTERVAL_MS = 60_000;

/** One message for every login failure, so it never reveals whether the username exists. */
const BAD_LOGIN = () => new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect username or password');

export function createAuthService(db: DB, events: EventBus, opts: AuthServiceOptions = {}) {
  const now = opts.now ?? (() => new Date());
  const idleMs = opts.idleMs ?? 12 * 60 * 60_000;
  const maxMs = opts.maxMs ?? 7 * 24 * 60 * 60_000;
  const limiter = opts.limiter ?? new LoginLimiter({ maxFailures: 5, now: () => now().getTime() });
  const ipLimiter = opts.ipLimiter ?? new LoginLimiter({ maxFailures: 20, now: () => now().getTime() });

  const findByUsername = (username: string) =>
    db.select().from(users).where(sql`lower(${users.username}) = lower(${username})`).get();

  function revokeSessions(userId: number, keepSessionId?: string) {
    db.delete(sessions)
      .where(keepSessionId ? and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)) : eq(sessions.userId, userId))
      .run();
    // Lets the realtime layer disconnect that user's live screens.
    events.emit('auth.revoked', { userId, keepSessionId });
  }

  const toDTO = (u: typeof users.$inferSelect): LoginAccountDTO => ({
    id: u.id,
    role: u.role,
    username: u.username,
    isActive: u.isActive,
    passwordChangedAt: u.passwordChangedAt.toISOString(),
    createdAt: u.createdAt.toISOString(),
  });

  /** The acting Superadmin must re-enter their own password for every change to logins. */
  async function reauth(actor: AuthSession, currentPassword: string) {
    if (actor.user.role !== 'SUPERADMIN') throw new AppError(403, 'FORBIDDEN', 'Only the Superadmin can change logins');
    const me = db.select().from(users).where(eq(users.id, actor.user.id)).get();
    if (!me || !(await verifyPassword(currentPassword, me.passwordHash))) {
      throw new AppError(403, 'REAUTH_FAILED', 'Your current password is incorrect');
    }
  }

  /** There must always be at least one active Superadmin left to manage the others. */
  function assertNotLastSuperadmin(target: typeof users.$inferSelect) {
    if (target.role !== 'SUPERADMIN' || !target.isActive) return;
    const others = db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'SUPERADMIN'), eq(users.isActive, true), ne(users.id, target.id)))
      .get();
    if (!others) throw new AppError(409, 'LAST_SUPERADMIN', 'This is the only active Superadmin. Add another one first.');
  }

  function assertUsernameFree(username: string, exceptId?: number) {
    const clash = findByUsername(username);
    if (clash && clash.id !== exceptId) throw new AppError(409, 'USERNAME_TAKEN', 'That username is already used by another login');
  }

  function assertPassword(role: UserRole, password: string) {
    if (password.length < MIN_PASSWORD_LENGTH[role]) {
      throw new AppError(400, 'VALIDATION_ERROR', `Password must be at least ${MIN_PASSWORD_LENGTH[role]} characters`);
    }
  }

  return {
    /**
     * Verifies credentials and opens a session. Returns the raw token for the cookie; only its
     * hash is stored. The role comes from the account, never from the request.
     */
    async login(username: string, password: string, clientIp: string): Promise<{ token: string; session: AuthSession }> {
      const userKey = [`user:${username.trim().toLowerCase()}`];
      const ipKey = [`ip:${clientIp}`];
      const wait = Math.max(limiter.retryAfterMs(userKey), ipLimiter.retryAfterMs(ipKey));
      if (wait > 0) {
        const minutes = Math.ceil(wait / 60_000);
        throw new AppError(429, 'TOO_MANY_ATTEMPTS', `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, {
          retryAfterSeconds: Math.ceil(wait / 1000),
        });
      }

      const user = findByUsername(username.trim());
      const ok = user ? await verifyPassword(password, user.passwordHash) : (await verifyPassword(password, await getDummyHash()), false);
      if (!user || !ok) {
        limiter.recordFailure(userKey);
        ipLimiter.recordFailure(ipKey);
        throw BAD_LOGIN();
      }
      limiter.reset(userKey[0]);
      if (!user.isActive) throw new AppError(403, 'ACCOUNT_DISABLED', 'This login has been turned off. Ask the owner to turn it back on.');

      const token = randomBytes(32).toString('base64url');
      const at = now();
      const absolute = new Date(at.getTime() + maxMs);
      const expiresAt = new Date(Math.min(at.getTime() + idleMs, absolute.getTime()));
      const sessionId = sha256(token);
      db.insert(sessions).values({ id: sessionId, userId: user.id, createdAt: at, lastSeenAt: at, expiresAt, absoluteExpiresAt: absolute }).run();
      // Housekeeping: drop expired sessions.
      db.delete(sessions).where(or(lt(sessions.expiresAt, at), lt(sessions.absoluteExpiresAt, at))).run();
      return { token, session: { user: { id: user.id, username: user.username, role: user.role }, sessionId, expiresAt } };
    },

    /** Resolves a cookie token to its user, or null if missing/expired/revoked. Slides the idle expiry. */
    validate(token: string | undefined): AuthSession | null {
      if (!token || token.length > 200) return null;
      const sessionId = sha256(token);
      const at = now();
      const row = db
        .select({ s: sessions, u: users })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(and(eq(sessions.id, sessionId), eq(users.isActive, true), gt(sessions.expiresAt, at), gt(sessions.absoluteExpiresAt, at)))
        .get();
      if (!row) return null;
      let expiresAt = row.s.expiresAt;
      if (at.getTime() - row.s.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
        expiresAt = new Date(Math.min(at.getTime() + idleMs, row.s.absoluteExpiresAt.getTime()));
        db.update(sessions).set({ lastSeenAt: at, expiresAt }).where(eq(sessions.id, sessionId)).run();
      }
      return { user: { id: row.u.id, username: row.u.username, role: row.u.role }, sessionId, expiresAt };
    },

    /** Is this (already validated) session still valid right now? Used to drop stale sockets. */
    isSessionActive(sessionId: string): boolean {
      const at = now();
      return !!db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, at), gt(sessions.absoluteExpiresAt, at)))
        .get();
    },

    logout(sessionId: string) {
      const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
      db.delete(sessions).where(eq(sessions.id, sessionId)).run();
      if (row) events.emit('auth.revoked', { userId: row.userId, onlySessionId: sessionId });
    },

    hasSuperadmin: () => !!db.select({ id: users.id }).from(users).where(eq(users.role, 'SUPERADMIN')).get(),

    listAccounts(): LoginAccountDTO[] {
      const order = (r: UserRole) => USER_ROLES.indexOf(r);
      return db
        .select()
        .from(users)
        .orderBy(asc(users.id))
        .all()
        .sort((x, y) => order(x.role) - order(y.role) || x.id - y.id)
        .map(toDTO);
    },

    /** Superadmin adds another login (any role; a role can have as many logins as needed). */
    async createAccount(
      actor: AuthSession,
      input: { role: UserRole; username: string; password: string; currentPassword: string },
    ): Promise<LoginAccountDTO> {
      await reauth(actor, input.currentPassword);
      const username = input.username.trim();
      assertPassword(input.role, input.password);
      assertUsernameFree(username);
      const at = now();
      const passwordHash = await hashPassword(input.password);
      const row = db
        .insert(users)
        .values({ role: input.role, username, passwordHash, passwordChangedAt: at, createdAt: at, updatedAt: at })
        .returning()
        .get();
      return toDTO(row);
    },

    /**
     * Changes a login's username, password, role or on/off state. Every change ends that login's
     * sessions (except the Superadmin's own current one).
     */
    async updateAccount(
      actor: AuthSession,
      id: number,
      input: { username?: string; password?: string; role?: UserRole; isActive?: boolean; currentPassword: string },
    ): Promise<LoginAccountDTO> {
      await reauth(actor, input.currentPassword);
      const target = db.select().from(users).where(eq(users.id, id)).get();
      if (!target) throw new AppError(404, 'NOT_FOUND', 'Login not found');
      const self = target.id === actor.user.id;
      const username = input.username?.trim();
      const newRole = input.role ?? target.role;

      if (self && (input.isActive === false || newRole !== target.role)) {
        throw new AppError(409, 'CANNOT_CHANGE_SELF', 'You cannot turn off or change the role of the login you are using.');
      }
      if ((input.isActive === false && target.isActive) || newRole !== target.role) assertNotLastSuperadmin(target);
      if (input.password !== undefined) assertPassword(newRole, input.password);
      if (username) assertUsernameFree(username, target.id);

      const at = now();
      const passwordHash = input.password !== undefined ? await hashPassword(input.password) : undefined;
      const updated = db
        .update(users)
        .set({
          ...(username ? { username } : {}),
          ...(passwordHash ? { passwordHash, passwordChangedAt: at } : {}),
          ...(input.role ? { role: input.role } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          updatedAt: at,
        })
        .where(eq(users.id, target.id))
        .returning()
        .get();
      revokeSessions(target.id, self ? actor.sessionId : undefined);
      return toDTO(updated);
    },

    async deleteAccount(actor: AuthSession, id: number, currentPassword: string): Promise<void> {
      await reauth(actor, currentPassword);
      const target = db.select().from(users).where(eq(users.id, id)).get();
      if (!target) throw new AppError(404, 'NOT_FOUND', 'Login not found');
      if (target.id === actor.user.id) throw new AppError(409, 'CANNOT_CHANGE_SELF', 'You cannot delete the login you are using.');
      assertNotLastSuperadmin(target);
      revokeSessions(target.id);
      db.delete(users).where(eq(users.id, target.id)).run();
    },

    /**
     * First-time setup / recovery from the command line (npm run auth:setup). Creates the
     * Superadmin if none exists; with `reset`, replaces its credentials and signs it out everywhere.
     */
    async bootstrapSuperadmin(username: string, password: string, { reset = false } = {}): Promise<'created' | 'reset'> {
      const name = username.trim();
      if (!LOGIN_NAME_PATTERN.test(name)) {
        throw new AppError(400, 'VALIDATION_ERROR', LOGIN_NAME_MESSAGE);
      }
      assertPassword('SUPERADMIN', password);
      const existing = db.select().from(users).where(eq(users.role, 'SUPERADMIN')).get();
      if (existing && !reset) throw new AppError(409, 'ALREADY_SET_UP', 'A Superadmin already exists. Use --reset to replace its credentials.');
      const clash = findByUsername(name);
      if (clash && clash.id !== existing?.id) throw new AppError(409, 'USERNAME_TAKEN', 'That username is already used by another login');
      const at = now();
      const passwordHash = await hashPassword(password);
      if (existing) {
        db.update(users).set({ username: name, passwordHash, passwordChangedAt: at, updatedAt: at }).where(eq(users.id, existing.id)).run();
        revokeSessions(existing.id);
        return 'reset';
      }
      db.insert(users).values({ role: 'SUPERADMIN', username: name, passwordHash, passwordChangedAt: at, createdAt: at, updatedAt: at }).run();
      return 'created';
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
