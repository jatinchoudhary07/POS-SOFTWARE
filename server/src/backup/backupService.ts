import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Database backups using SQLite's ONLINE BACKUP API (better-sqlite3 `db.backup()`). This produces a
 * consistent copy even while the server is writing (WAL mode). Copying pos.db with the file
 * system is NOT safe: recent changes may still be in pos.db-wal, or a write may be half done.
 *
 * Each backup is written to "<name>.partial", checked (integrity check + required tables), and only
 * then renamed to its final name — so every pos-*.db file in the folder is a verified backup.
 * Backups never contain anything that is not already in the database (no extra secrets), but the
 * database itself holds password hashes and payment records: keep the folder private.
 */

export const REQUIRED_TABLES = [
  'orders',
  'order_items',
  'menu_categories',
  'menu_items',
  'bills',
  'payments',
  'restaurant_settings',
  'tax_rates',
  'users',
  '__drizzle_migrations',
] as const;

/** Row counts reported after a backup or restore (no data contents, only numbers). */
export const COUNT_TABLES = ['orders', 'order_items', 'bills', 'payments', 'menu_items', 'tax_rates', 'restaurant_settings', 'users'] as const;

const FILE_RE = /^pos-(\d{8})-(\d{6})-([a-z-]+)\.db$/;

export interface BackupFile {
  name: string;
  path: string;
  sizeBytes: number;
  createdAt: Date;
  reason: string;
}

export interface BackupStatus {
  dir: string;
  intervalHours: number;
  keepDays: number;
  minKeep: number;
  lastSuccess: { at: string; file: string; sizeBytes: number } | null;
  lastError: { at: string; message: string } | null;
  lastSkipped: { at: string; reason: string } | null;
  count: number;
}

export interface BackupOptions {
  /** Open connection to the live database. */
  sqlite: Database.Database;
  dir: string;
  /** Scheduled backup interval (0 = no schedule). */
  intervalMs?: number;
  /** Keep one backup per day for this many days. */
  keepDays?: number;
  /** Keep every backup from the last N hours. */
  keepRecentHours?: number;
  /** Always keep at least this many newest backups, however old. */
  minKeep?: number;
  now?: () => Date;
  log?: (msg: string) => void;
  /** Free bytes on the backup drive (injectable for tests). */
  freeBytes?: (dir: string) => Promise<number>;
}

export class BackupError extends Error {}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const stamp = (d: Date) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function parseName(name: string): { createdAt: Date; reason: string } | null {
  const m = FILE_RE.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1].slice(0, 4), m[1].slice(4, 6), m[1].slice(6), m[2].slice(0, 2), m[2].slice(2, 4), m[2].slice(4)].map(Number);
  return { createdAt: new Date(y, mo - 1, d, h, mi, s), reason: m[3] };
}

/**
 * Opens a database file read-only and checks it is a healthy POS database.
 * Returns row counts on success; throws BackupError with a readable message otherwise.
 */
export function verifyDatabaseFile(file: string): Record<string, number> {
  if (!fs.existsSync(file)) throw new BackupError(`File not found: ${file}`);
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const check = db.pragma('quick_check', { simple: true });
    if (check !== 'ok') throw new BackupError(`Integrity check failed: ${String(check)}`);
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
    const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
    if (missing.length) throw new BackupError(`Not a complete POS database (missing tables: ${missing.join(', ')})`);
    const counts: Record<string, number> = {};
    for (const t of COUNT_TABLES) counts[t] = (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
    return counts;
  } catch (e) {
    if (e instanceof BackupError) throw e;
    throw new BackupError(`Cannot read database file: ${(e as Error).message}`);
  } finally {
    db?.close();
  }
}

/**
 * A cheap "has anything changed?" fingerprint, so hourly backups are skipped overnight when the
 * restaurant is closed. Sessions are deliberately ignored (they change on every sign-in).
 */
function fingerprint(sqlite: Database.Database): string {
  const parts = ['orders', 'order_items', 'bills', 'payments', 'menu_items', 'menu_categories', 'tax_rates', 'restaurant_settings', 'users'].map((t) => {
    const hasUpdated = t !== 'order_items';
    const row = sqlite.prepare(`SELECT COUNT(*) AS c${hasUpdated ? ', MAX(updated_at) AS u' : ', MAX(id) AS u'} FROM ${t}`).get() as { c: number; u: number | null };
    return `${t}:${row.c}:${row.u ?? 0}`;
  });
  return parts.join('|');
}

async function defaultFreeBytes(dir: string): Promise<number> {
  const s = await fs.promises.statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

export function createBackupService(opts: BackupOptions) {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((m: string) => console.log(m));
  const keepDays = opts.keepDays ?? 60;
  const keepRecentHours = opts.keepRecentHours ?? 48;
  const minKeep = Math.max(1, opts.minKeep ?? 10);
  const freeBytes = opts.freeBytes ?? defaultFreeBytes;
  const dir = path.resolve(opts.dir);

  let lastSuccess: BackupStatus['lastSuccess'] = null;
  let lastError: BackupStatus['lastError'] = null;
  let lastSkipped: BackupStatus['lastSkipped'] = null;
  let lastFingerprint: string | null = null;
  let running: Promise<BackupFile | null> | null = null;
  let timer: NodeJS.Timeout | null = null;

  function ensureDir() {
    try {
      // 0o700: only this user may read it (POSIX). On Windows the folder inherits the user
      // profile's permissions, which already exclude other non-admin users.
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      throw new BackupError(
        code === 'EACCES' || code === 'EPERM'
          ? `No permission to write to the backup folder ${dir}`
          : `Cannot use the backup folder ${dir} (${code ?? (e as Error).message})`,
      );
    }
  }

  function list(): BackupFile[] {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .map((name) => {
        const parsed = parseName(name);
        if (!parsed) return null;
        const p = path.join(dir, name);
        return { name, path: p, sizeBytes: fs.statSync(p).size, ...parsed };
      })
      .filter((f): f is BackupFile => f !== null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.name.localeCompare(a.name));
  }

  /**
   * Retention: always keep the newest `minKeep`; keep everything from the last `keepRecentHours`;
   * keep the newest backup of each day for `keepDays`; delete the rest. The backup just made is
   * always the newest, so it is never deleted, and the folder never drops below `minKeep`.
   */
  function prune(): string[] {
    const files = list();
    const t = now().getTime();
    const seenDays = new Set<string>();
    const deleted: string[] = [];
    files.forEach((f, i) => {
      const ageMs = t - f.createdAt.getTime();
      const day = dayKey(f.createdAt);
      const firstOfDay = !seenDays.has(day);
      seenDays.add(day);
      const keep = i < minKeep || ageMs < keepRecentHours * 3600_000 || (firstOfDay && ageMs < keepDays * 86_400_000);
      if (!keep) {
        try {
          fs.unlinkSync(f.path);
          deleted.push(f.name);
        } catch (e) {
          log(`Backup cleanup: could not delete ${f.name} (${(e as Error).message})`);
        }
      }
    });
    // Leftovers from interrupted backups (and side files from earlier versions).
    for (const name of fs.readdirSync(dir)) {
      if (/\.partial(-wal|-shm)?$/.test(name)) {
        const p = path.join(dir, name);
        if (t - fs.statSync(p).mtimeMs > 3600_000) fs.rmSync(p, { force: true });
      }
    }
    return deleted;
  }

  async function doBackup(reason: string, onlyIfChanged: boolean): Promise<BackupFile | null> {
    const safeReason = reason.toLowerCase().replace(/[^a-z-]/g, '-').slice(0, 24) || 'manual';
    let partial: string | null = null;
    try {
      ensureDir();
      const fp = fingerprint(opts.sqlite);
      if (onlyIfChanged && fp === lastFingerprint) {
        lastSkipped = { at: now().toISOString(), reason: 'No changes since the last backup' };
        return null;
      }
      const dbFile = opts.sqlite.name;
      const dbSize = dbFile && fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0;
      const walSize = dbFile && fs.existsSync(`${dbFile}-wal`) ? fs.statSync(`${dbFile}-wal`).size : 0;
      const needed = (dbSize + walSize) * 2 + 20 * 1024 * 1024;
      const free = await freeBytes(dir);
      if (free < needed) {
        throw new BackupError(
          `Not enough free disk space for a backup in ${dir}: ${Math.floor(free / 1048576)} MB free, about ${Math.ceil(needed / 1048576)} MB needed`,
        );
      }

      const at = now();
      let name = `pos-${stamp(at)}-${safeReason}.db`;
      for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `pos-${stamp(at)}-${safeReason}-${'x'.repeat(n - 1)}.db`;
      const target = path.join(dir, name);
      partial = `${target}.partial`;
      await opts.sqlite.backup(partial);
      // The copy inherits WAL mode from the live database. Switch it to a self-contained single
      // file, so checking/opening it later never creates "-wal"/"-shm" side files.
      const copy = new Database(partial);
      copy.pragma('journal_mode = DELETE');
      copy.close();
      verifyDatabaseFile(partial);
      for (const side of ['-wal', '-shm']) fs.rmSync(`${partial}${side}`, { force: true });
      fs.renameSync(partial, target);
      partial = null;
      try {
        fs.chmodSync(target, 0o600);
      } catch {
        /* not supported on every file system */
      }

      lastFingerprint = fp;
      const size = fs.statSync(target).size;
      lastSuccess = { at: at.toISOString(), file: name, sizeBytes: size };
      lastError = null;
      const deleted = prune();
      log(`Backup saved: ${name} (${Math.ceil(size / 1024)} KB)${deleted.length ? `; removed ${deleted.length} old backup(s)` : ''}`);
      return { name, path: target, sizeBytes: size, createdAt: at, reason: safeReason };
    } catch (e) {
      if (partial) for (const f of [partial, `${partial}-wal`, `${partial}-shm`]) fs.rmSync(f, { force: true });
      const message = e instanceof BackupError ? e.message : `Backup failed: ${(e as Error).message}`;
      lastError = { at: now().toISOString(), message };
      log(`BACKUP FAILED: ${message}`);
      throw e instanceof BackupError ? e : new BackupError(message);
    }
  }

  return {
    dir,
    list,

    /** Make a verified backup now. Concurrent calls share one run. Throws BackupError on failure. */
    backupNow(reason = 'manual', { onlyIfChanged = false } = {}): Promise<BackupFile | null> {
      running ??= doBackup(reason, onlyIfChanged).finally(() => {
        running = null;
      });
      return running;
    },

    /** Like backupNow but never throws (for the schedule and pre-change hooks); the error is in status(). */
    async tryBackup(reason: string, options: { onlyIfChanged?: boolean } = {}): Promise<BackupFile | null> {
      try {
        return await this.backupNow(reason, options);
      } catch {
        return null;
      }
    },

    status(): BackupStatus {
      return {
        dir,
        intervalHours: (opts.intervalMs ?? 0) / 3600_000,
        keepDays,
        minKeep,
        lastSuccess,
        lastError,
        lastSkipped,
        count: list().length,
      };
    },

    /** Start the schedule (hourly by default); backups are skipped when nothing changed. */
    start() {
      if (!opts.intervalMs || timer) return;
      timer = setInterval(() => void this.tryBackup('scheduled', { onlyIfChanged: true }), opts.intervalMs);
      timer.unref();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },

    prune,
  };
}

export type BackupService = ReturnType<typeof createBackupService>;

/**
 * Replaces `targetDb` with the backup `sourceFile`. The server must not be running.
 *  1. checks the backup (integrity + POS tables)
 *  2. saves the CURRENT database as a "pre-restore" backup (aborts if that fails)
 *  3. copies the backup next to the target, checks the copy, removes the old -wal/-shm, swaps it in
 * Returns the safety backup (if there was a database) and the restored row counts.
 */
export async function restoreFromBackup(
  sourceFile: string,
  targetDb: string,
  backupOpts: Omit<BackupOptions, 'sqlite'>,
): Promise<{ safetyBackup: BackupFile | null; counts: Record<string, number> }> {
  verifyDatabaseFile(sourceFile);
  if (path.resolve(sourceFile) === path.resolve(targetDb)) throw new BackupError('That is the live database itself, not a backup');
  fs.mkdirSync(path.dirname(targetDb), { recursive: true });

  let safetyBackup: BackupFile | null = null;
  if (fs.existsSync(targetDb)) {
    const current = new Database(targetDb, { fileMustExist: true });
    try {
      safetyBackup = await createBackupService({ ...backupOpts, sqlite: current }).backupNow('pre-restore');
    } finally {
      current.close(); // checkpoints the WAL into the file and removes -wal/-shm
    }
  }

  const staging = `${targetDb}.restoring`;
  fs.copyFileSync(sourceFile, staging);
  try {
    verifyDatabaseFile(staging);
  } catch (e) {
    fs.rmSync(staging, { force: true });
    throw e;
  }
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${targetDb}${suffix}`, { force: true });
  fs.renameSync(staging, targetDb);
  return { safetyBackup, counts: verifyDatabaseFile(targetDb) };
}
