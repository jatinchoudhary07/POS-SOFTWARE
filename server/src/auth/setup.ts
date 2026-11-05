/**
 * First-time Superadmin setup (and password recovery), run on the reception computer:
 *
 *   npm run auth:setup             create the Superadmin login (asks for username + password)
 *   npm run auth:setup -- --reset  replace the Superadmin's username/password (signs it out everywhere)
 *
 * For a non-interactive setup, set SUPERADMIN_USERNAME and SUPERADMIN_PASSWORD in the environment
 * (or temporarily in server/.env) — remove the password again afterwards.
 * Reception and Kitchen logins are then created by the Superadmin in Settings → Logins.
 */
import readline from 'node:readline';
import { config } from '../config';
import { openDatabase, runMigrations } from '../db/client';
import { EventBus } from '../events';
import { AppError } from '../lib/errors';
import { createAuthService, MIN_PASSWORD_LENGTH } from '../services/authService';

/** One readline interface for all questions (separate ones would lose buffered input). */
function createPrompt() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY ?? false });
  const lines: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let ended = false;
  let muted = false;
  rl.on('line', (line) => (waiting.length ? waiting.shift()!(line) : lines.push(line)));
  rl.on('close', () => {
    ended = true;
    while (waiting.length) waiting.shift()!(null);
  });
  // Don't echo password characters on a real terminal (Windows cmd/PowerShell and Unix).
  const rlAny = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
  const write = rlAny._writeToOutput.bind(rl);
  rlAny._writeToOutput = (s: string) => {
    if (!muted || s === '\r\n' || s === '\n') write(s);
  };
  return {
    async ask(question: string, hidden = false): Promise<string> {
      process.stdout.write(question);
      muted = hidden;
      const line = lines.length ? lines.shift()! : ended ? null : await new Promise<string | null>((r) => waiting.push(r));
      muted = false;
      if (hidden && process.stdin.isTTY) process.stdout.write('\n');
      if (line === null) throw new AppError(400, 'VALIDATION_ERROR', 'Input ended before all questions were answered');
      return line;
    },
    close: () => rl.close(),
  };
}

async function main() {
  const reset = process.argv.includes('--reset');
  const { db, sqlite } = openDatabase(config.databasePath);
  runMigrations(db);
  const auth = createAuthService(db, new EventBus());

  if (auth.hasSuperadmin() && !reset) {
    console.log('A Superadmin login already exists. Nothing changed.');
    console.log('Forgot the password? Run:  npm run auth:setup -- --reset');
    sqlite.close();
    return;
  }

  let username = process.env.SUPERADMIN_USERNAME ?? '';
  let password = process.env.SUPERADMIN_PASSWORD ?? '';
  if (!username || !password) {
    const prompt = createPrompt();
    try {
      if (!username) username = await prompt.ask('Superadmin username: ');
      if (!password) {
        password = await prompt.ask(`Superadmin password (at least ${MIN_PASSWORD_LENGTH.SUPERADMIN} characters): `, true);
        const again = await prompt.ask('Repeat password: ', true);
        if (again !== password) throw new AppError(400, 'VALIDATION_ERROR', 'The passwords do not match');
      }
    } finally {
      prompt.close();
    }
  }

  if (reset) {
    const { createBackupService } = await import('../backup/backupService');
    const file = await createBackupService({ sqlite, ...config.backup }).tryBackup('before-change');
    if (file) console.log(`Backup saved first: ${file.path}`);
  }
  const result = await auth.bootstrapSuperadmin(username, password, { reset });
  sqlite.close();
  console.log(result === 'created' ? `Superadmin "${username.trim()}" created.` : `Superadmin credentials replaced; old sessions signed out.`);
  console.log('Sign in at http://<this computer>:' + config.port + ' and create the Reception and Kitchen logins in Settings → Logins.');
}

main().catch((e) => {
  console.error(e instanceof AppError ? `Error: ${e.message}` : e);
  process.exit(1);
});
