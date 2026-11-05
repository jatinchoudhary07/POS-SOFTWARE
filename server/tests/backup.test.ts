import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { BackupError, createBackupService, restoreFromBackup, verifyDatabaseFile } from '../src/backup/backupService';
import { openDatabase, runMigrations } from '../src/db/client';
import { seed } from '../src/db/seed';
import { sampleMenu } from './fixtures/sampleMenu';
import { EventBus } from '../src/events';
import { PASSWORDS, requestId, setupTestApp, USERNAMES } from './helpers';

const temps: string[] = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-backup-test-'));
  temps.push(d);
  return d;
}
afterEach(() => {
  for (const d of temps.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {}
  }
});

/** Every row of every table except sessions, for exact before/after comparison. */
function dump(file: string) {
  const db = new Database(file, { readonly: true });
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'sessions' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  const out = Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
  db.close();
  return out;
}

/**
 * A file-based (WAL) database like production, with orders, bills, a cash payment, a refunded UPI
 * payment, settings with taxes, menu edits and the three logins.
 */
async function realisticDb(dir: string) {
  const file = path.join(dir, 'pos.db');
  const { db, sqlite } = openDatabase(file);
  runMigrations(db);
  seed(db, { menu: sampleMenu });
  // Reuse the API (and its users/sessions) on top of the file DB.
  const helper = setupTestApp();
  const events = new EventBus();
  const { app } = createApp({ db, events });
  // Copy the three logins + sessions from the helper DB so we can call the API.
  for (const u of helper.sqlite.prepare('SELECT * FROM users').all() as Record<string, unknown>[]) {
    sqlite.prepare('INSERT INTO users (id, role, username, password_hash, password_changed_at, created_at, updated_at) VALUES (@id, @role, @username, @password_hash, @password_changed_at, @created_at, @updated_at)').run(u);
  }
  for (const s of helper.sqlite.prepare('SELECT * FROM sessions').all() as Record<string, unknown>[]) {
    sqlite.prepare('INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, absolute_expires_at) VALUES (@id, @user_id, @created_at, @last_seen_at, @expires_at, @absolute_expires_at)').run(s);
  }
  const api = (m: 'get' | 'post' | 'put' | 'patch', p: string) => request(app)[m](p).set('Cookie', helper.cookies.SUPERADMIN);
  await api('put', '/api/settings').send({ restaurantName: 'Backup Bistro', roundToRupee: true, taxes: [{ name: 'CGST', rateBps: 250 }, { name: 'SGST', rateBps: 250 }] }).expect(200);
  await api('patch', '/api/menu/items/2').send({ pricePaise: 17500 }).expect(200);
  const mk = async () =>
    (await api('post', '/api/orders').send({ clientRequestId: requestId(), orderType: 'DINE_IN', tableNumber: '3', items: [{ menuItemId: 1, quantity: 2 }] }).expect(201)).body.order;
  const a = await mk();
  const b = await mk();
  for (const o of [a, b]) await api('post', `/api/orders/${o.id}/bill`).send({}).expect(200);
  const total = (await api('get', `/api/orders/${a.id}/checkout`)).body.bill.totalPaise;
  await api('post', `/api/orders/${a.id}/payments`).send({ method: 'CASH', idempotencyKey: requestId(), expectedTotalPaise: total, tenderedPaise: total + 5000 }).expect(201);
  const upi = await api('post', `/api/orders/${b.id}/payments`).send({ method: 'UPI_MANUAL', idempotencyKey: requestId(), expectedTotalPaise: total, outcome: 'SUCCEEDED', manuallyVerified: true }).expect(201);
  await api('post', `/api/payments/${upi.body.payment.id}/refund`).send({ reason: 'Test refund', confirmed: true }).expect(200);
  await api('patch', `/api/orders/${a.id}/status`).send({ status: 'PREPARING' }).expect(200);
  helper.sqlite.close();
  return { file, db, sqlite, app, api, mk };
}

describe('backups', () => {
  it('makes a verified, consistent copy of a live WAL database (all records included)', async () => {
    const dir = tmpDir();
    const live = await realisticDb(dir);
    expect(live.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(fs.existsSync(`${live.file}-wal`)).toBe(true); // recent writes are still in the WAL

    const backups = createBackupService({ sqlite: live.sqlite, dir: path.join(dir, 'backups'), log: () => {} });
    const file = (await backups.backupNow('manual'))!;
    expect(file.name).toMatch(/^pos-\d{8}-\d{6}-manual\.db$/);
    // Only finished backup files: no ".partial", "-wal" or "-shm" leftovers.
    expect(fs.readdirSync(backups.dir)).toEqual([file.name]);
    // Self-contained file (not WAL), so opening it never creates side files.
    const bk = new Database(file.path, { readonly: true });
    expect(bk.pragma('journal_mode', { simple: true })).toBe('delete');
    bk.close();
    verifyDatabaseFile(file.path);
    expect(fs.readdirSync(backups.dir)).toEqual([file.name]);
    expect(verifyDatabaseFile(file.path)).toMatchObject({ orders: 2, bills: 2, payments: 2, users: 3, tax_rates: 2, restaurant_settings: 1 });
    // The backup equals the live database exactly (including rows that were only in the WAL).
    expect(dump(file.path)).toEqual(dump(live.file));
    // ...whereas a naive copy of only pos.db would have missed them.
    const naive = path.join(dir, 'naive.db');
    fs.copyFileSync(live.file, naive);
    expect(() => verifyDatabaseFile(naive)).toThrow();
    live.sqlite.close();
  });

  it('skips scheduled backups when nothing changed, and backs up again after a change', async () => {
    const dir = tmpDir();
    const live = await realisticDb(dir);
    const backups = createBackupService({ sqlite: live.sqlite, dir: path.join(dir, 'backups'), log: () => {} });
    expect(await backups.backupNow('scheduled', { onlyIfChanged: true })).not.toBeNull();
    expect(await backups.backupNow('scheduled', { onlyIfChanged: true })).toBeNull();
    expect(backups.status().lastSkipped?.reason).toMatch(/No changes/);
    await live.mk();
    expect(await backups.backupNow('scheduled', { onlyIfChanged: true })).not.toBeNull();
    live.sqlite.close();
  });

  it('retention keeps recent backups, one per day, and never fewer than the minimum', async () => {
    const dir = tmpDir();
    const bdir = path.join(dir, 'backups');
    fs.mkdirSync(bdir);
    const now = new Date(2026, 9, 22, 12, 0, 0);
    const make = (daysAgo: number, hour: number) => {
      const d = new Date(now.getTime() - daysAgo * 86_400_000);
      d.setHours(hour, 0, 0, 0);
      const p = (n: number) => String(n).padStart(2, '0');
      const name = `pos-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}0000-scheduled.db`;
      fs.writeFileSync(path.join(bdir, name), 'x');
      return name;
    };
    for (let day = 0; day < 100; day++) for (const h of [10, 14, 18]) make(day, h);
    const sqlite = new Database(':memory:');
    const svc = createBackupService({ sqlite, dir: bdir, keepDays: 60, keepRecentHours: 48, minKeep: 10, now: () => now, log: () => {} });
    svc.prune();
    const left = svc.list();
    // within 48 h: everything
    const recent = left.filter((f) => now.getTime() - f.createdAt.getTime() < 48 * 3600_000);
    expect(recent.length).toBeGreaterThanOrEqual(6);
    // the 10 newest are always kept; beyond those and older than 48 h: one (the newest) per day, up to 60 days
    expect(left.slice(0, 10).map((f) => f.name)).toEqual(svc.list().slice(0, 10).map((f) => f.name));
    const older = left.slice(10).filter((f) => now.getTime() - f.createdAt.getTime() >= 48 * 3600_000);
    const days = older.map((f) => f.createdAt.toDateString());
    expect(new Set(days).size).toBe(days.length);
    expect(older.every((f) => f.createdAt.getHours() === 18)).toBe(true);
    expect(older.every((f) => now.getTime() - f.createdAt.getTime() < 60 * 86_400_000)).toBe(true);

    // If ALL backups are ancient, the newest `minKeep` are still kept (never delete the last good ones).
    const dir2 = path.join(dir, 'old');
    fs.mkdirSync(dir2);
    for (let i = 0; i < 15; i++) fs.writeFileSync(path.join(dir2, `pos-2020010${Math.floor(i / 3) + 1}-1${i % 3}0000-scheduled.db`), 'x');
    const svc2 = createBackupService({ sqlite, dir: dir2, keepDays: 60, minKeep: 10, now: () => now, log: () => {} });
    svc2.prune();
    expect(svc2.list()).toHaveLength(10);
    sqlite.close();
  });

  it('refuses to back up when disk space is low, leaving no partial file', async () => {
    const dir = tmpDir();
    const live = await realisticDb(dir);
    const logs: string[] = [];
    const backups = createBackupService({ sqlite: live.sqlite, dir: path.join(dir, 'backups'), freeBytes: async () => 5 * 1024 * 1024, log: (m) => logs.push(m) });
    await expect(backups.backupNow('manual')).rejects.toThrow(/Not enough free disk space/);
    expect(await backups.tryBackup('scheduled')).toBeNull(); // the schedule never crashes the server
    expect(backups.status().lastError?.message).toMatch(/Not enough free disk space/);
    expect(backups.list()).toHaveLength(0);
    expect(fs.readdirSync(backups.dir)).toEqual([]);
    expect(logs.join('\n')).toMatch(/BACKUP FAILED/);
    live.sqlite.close();
  });

  it('reports an unusable backup folder clearly', async () => {
    const dir = tmpDir();
    const live = await realisticDb(dir);
    const blocker = path.join(dir, 'not-a-folder');
    fs.writeFileSync(blocker, 'x');
    const backups = createBackupService({ sqlite: live.sqlite, dir: path.join(blocker, 'backups'), log: () => {} });
    await expect(backups.backupNow('manual')).rejects.toThrow(/Cannot use the backup folder/);
    live.sqlite.close();
  });

  it('never writes credentials or session tokens to the log', async () => {
    const dir = tmpDir();
    const live = await realisticDb(dir);
    const logs: string[] = [];
    const backups = createBackupService({ sqlite: live.sqlite, dir: path.join(dir, 'backups'), log: (m) => logs.push(m) });
    await backups.backupNow('manual');
    const text = logs.join('\n');
    expect(text).toMatch(/Backup saved/);
    expect(text).not.toMatch(/scrypt|pos_session|password|Paise|₹/i);
    for (const p of Object.values(PASSWORDS)) expect(text).not.toContain(p);
    live.sqlite.close();
  });
});

describe('restore', () => {
  it('restores onto a separate copy exactly, after saving the current database first', async () => {
    const dir = tmpDir();
    const live = await realisticDb(dir);
    const bdir = path.join(dir, 'backups');
    const backups = createBackupService({ sqlite: live.sqlite, dir: bdir, log: () => {} });
    const backup = (await backups.backupNow('manual'))!;
    const atBackup = dump(backup.path);

    // Later changes that the restore must undo...
    await live.mk();
    await live.api('put', '/api/settings').send({ restaurantName: 'Changed Later', roundToRupee: false, taxes: [] }).expect(200);
    live.sqlite.close();

    // ...restored onto a separate COPY of the live database (the original stays untouched).
    const copy = path.join(dir, 'copy', 'pos.db');
    fs.mkdirSync(path.dirname(copy));
    const liveCopyDb = new Database(live.file, { readonly: true });
    await liveCopyDb.backup(copy);
    liveCopyDb.close();
    const beforeRestore = dump(copy);
    const { safetyBackup, counts } = await restoreFromBackup(backup.path, copy, { dir: bdir, log: () => {} });

    expect(dump(copy)).toEqual(atBackup); // every row of every table: orders, bills, payments, refunds, menu, settings, users
    expect(counts).toMatchObject({ orders: 2, payments: 2, users: 3 });
    const restored = new Database(copy, { readonly: true });
    expect(restored.prepare("SELECT status FROM payments ORDER BY id").all()).toEqual([{ status: 'SUCCEEDED' }, { status: 'REFUNDED' }]);
    expect(restored.prepare('SELECT restaurant_name FROM restaurant_settings').get()).toEqual({ restaurant_name: 'Backup Bistro' });
    restored.close();
    // The pre-restore safety copy holds the state that was replaced.
    expect(safetyBackup!.name).toMatch(/pre-restore/);
    expect(dump(safetyBackup!.path)).toEqual(beforeRestore);
    expect(fs.existsSync(`${copy}.restoring`)).toBe(false);
  });

  it('a restored database works with the app (sign-in, data, new orders)', async () => {
    const dir = tmpDir();
    const live = await realisticDb(dir);
    const backup = (await createBackupService({ sqlite: live.sqlite, dir: path.join(dir, 'b'), log: () => {} }).backupNow('manual'))!;
    live.sqlite.close();
    const target = path.join(dir, 'restored', 'pos.db');
    await restoreFromBackup(backup.path, target, { dir: path.join(dir, 'b'), log: () => {} });

    const { db, sqlite } = openDatabase(target);
    runMigrations(db); // as on server start
    const { app } = createApp({ db, events: new EventBus() });
    const login = await request(app).post('/api/auth/login').send({ username: USERNAMES.RECEPTION, password: PASSWORDS.RECEPTION }).expect(200);
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    const orders = await request(app).get('/api/orders').set('Cookie', cookie).expect(200);
    expect(orders.body.orders.map((o: { paymentStatus: string }) => o.paymentStatus).sort()).toEqual(['PAID', 'REFUNDED']);
    await request(app).post('/api/orders').set('Cookie', cookie).send({ clientRequestId: requestId(), orderType: 'TAKEAWAY', items: [{ menuItemId: 1, quantity: 1 }] }).expect(201);
    sqlite.close();
  });

  it('refuses damaged or foreign files and leaves the current database untouched', async () => {
    const dir = tmpDir();
    const live = await realisticDb(dir);
    live.sqlite.close();
    const before = dump(live.file);
    const garbage = path.join(dir, 'garbage.db');
    fs.writeFileSync(garbage, 'this is not a database');
    await expect(restoreFromBackup(garbage, live.file, { dir: path.join(dir, 'b'), log: () => {} })).rejects.toBeInstanceOf(BackupError);
    const other = path.join(dir, 'other.db');
    const foreignDb = new Database(other);
    foreignDb.exec('CREATE TABLE x (a)');
    foreignDb.close();
    await expect(restoreFromBackup(other, live.file, { dir: path.join(dir, 'b'), log: () => {} })).rejects.toThrow(/Not a complete POS database/);
    await expect(restoreFromBackup(live.file, live.file, { dir: path.join(dir, 'b'), log: () => {} })).rejects.toThrow(/live database itself/);
    expect(dump(live.file)).toEqual(before);
  });
});

describe('backups in the app', () => {
  it('backs up before Superadmin changes, never for anonymous requests, and reports status to the Superadmin only', async () => {
    const dir = tmpDir();
    const live = await realisticDb(dir);
    const backups = createBackupService({ sqlite: live.sqlite, dir: path.join(dir, 'backups'), log: () => {} });
    const helper = setupTestApp();
    const { app } = createApp({ db: live.db, events: new EventBus(), backups });
    const owner = (await request(app).post('/api/auth/login').send({ username: USERNAMES.SUPERADMIN, password: PASSWORDS.SUPERADMIN }).expect(200)).headers['set-cookie'] as unknown as string[];
    const front = (await request(app).post('/api/auth/login').send({ username: USERNAMES.RECEPTION, password: PASSWORDS.RECEPTION }).expect(200)).headers['set-cookie'] as unknown as string[];
    const c = (h: string[]) => h[0].split(';')[0];

    await request(app).put('/api/settings').send({ restaurantName: 'X', roundToRupee: false, taxes: [] }).expect(401);
    await request(app).put('/api/settings').set('Cookie', c(front)).send({ restaurantName: 'X', roundToRupee: false, taxes: [] }).expect(403);
    expect(backups.list()).toHaveLength(0);

    await request(app).put('/api/settings').set('Cookie', c(owner)).send({ restaurantName: 'After', roundToRupee: false, taxes: [] }).expect(200);
    const files = backups.list();
    expect(files.map((f) => f.reason)).toEqual(['before-change']);
    expect(verifyDatabaseFile(files[0].path)).toBeTruthy();
    const snap = new Database(files[0].path, { readonly: true });
    expect(snap.prepare('SELECT restaurant_name FROM restaurant_settings').get()).toEqual({ restaurant_name: 'Backup Bistro' }); // state BEFORE the change
    snap.close();

    const st = await request(app).get('/api/admin/backups').set('Cookie', c(owner)).expect(200);
    expect(st.body.status.lastSuccess.file).toBe(files[0].name);
    expect(st.body.files[0]).toEqual({ name: files[0].name, sizeBytes: expect.any(Number), createdAt: expect.any(String), reason: 'before-change' });
    await request(app).get('/api/admin/backups').set('Cookie', c(front)).expect(403);
    await request(app).post('/api/admin/backups').set('Cookie', c(front)).expect(403);
    expect((await request(app).post('/api/admin/backups').set('Cookie', c(owner)).expect(201)).body.file.name).toMatch(/manual/);
    helper.sqlite.close();
    live.sqlite.close();
  });
});
