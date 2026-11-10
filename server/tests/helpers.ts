import { createHash } from 'node:crypto';
import request from 'supertest';
import { createApp, type AppOptions } from '../src/app';
import { openDatabase, runMigrations } from '../src/db/client';
import { sessions, USER_ROLES, users, type UserRole } from '../src/db/schema';
import { seed } from '../src/db/seed';
import { sampleMenu } from './fixtures/sampleMenu';
import { EventBus } from '../src/events';
import { SESSION_COOKIE } from '../src/lib/cookies';
import { hashPassword } from '../src/lib/password';

export const USERNAMES: Record<UserRole, string> = { SUPERADMIN: 'owner', RECEPTION: 'front', KITCHEN: 'chef' };
export const PASSWORDS: Record<UserRole, string> = { SUPERADMIN: 'owner-password-1', RECEPTION: 'front-pass-1', KITCHEN: 'chef-pass-1' };
// Hashing is deliberately slow, so hash the test passwords once for the whole file.
const HASHES = Object.fromEntries(await Promise.all(USER_ROLES.map(async (r) => [r, await hashPassword(PASSWORDS[r])]))) as Record<UserRole, string>;

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
export type Api = Record<Method, (path: string) => request.Test>;

let tokenCounter = 0;

/**
 * A fresh, migrated, seeded in-memory database + app for each test, with the three logins
 * created and an open session for each. `ctx.api` calls the API as SUPERADMIN (full access, so
 * the Day 1–3 behaviour tests are unaffected); `ctx.as(role)` as another login; `ctx.anon`
 * without a session.
 */
export function setupTestApp(opts: Omit<AppOptions, 'db' | 'events'> & { seedUsers?: boolean } = {}) {
  const { seedUsers = true, ...appOpts } = opts;
  const { db, sqlite } = openDatabase(':memory:');
  runMigrations(db);
  seed(db, { menu: sampleMenu });
  const events = new EventBus();
  const { app, auth, paytm } = createApp({ db, events, ...appOpts });

  const cookies = {} as Record<UserRole, string>;
  if (seedUsers) {
    const at = new Date();
    const far = new Date('2100-01-01T00:00:00Z');
    for (const role of USER_ROLES) {
      const u = db
        .insert(users)
        .values({ role, username: USERNAMES[role], passwordHash: HASHES[role], passwordChangedAt: at, createdAt: at, updatedAt: at })
        .returning()
        .get();
      const token = `test-session-${role}-${++tokenCounter}`;
      db.insert(sessions)
        .values({ id: createHash('sha256').update(token).digest('hex'), userId: u.id, createdAt: at, lastSeenAt: at, expiresAt: far, absoluteExpiresAt: far })
        .run();
      cookies[role] = `${SESSION_COOKIE}=${token}`;
    }
  }

  const client = (cookie?: string): Api => {
    const make = (m: Method) => (path: string) => {
      const t = request(app)[m](path);
      return cookie ? t.set('Cookie', cookie) : t;
    };
    return { get: make('get'), post: make('post'), put: make('put'), patch: make('patch'), delete: make('delete') };
  };

  return { app, db, sqlite, events, auth, paytm, cookies, api: client(cookies.SUPERADMIN), as: (role: UserRole) => client(cookies[role]), anon: client() };
}

let counter = 0;
export const requestId = () => `test-req-${Date.now()}-${++counter}`;
