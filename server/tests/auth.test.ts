import request from 'supertest';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { sessions, users } from '../src/db/schema';
import { LoginLimiter } from '../src/lib/loginLimiter';
import { hashPassword, verifyPassword } from '../src/lib/password';
import { PASSWORDS, setupTestApp, USERNAMES } from './helpers';

type Ctx = ReturnType<typeof setupTestApp>;
const login = (ctx: Ctx, username: string, password: string) => request(ctx.app).post('/api/auth/login').send({ username, password });
const cookieOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];

describe('password hashing', () => {
  it('stores a salted scrypt hash that verifies only the right password', async () => {
    const a = await hashPassword('correct horse');
    const b = await hashPassword('correct horse');
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b); // unique salt per hash
    expect(a).not.toContain('correct horse');
    expect(await verifyPassword('correct horse', a)).toBe(true);
    expect(await verifyPassword('correct horsE', a)).toBe(false);
    expect(await verifyPassword('', a)).toBe(false);
    // Tamper with one character in the middle of the stored hash.
    const i = a.length - 20;
    const tampered = a.slice(0, i) + (a[i] === 'A' ? 'B' : 'A') + a.slice(i + 1);
    expect(await verifyPassword('correct horse', tampered)).toBe(false);
    expect(await verifyPassword('x', 'plaintext')).toBe(false);
    await expect(hashPassword('x'.repeat(129))).rejects.toThrow();
  });

  it('never stores a plaintext password in the database', () => {
    const ctx = setupTestApp();
    const rows = ctx.db.select().from(users).all();
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.passwordHash.startsWith('scrypt$')).toBe(true);
      expect(r.passwordHash).not.toContain(PASSWORDS[r.role]);
    }
  });
});

describe('login', () => {
  it('opens a session in an HttpOnly, SameSite=Strict cookie; the role comes from the account', async () => {
    const ctx = setupTestApp();
    const res = await login(ctx, 'FRONT', PASSWORDS.RECEPTION).expect(200); // username is case-insensitive
    expect(res.body.user).toEqual({ id: expect.any(Number), username: USERNAMES.RECEPTION, role: 'RECEPTION' });
    const raw = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(raw).toMatch(/^pos_session=[A-Za-z0-9_-]{43};/);
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/SameSite=Strict/);
    expect(raw).toMatch(/Path=\//);
    expect(raw).not.toMatch(/Secure/); // plain http (see README: not protected against interception)
    const me = await request(ctx.app).get('/api/auth/me').set('Cookie', cookieOf(res)).expect(200);
    expect(me.body.user.role).toBe('RECEPTION');
    // Only a hash of the token is stored.
    const token = cookieOf(res).split('=')[1];
    expect(ctx.db.select().from(sessions).all().some((s) => s.id === token)).toBe(false);
  });

  it('marks the cookie Secure when configured for HTTPS', async () => {
    const ctx = setupTestApp({ cookieSecure: true });
    const res = await login(ctx, USERNAMES.KITCHEN, PASSWORDS.KITCHEN).expect(200);
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(/Secure/);
  });

  it('gives the same answer for a wrong password and an unknown user', async () => {
    const ctx = setupTestApp();
    const wrong = await login(ctx, USERNAMES.SUPERADMIN, 'nope-nope-nope').expect(401);
    const unknown = await login(ctx, 'nobody', 'nope-nope-nope').expect(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error).toEqual({ code: 'INVALID_CREDENTIALS', message: 'Incorrect username or password' });
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('cannot be used to pick a role', async () => {
    const ctx = setupTestApp();
    await request(ctx.app).post('/api/auth/login').send({ username: USERNAMES.KITCHEN, password: PASSWORDS.KITCHEN, role: 'SUPERADMIN' }).expect(400);
    const res = await login(ctx, USERNAMES.KITCHEN, PASSWORDS.KITCHEN).set('X-Role', 'SUPERADMIN').expect(200);
    expect(res.body.user.role).toBe('KITCHEN');
    // Headers/query claiming another role or user are ignored by every endpoint.
    await request(ctx.app).get('/api/reports/daily?role=SUPERADMIN').set('Cookie', cookieOf(res)).set('X-User-Role', 'SUPERADMIN').set('X-User-Id', '1').expect(403);
  });

  it('locks out a username after repeated failures and lets it in again after the lock', async () => {
    let now = new Date('2026-10-22T10:00:00Z');
    const limiter = new LoginLimiter({ maxFailures: 5, lockMs: 15 * 60_000, now: () => now.getTime() });
    const ctx = setupTestApp({ now: () => now, loginLimiter: limiter });
    for (let i = 0; i < 5; i++) await login(ctx, USERNAMES.SUPERADMIN, `guess-${i}`).expect(401);
    const locked = await login(ctx, USERNAMES.SUPERADMIN, PASSWORDS.SUPERADMIN).expect(429); // even the right password
    expect(locked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    expect(locked.body.error.details.retryAfterSeconds).toBeGreaterThan(800);
    // Unknown usernames are throttled the same way (no hint that they don't exist).
    for (let i = 0; i < 5; i++) await login(ctx, 'ghost', `guess-${i}`).expect(401);
    await login(ctx, 'ghost', 'x').expect(429);
    // A locked username doesn't lock the shared computer for other logins.
    await login(ctx, USERNAMES.KITCHEN, PASSWORDS.KITCHEN).expect(200);

    now = new Date(now.getTime() + 16 * 60_000);
    await login(ctx, USERNAMES.SUPERADMIN, PASSWORDS.SUPERADMIN).expect(200);
  });
});

describe('per-client limit', () => {
  it('blocks a client that tries many different usernames', async () => {
    const now = new Date('2026-10-22T10:00:00Z');
    const ipLimiter = new LoginLimiter({ maxFailures: 20, now: () => now.getTime() });
    const ctx = setupTestApp({ now: () => now, ipLoginLimiter: ipLimiter });
    for (let i = 0; i < 20; i++) await login(ctx, `user${i}`, 'guess').expect(401);
    const res = await login(ctx, USERNAMES.SUPERADMIN, PASSWORDS.SUPERADMIN).expect(429);
    expect(res.body.error.code).toBe('TOO_MANY_ATTEMPTS');
  });
});

describe('logout and expiry', () => {
  it('logout invalidates the session server-side and clears the cookie', async () => {
    const ctx = setupTestApp();
    const cookie = cookieOf(await login(ctx, USERNAMES.RECEPTION, PASSWORDS.RECEPTION));
    await request(ctx.app).get('/api/orders').set('Cookie', cookie).expect(200);
    const out = await request(ctx.app).post('/api/auth/logout').set('Cookie', cookie).expect(200);
    expect((out.headers['set-cookie'] as unknown as string[])[0]).toMatch(/pos_session=;.*Expires=Thu, 01 Jan 1970/);
    // Re-using the old cookie (e.g. copied before logout) no longer works.
    const res = await request(ctx.app).get('/api/orders').set('Cookie', cookie).expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    await request(ctx.app).post('/api/auth/logout').expect(200); // harmless without a session
  });

  it('expires after the idle timeout, slides with activity, and never outlives the absolute limit', async () => {
    let now = new Date('2026-10-22T08:00:00Z');
    const hour = 60 * 60_000;
    const ctx = setupTestApp({ now: () => now, sessionIdleMs: 12 * hour, sessionMaxMs: 24 * hour });
    const cookie = cookieOf(await login(ctx, USERNAMES.KITCHEN, PASSWORDS.KITCHEN));
    const me = () => request(ctx.app).get('/api/auth/me').set('Cookie', cookie);

    now = new Date(now.getTime() + 11 * hour);
    await me().expect(200); // activity at 11 h slides expiry to 23 h
    now = new Date(now.getTime() + 11 * hour);
    await me().expect(200); // 22 h: still valid thanks to sliding
    now = new Date(now.getTime() + 3 * hour);
    const res = await me().expect(401); // 25 h: beyond the 24 h absolute limit
    expect(res.body.error.code).toBe('UNAUTHENTICATED');

    const cookie2 = cookieOf(await login(ctx, USERNAMES.KITCHEN, PASSWORDS.KITCHEN));
    now = new Date(now.getTime() + 13 * hour); // idle for longer than 12 h
    await request(ctx.app).get('/api/auth/me').set('Cookie', cookie2).expect(401);
  });
});

describe('managing logins (Superadmin)', () => {
  const idOf = (ctx: Ctx, role: 'SUPERADMIN' | 'RECEPTION' | 'KITCHEN') => ctx.db.select().from(users).where(eq(users.role, role)).get()!.id;
  const SA = PASSWORDS.SUPERADMIN;

  it('lists the logins without any password data', async () => {
    const ctx = setupTestApp();
    const res = await ctx.api.get('/api/auth/accounts').expect(200);
    expect(res.body.accounts.map((a: { role: string; username: string; isActive: boolean }) => [a.role, a.username, a.isActive])).toEqual([
      ['SUPERADMIN', 'owner', true],
      ['RECEPTION', 'front', true],
      ['KITCHEN', 'chef', true],
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/scrypt|hash|password"/i);
    await ctx.as('RECEPTION').get('/api/auth/accounts').expect(403);
    await ctx.as('KITCHEN').post('/api/auth/accounts').send({ role: 'KITCHEN', username: 'sneaky', password: 'x'.repeat(10), currentPassword: PASSWORDS.KITCHEN }).expect(403);
  });

  it('adds several logins for the same role', async () => {
    const ctx = setupTestApp();
    const add = (body: object) => ctx.api.post('/api/auth/accounts').send(body);
    expect((await add({ role: 'KITCHEN', username: 'chef2', password: 'chef2-pass', currentPassword: 'wrong' }).expect(403)).body.error.code).toBe('REAUTH_FAILED');
    await add({ role: 'KITCHEN', username: 'chef2', password: '12345', currentPassword: SA }).expect(400); // too short
    await add({ role: 'KITCHEN', username: 'bad name!', password: 'chef2-pass', currentPassword: SA }).expect(400);
    expect((await add({ role: 'KITCHEN', username: 'CHEF', password: 'chef2-pass', currentPassword: SA }).expect(409)).body.error.code).toBe('USERNAME_TAKEN');
    await add({ role: 'MANAGER', username: 'boss1', password: 'boss1-pass', currentPassword: SA }).expect(400);

    const res = await add({ role: 'KITCHEN', username: 'chef2', password: 'chef2-pass', currentPassword: SA }).expect(201);
    expect(res.body.account).toMatchObject({ role: 'KITCHEN', username: 'chef2', isActive: true });
    await add({ role: 'SUPERADMIN', username: 'owner2', password: 'owner2-pass', currentPassword: SA }).expect(201);
    expect(res.body.accounts).toHaveLength(4);
    expect((await login(ctx, 'chef2', 'chef2-pass').expect(200)).body.user.role).toBe('KITCHEN');
    expect((await login(ctx, 'owner2', 'owner2-pass').expect(200)).body.user.role).toBe('SUPERADMIN');
  });

  it('changes a login after re-checking the Superadmin password, and signs that login out', async () => {
    const ctx = setupTestApp();
    const put = (body: object) => ctx.api.put(`/api/auth/accounts/${idOf(ctx, 'RECEPTION')}`).send(body);
    expect((await put({ password: 'brand-new-1', currentPassword: 'wrong' }).expect(403)).body.error.code).toBe('REAUTH_FAILED');
    await put({ password: '12345', currentPassword: SA }).expect(400); // too short
    expect((await put({ username: 'CHEF', currentPassword: SA }).expect(409)).body.error.code).toBe('USERNAME_TAKEN');
    await put({ username: 'bad name!', currentPassword: SA }).expect(400);
    await put({ currentPassword: SA }).expect(400); // nothing to change
    await ctx.api.put('/api/auth/accounts/9999').send({ password: 'brand-new-1', currentPassword: SA }).expect(404);

    const res = await put({ username: 'cashier', password: 'brand-new-1', currentPassword: SA }).expect(200);
    expect(res.body.account).toMatchObject({ role: 'RECEPTION', username: 'cashier' });
    await ctx.as('RECEPTION').get('/api/orders').expect(401); // old session ended
    await login(ctx, 'front', PASSWORDS.RECEPTION).expect(401);
    await login(ctx, 'cashier', PASSWORDS.RECEPTION).expect(401);
    const fresh = await login(ctx, 'cashier', 'brand-new-1').expect(200);
    expect(fresh.body.user.role).toBe('RECEPTION');
  });

  it("changing the Superadmin's own password keeps the current session but ends the others", async () => {
    const ctx = setupTestApp();
    const other = cookieOf(await login(ctx, USERNAMES.SUPERADMIN, PASSWORDS.SUPERADMIN));
    await ctx.api.put(`/api/auth/accounts/${idOf(ctx, 'SUPERADMIN')}`).send({ password: 'even-better-pass', currentPassword: SA }).expect(200);
    await ctx.api.get('/api/auth/accounts').expect(200);
    await request(ctx.app).get('/api/auth/me').set('Cookie', other).expect(401);
  });

  it('turns a login off and on', async () => {
    const ctx = setupTestApp();
    const id = idOf(ctx, 'KITCHEN');
    await ctx.api.put(`/api/auth/accounts/${id}`).send({ isActive: false, currentPassword: SA }).expect(200);
    await ctx.as('KITCHEN').get('/api/kitchen/orders').expect(401); // sessions ended
    const blocked = await login(ctx, USERNAMES.KITCHEN, PASSWORDS.KITCHEN).expect(403);
    expect(blocked.body.error.code).toBe('ACCOUNT_DISABLED');
    await login(ctx, USERNAMES.KITCHEN, 'wrong-password').expect(401); // a wrong password still reveals nothing
    await ctx.api.put(`/api/auth/accounts/${id}`).send({ isActive: true, currentPassword: SA }).expect(200);
    await login(ctx, USERNAMES.KITCHEN, PASSWORDS.KITCHEN).expect(200);
  });

  it('changes the role of a login', async () => {
    const ctx = setupTestApp();
    await ctx.api.put(`/api/auth/accounts/${idOf(ctx, 'KITCHEN')}`).send({ role: 'RECEPTION', currentPassword: SA }).expect(200);
    expect((await login(ctx, USERNAMES.KITCHEN, PASSWORDS.KITCHEN).expect(200)).body.user.role).toBe('RECEPTION');
  });

  it('deletes a login but never your own or the last active Superadmin', async () => {
    const ctx = setupTestApp();
    const del = (id: number, currentPassword = SA) => ctx.api.delete(`/api/auth/accounts/${id}`).send({ currentPassword });
    const me = idOf(ctx, 'SUPERADMIN');
    expect((await del(me).expect(409)).body.error.code).toBe('CANNOT_CHANGE_SELF');
    await ctx.api.put(`/api/auth/accounts/${me}`).send({ isActive: false, currentPassword: SA }).expect(409);
    await ctx.api.put(`/api/auth/accounts/${me}`).send({ role: 'KITCHEN', currentPassword: SA }).expect(409);
    await del(idOf(ctx, 'KITCHEN'), 'wrong').expect(403);

    const res = await del(idOf(ctx, 'KITCHEN')).expect(200);
    expect(res.body.accounts.map((a: { role: string }) => a.role)).toEqual(['SUPERADMIN', 'RECEPTION']);
    await login(ctx, USERNAMES.KITCHEN, PASSWORDS.KITCHEN).expect(401);
  });

  it('lets one Superadmin turn off another, whose sessions then end', async () => {
    const ctx = setupTestApp();
    await ctx.api.post('/api/auth/accounts').send({ role: 'SUPERADMIN', username: 'owner2', password: 'owner2-pass', currentPassword: SA }).expect(201);
    const cookie2 = cookieOf(await login(ctx, 'owner2', 'owner2-pass').expect(200));
    await request(ctx.app)
      .put(`/api/auth/accounts/${idOf(ctx, 'SUPERADMIN')}`)
      .set('Cookie', cookie2)
      .send({ isActive: false, currentPassword: 'owner2-pass' })
      .expect(200);
    await ctx.api.get('/api/auth/accounts').expect(401); // the first Superadmin was signed out
    await login(ctx, USERNAMES.SUPERADMIN, SA).expect(403);
  });
});

describe('first Superadmin (bootstrap)', () => {
  it('creates the Superadmin once, refuses a second, and can reset it', async () => {
    const ctx = setupTestApp({ seedUsers: false });
    expect((await request(ctx.app).get('/api/auth/status').expect(200)).body).toEqual({ setupRequired: true });
    await expect(ctx.auth.bootstrapSuperadmin('owner', 'short')).rejects.toThrow(/at least 6/);
    await expect(ctx.auth.bootstrapSuperadmin('bad name', 'long-enough-1')).rejects.toThrow(/username, email address or mobile/);
    expect(await ctx.auth.bootstrapSuperadmin('owner', 'long-enough-1')).toBe('created');
    expect((await request(ctx.app).get('/api/auth/status')).body).toEqual({ setupRequired: false });
    await expect(ctx.auth.bootstrapSuperadmin('owner2', 'long-enough-2')).rejects.toThrow(/already exists/);

    const cookie = cookieOf(await login(ctx, 'owner', 'long-enough-1').expect(200));
    expect(await ctx.auth.bootstrapSuperadmin('owner', 'recovered-pass-1', { reset: true })).toBe('reset');
    await request(ctx.app).get('/api/auth/me').set('Cookie', cookie).expect(401); // signed out everywhere
    await login(ctx, 'owner', 'recovered-pass-1').expect(200);
  });
});

describe('cross-site protection', () => {
  it('blocks state-changing requests from another website even with a valid cookie', async () => {
    const ctx = setupTestApp();
    const res = await ctx.api.post('/api/orders').set('Origin', 'http://evil.example').send({}).expect(403);
    expect(res.body.error.code).toBe('BAD_ORIGIN');
    await ctx.api.get('/api/orders').set('Origin', 'http://evil.example').expect(200); // reads are not state-changing
  });
});
