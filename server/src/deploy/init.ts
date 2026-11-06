/**
 * Start-up for a hosted demo: run before the server on every boot (index.ts does it when DEMO_INIT=1).
 *
 * Hosted demo servers may start with an empty disk, so this makes sure a fresh database has
 * what is needed to use the app straight away:
 *   - the database tables (migrations),
 *   - the Two Hearts Cafe menu,
 *   - the logins named in the environment (Superadmin, and optionally Reception and Kitchen),
 *   - a few dining tables.
 * Nothing is changed in a database that already has these, so it is safe to run on every start.
 *
 * Environment: SEED_DB (optional database file to start from), SUPERADMIN_USERNAME / SUPERADMIN_PASSWORD (required to create the first login),
 * RECEPTION_USERNAME / RECEPTION_PASSWORD, KITCHEN_USERNAME / KITCHEN_PASSWORD (optional),
 * EXTRA_SUPERADMIN_USERNAME / EXTRA_SUPERADMIN_PASSWORD_HASH (optional second Superadmin, password already hashed),
 * DEMO_TABLES (how many tables to create when there are none, default 6).
 */
import fs from 'node:fs';
import path from 'node:path';
import { count, eq, sql } from 'drizzle-orm';
import { config } from '../config';
import { openDatabase, runMigrations } from '../db/client';
import { loadMenu } from '../db/loadMenu';
import { diningTables, menuCategories, users, type UserRole } from '../db/schema';
import { hashPassword } from '../lib/password';

// SEED_DB: a ready-made database (a snapshot of real data) to start from when this server's disk is empty.
const seedFile = process.env.SEED_DB ? path.resolve(process.cwd(), process.env.SEED_DB) : '';
// SEED_DB_B64_FILE: the same snapshot stored as base64 text (for hosts that only accept text secret files).
const seedB64 = process.env.SEED_DB_B64_FILE ? path.resolve(process.cwd(), process.env.SEED_DB_B64_FILE) : '';
let restored = false;
if (seedB64 && config.databasePath !== ':memory:' && fs.existsSync(seedB64) && !fs.existsSync(config.databasePath)) {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  fs.writeFileSync(config.databasePath, Buffer.from(fs.readFileSync(seedB64, 'utf8').replace(/\s+/g, ''), 'base64'), { mode: 0o644 });
  restored = true;
} else if (seedFile && config.databasePath !== ':memory:' && fs.existsSync(seedFile) && !fs.existsSync(config.databasePath)) {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  fs.copyFileSync(seedFile, config.databasePath);
  // The copy keeps the seed's read-only permissions on a hosted disk; the server must be able to write to it.
  fs.chmodSync(config.databasePath, 0o644);
  restored = true;
}

const { db, sqlite } = openDatabase(config.databasePath);
runMigrations(db);
if (restored) {
  const n = (table: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  console.log(`[init] data restored from the seed: ${n('users')} logins, ${n('orders')} orders, ${n('customers')} credit customers, ${n('menu_items')} menu items, ${n('dining_tables')} tables`);
}

if ((db.select({ n: count() }).from(menuCategories).get()?.n ?? 0) === 0) {
  const r = loadMenu(db);
  console.log(`[init] menu loaded (${r.added} items)`);
}

async function ensureLogin(role: UserRole, usernameVar: string, passwordVar: string) {
  const username = process.env[usernameVar]?.trim();
  const password = process.env[passwordVar];
  if (!username || !password) return;
  if (db.select().from(users).where(eq(users.role, role)).get()) return; // never overwrite an existing login
  const at = new Date();
  db.insert(users)
    .values({ role, username, passwordHash: await hashPassword(password), passwordChangedAt: at, createdAt: at, updatedAt: at })
    .run();
  console.log(`[init] ${role} login "${username}" created`);
}

await ensureLogin('SUPERADMIN', 'SUPERADMIN_USERNAME', 'SUPERADMIN_PASSWORD');
await ensureLogin('RECEPTION', 'RECEPTION_USERNAME', 'RECEPTION_PASSWORD');
await ensureLogin('KITCHEN', 'KITCHEN_USERNAME', 'KITCHEN_PASSWORD');

// An additional Superadmin whose password is already hashed (the owner's own account, copied without the password).
const extraName = process.env.EXTRA_SUPERADMIN_USERNAME?.trim();
const extraHash = process.env.EXTRA_SUPERADMIN_PASSWORD_HASH;
if (extraName && extraHash?.startsWith('scrypt$') && !db.select().from(users).where(sql`lower(${users.username}) = lower(${extraName})`).get()) {
  const at = new Date();
  db.insert(users).values({ role: 'SUPERADMIN', username: extraName, passwordHash: extraHash, passwordChangedAt: at, createdAt: at, updatedAt: at }).run();
  console.log(`[init] SUPERADMIN login "${extraName}" created`);
}

if ((db.select({ n: count() }).from(diningTables).get()?.n ?? 0) === 0) {
  const wanted = Math.min(30, Math.max(0, Number(process.env.DEMO_TABLES ?? 6) || 0));
  for (let i = 1; i <= wanted; i++) {
    db.insert(diningTables).values({ name: `T${i}`, capacity: i % 2 === 0 ? 2 : 4, sortOrder: i }).run();
  }
  if (wanted > 0) console.log(`[init] ${wanted} dining tables created`);
}

sqlite.close();
