import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createApp, defaultStaticDir } from './app';
import { createBackupService } from './backup/backupService';
import { config } from './config';
import { openDatabase, runMigrations } from './db/client';
import { attachRealtime } from './realtime';

const dbExisted = fs.existsSync(config.databasePath);
const { db, sqlite } = openDatabase(config.databasePath);

// Automatic backups (online SQLite backup API; see src/backup/backupService.ts).
const backups = createBackupService({ sqlite, ...config.backup });

// Back up BEFORE applying migrations, so an upgrade can always be undone.
if (dbExisted) {
  const hasTables = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'orders'").get();
  if (hasTables) {
    const startupBackup = await backups.tryBackup('startup');
    if (!startupBackup) console.warn('  WARNING: the startup backup failed (see message above). The server will still start.');
  }
}

// Apply pending migrations on every start so the database is never behind the code.
runMigrations(db);

const { app, events, auth } = createApp({
  db,
  corsOrigins: config.corsOrigins,
  staticDir: defaultStaticDir,
  sessionIdleMs: config.sessionIdleMs,
  sessionMaxMs: config.sessionMaxMs,
  cookieSecure: config.cookieSecure,
  defaultRestaurantName: config.restaurantName,
  backups,
  trustProxy: config.trustProxy,
  // No payment terminal is integrated yet; cash and manually verified UPI need no provider.
  paymentProviders: [],
});

// HTTPS if a certificate is configured (npm run tls:setup), otherwise plain HTTP.
let server: http.Server;
if (config.tls) {
  try {
    server = https.createServer({ cert: fs.readFileSync(config.tls.certFile), key: fs.readFileSync(config.tls.keyFile) }, app);
  } catch (e) {
    console.error(`Cannot start HTTPS: ${(e as Error).message}`);
    console.error('Check TLS_CERT_FILE and TLS_KEY_FILE in server/.env, or remove both lines to use plain HTTP.');
    process.exit(1);
  }
} else {
  server = http.createServer(app);
}
const scheme = config.tls ? 'https' : 'http';

// Socket.IO shares the same server and port as the REST API.
const realtime = attachRealtime(server, events, auth, { corsOrigins: config.corsOrigins });

realtime.io.on('connection', (socket) => {
  const transport = socket.conn.transport.name;
  console.log(`${socket.data.role} screen connected via ${transport} (${realtime.clientCount()} online)`);
  socket.conn.once('upgrade', () => console.log(`${socket.data.role} screen upgraded to websocket`));
  socket.on('disconnect', () => console.log(`${socket.data.role} screen disconnected (${realtime.clientCount()} online)`));
});
events.on('order.created', (order) => {
  console.log(`Order ${order.orderNumber} created (${order.itemCount} items)`);
});
events.on('order.updated', (order, meta) => {
  if (meta?.kitchen !== false) console.log(`Order ${order.orderNumber} -> ${order.status}`);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Is the POS server already running? Change PORT in server/.env if needed.`);
    process.exit(1);
  }
  throw err;
});

/** IPv4 addresses of this computer; private LAN ranges (192.168.x, 10.x, 172.16–31.x) first. */
function lanAddresses(): string[] {
  const all = Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
  const isPrivate = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return [...all.filter(isPrivate), ...all.filter((ip) => !isPrivate(ip))];
}

server.listen(config.port, config.host, () => {
  const line = '─'.repeat(64);
  console.log(line);
  console.log(` Restaurant POS is running (${scheme.toUpperCase()}). Keep this window open.`);
  console.log(line);
  console.log(` Reception (this PC):  ${scheme}://localhost:${config.port}`);
  const ips = config.host === '0.0.0.0' ? lanAddresses() : [];
  if (ips.length) {
    for (const ip of ips) console.log(` Kitchen PC:           ${scheme}://${ip}:${config.port}/kitchen`);
  } else if (config.host === '0.0.0.0') {
    console.log(' No network address found — is this PC connected to the restaurant Wi-Fi/LAN?');
  } else {
    console.log(` Only reachable from this PC (HOST=${config.host}).`);
  }
  console.log(` Database: ${config.databasePath}`);
  console.log(` Backups:  ${backups.dir} (every ${config.backup.intervalMs / 3600_000} h when data changed)`);
  if (!config.tls) console.log(' Connection is NOT encrypted (plain HTTP) — use only on a private staff network.');
  if (!fs.existsSync(path.join(defaultStaticDir, 'index.html'))) {
    console.log(' WARNING: the app screens are not built yet. Stop the server and run: npm run build');
  }
  if (!auth.hasSuperadmin()) console.log(' No Superadmin login exists yet. Create one with:  npm run auth:setup');
  if (config.legacyAdminTokenSet) console.log(' Note: ADMIN_TOKEN is no longer used (replaced by logins). You can remove it from server/.env.');
  console.log(line);
  backups.start();
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down: saving a final backup…');
  backups.stop();
  // Never hang on shutdown: give the final backup a few seconds at most.
  const finalBackup = Promise.race([backups.tryBackup('shutdown', { onlyIfChanged: true }), new Promise((r) => setTimeout(r, 5000))]);
  void finalBackup.then(() =>
    // io.close() also closes the HTTP server.
    realtime.close().then(() => {
      sqlite.close();
      console.log('Stopped.');
      process.exit(0);
    }),
  );
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
