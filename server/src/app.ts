import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import type { DB } from './db/client';
import { EventBus } from './events';
import type { BackupService } from './backup/backupService';
import { currentSession, loadSession, requireRole, sameOriginWrites } from './lib/auth';
import type { LoginLimiter } from './lib/loginLimiter';
import { AppError } from './lib/errors';
import type { PaymentProvider } from './payments/provider';
import { authRouter } from './routes/auth';
import { orderBillingRouter, paymentsRouter, reportsRouter, settingsRouter } from './routes/billing';
import { menuRouter } from './routes/menu';
import { analyticsRouter } from './routes/analytics';
import { tablesRouter } from './routes/tables';
import { kitchenRouter, ordersRouter } from './routes/orders';
import { createAuthService } from './services/authService';
import { createBillingService } from './services/billingService';
import { createMenuService } from './services/menuService';
import { createAnalyticsService } from './services/analyticsService';
import { createTablesService } from './services/tablesService';
import { createOrderService } from './services/orderService';
import { createCreditService } from './services/creditService';
import { creditRouter } from './routes/credit';

export interface AppOptions {
  db: DB;
  events?: EventBus;
  corsOrigins?: string[];
  /** Folder with the built React app (client/dist). Served if it exists. */
  staticDir?: string;
  now?: () => Date;
  /** Session inactivity timeout and hard limit. */
  sessionIdleMs?: number;
  sessionMaxMs?: number;
  /** 'auto' = Secure cookie only over HTTPS. */
  cookieSecure?: 'auto' | boolean;
  loginLimiter?: LoginLimiter;
  ipLoginLimiter?: LoginLimiter;
  /** Automatic backups; also used to back up before Superadmin changes. */
  backups?: BackupService;
  defaultRestaurantName?: string;
  /** Payment devices. None in production yet (no verified terminal integration). */
  paymentProviders?: PaymentProvider[];
  providerTimeoutMs?: number;
  /** Express trust proxy configuration for hosting platforms behind reverse proxies */
  trustProxy?: boolean | string | number;
}

/**
 * Builds the Express app without starting a server. Tests call this directly
 * with an in-memory database; src/index.ts calls it with the real one.
 */
export function createApp({
  db,
  events = new EventBus(),
  corsOrigins = [],
  staticDir,
  now,
  sessionIdleMs,
  sessionMaxMs,
  cookieSecure = 'auto',
  loginLimiter,
  ipLoginLimiter,
  backups,
  defaultRestaurantName = 'My Restaurant',
  paymentProviders = [],
  providerTimeoutMs,
  trustProxy,
}: AppOptions) {
  const app = express();
  if (trustProxy !== undefined && trustProxy !== false && trustProxy !== '') {
    app.set('trust proxy', trustProxy);
  }
  const menu = createMenuService(db);
  const orders = createOrderService(db, events, now);
  const billing = createBillingService(db, events, {
    loadOrder: orders.getById,
    defaultRestaurantName,
    providers: paymentProviders,
    providerTimeoutMs,
    now,
  });
  const auth = createAuthService(db, events, { idleMs: sessionIdleMs, maxMs: sessionMaxMs, now, limiter: loginLimiter, ipLimiter: ipLoginLimiter });

  app.disable('x-powered-by');
  // Only explicitly listed origins may call the API from another site.
  app.use(cors({ origin: corsOrigins.length > 0 ? corsOrigins : false, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  // Every /api request: resolve the session cookie to a user (or none), block cross-site writes.
  // Each router then states which roles may use each route (lib/auth.ts requireRole).
  app.use('/api', loadSession(auth), sameOriginWrites(corsOrigins));

  // Before a Superadmin changes settings, logins, menu prices or records a refund, take a backup
  // (skipped if nothing changed since the last one). Only for a signed-in Superadmin, so anonymous
  // requests can't be used to fill the disk. A failed backup is reported but doesn't block the change.
  // Note: Table configuration changes (POST/PATCH/PUT to /tables) trigger backup, but customer billing (/tables/:id/bill or /payments) does NOT.
  const ADMIN_CHANGE = /^\/api\/(settings\/?$|auth\/accounts\/|menu\/|tables\/?$|tables\/\d+\/?$|payments\/\d+\/refund$)/;
  app.use(async (req, res, next) => {
    if (backups && req.method !== 'GET' && ADMIN_CHANGE.test(req.path) && currentSession(res)?.user.role === 'SUPERADMIN') {
      await backups.tryBackup('before-change', { onlyIfChanged: true });
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });
  app.use('/api/auth', authRouter(auth, { cookieSecure }));
  app.use('/api/menu', menuRouter(menu));
  const tablesService = createTablesService(db, { loadOrder: orders.getById, events });
  app.use('/api/tables', tablesRouter(tablesService, billing));
  app.use('/api/orders', ordersRouter(orders));
  app.use('/api/orders', orderBillingRouter(billing));
  app.use('/api/kitchen', kitchenRouter(orders));
  app.use('/api/payments', paymentsRouter(billing));
  app.use('/api/settings', settingsRouter(billing));
  app.use('/api/reports', reportsRouter(billing));
  app.use('/api/credit', creditRouter(createCreditService(db, now)));
  app.use('/api/reports', analyticsRouter(createAnalyticsService(db)));

  // Backup status for the Superadmin (Settings → Backups). No file downloads over the network.
  app.get('/api/admin/backups', requireRole('SUPERADMIN'), (_req, res) => {
    if (!backups) return res.json({ enabled: false });
    res.json({ enabled: true, status: backups.status(), files: backups.list().slice(0, 15).map((f) => ({ name: f.name, sizeBytes: f.sizeBytes, createdAt: f.createdAt.toISOString(), reason: f.reason })) });
  });
  app.post('/api/admin/backups', requireRole('SUPERADMIN'), async (_req, res) => {
    if (!backups) throw new AppError(503, 'BACKUPS_DISABLED', 'Backups are not configured');
    try {
      const file = await backups.backupNow('manual');
      res.status(201).json({ file: file && { name: file.name, sizeBytes: file.sizeBytes }, status: backups.status() });
    } catch (e) {
      throw new AppError(503, 'BACKUP_FAILED', (e as Error).message);
    }
  });
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown API route' } });
  });

  // In production the same server also serves the frontend, so both computers
  // just open http://<reception-ip>:<PORT> in a browser.
  if (staticDir && fs.existsSync(path.join(staticDir, 'index.html'))) {
    app.use(express.static(staticDir));
    // Do not let SPA fallback intercept API, socket.io, or missing file requests (with extensions)
    app.get(/^\/(?!api\/|socket\.io\/).*/, (req, res, next) => {
      // If request looks like a missing file (e.g. /assets/xyz.js), return 404 instead of index.html
      if (path.extname(req.path)) {
        return res.status(404).end();
      }
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: first?.message ?? 'Invalid request',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
      return;
    }
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    // Malformed JSON body from express.json()
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
      return;
    }
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request is too large' } });
      return;
    }
    console.error('Unexpected error:', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on the server' } });
  };
  app.use(errorHandler);

  return { app, events, auth };
}

export const defaultStaticDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../client/dist',
);
