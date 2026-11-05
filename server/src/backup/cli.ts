/**
 * Backup and restore from the command line (run in the POS folder on the reception computer):
 *
 *   npm run db:backup                     make a verified backup now (safe while the server runs)
 *   npm run db:backups                    list backups
 *   npm run db:restore -- --check <file>  only check a backup file
 *   npm run db:restore -- <file|latest>   restore (server must be stopped). The current database
 *                                         is backed up first ("pre-restore") so nothing is lost.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config';
import { BackupError, createBackupService, restoreFromBackup, verifyDatabaseFile } from './backupService';

const backupOpts = { dir: config.backup.dir, keepDays: config.backup.keepDays, keepRecentHours: config.backup.keepRecentHours, minKeep: config.backup.minKeep };

/** Is something listening on the POS port? (Works for HTTP and HTTPS.) */
function serverRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: config.port });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
    s.setTimeout(1500, () => {
      s.destroy();
      resolve(false);
    });
  });
}

const fmtCounts = (c: Record<string, number>) => Object.entries(c).map(([k, v]) => `${k}=${v}`).join('  ');

async function backup() {
  if (!fs.existsSync(config.databasePath)) throw new BackupError(`No database at ${config.databasePath}`);
  const sqlite = new Database(config.databasePath, { fileMustExist: true });
  try {
    const svc = createBackupService({ sqlite, ...backupOpts });
    const file = await svc.backupNow('manual');
    console.log(`Saved ${file!.path}`);
    console.log(`Contents: ${fmtCounts(verifyDatabaseFile(file!.path))}`);
  } finally {
    sqlite.close();
  }
}

function listBackups() {
  const sqlite = new Database(':memory:');
  const svc = createBackupService({ sqlite, ...backupOpts });
  const files = svc.list();
  console.log(`Backup folder: ${svc.dir}`);
  if (!files.length) console.log('No backups yet.');
  for (const f of files) console.log(`  ${f.name}   ${Math.ceil(f.sizeBytes / 1024)} KB`);
  sqlite.close();
}

async function restore(arg: string | undefined, checkOnly: boolean) {
  if (!arg) throw new BackupError('Say which backup: npm run db:restore -- <file>   (or "latest")');
  const svcList = createBackupService({ sqlite: new Database(':memory:'), ...backupOpts });
  const source = arg === 'latest' ? svcList.list()[0]?.path : path.resolve(arg);
  if (!source) throw new BackupError(`No backups found in ${svcList.dir}`);

  const counts = verifyDatabaseFile(source);
  console.log(`Backup OK: ${source}`);
  console.log(`Contents:  ${fmtCounts(counts)}`);
  if (checkOnly) return;

  if (await serverRunning()) throw new BackupError(`The POS server is still running on port ${config.port}. Stop it first (Ctrl+C in its window), then run this again.`);

  const { safetyBackup, counts: after } = await restoreFromBackup(source, config.databasePath, backupOpts);
  if (safetyBackup) console.log(`Current database saved first: ${safetyBackup.path}`);
  console.log(`Restored. Database now: ${fmtCounts(after)}`);
  console.log('Start the server again with: npm start');
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'backup') return backup();
  if (cmd === 'list') return listBackups();
  if (cmd === 'restore') {
    const checkOnly = rest.includes('--check');
    return restore(rest.find((a) => a !== '--check'), checkOnly);
  }
  throw new BackupError('Usage: backup | list | restore [--check] <file|latest>');
}

main().catch((e) => {
  console.error(e instanceof BackupError ? `Error: ${e.message}` : e);
  process.exit(1);
});
