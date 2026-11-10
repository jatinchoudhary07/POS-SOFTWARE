import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/**
 * All configuration comes from environment variables (see .env.example).
 * Validating them at startup means a typo fails loudly instead of silently.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_PATH: z.string().default('./data/pos.db'),
  CORS_ORIGINS: z.string().default(''),
  // Sign-in sessions: inactivity timeout (sliding) and absolute maximum.
  // 0 (the default) = never: a login stays signed in until the person signs out themselves.
  SESSION_IDLE_HOURS: z.coerce.number().min(0).max(24 * 365 * 10).default(0),
  SESSION_MAX_DAYS: z.coerce.number().min(0).max(3650).default(0),
  // 'auto' marks the cookie Secure only when the request came over HTTPS.
  COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
  // Removed in Day 4 (replaced by logins). Only read to warn if it is still set.
  ADMIN_TOKEN: z.string().default(''),
  // Automatic backups (see src/backup). Default folder is outside the app folder, in the
  // Windows user's profile: C:\Users\<you>\RestaurantPOS\backups
  BACKUP_DIR: z.string().default(''),
  BACKUP_INTERVAL_HOURS: z.coerce.number().min(0).max(24 * 7).default(1),
  BACKUP_KEEP_DAYS: z.coerce.number().int().min(1).max(3650).default(60),
  BACKUP_KEEP_RECENT_HOURS: z.coerce.number().min(0).max(24 * 30).default(48),
  BACKUP_MIN_KEEP: z.coerce.number().int().min(1).max(1000).default(10),
  // Optional HTTPS (see `npm run tls:setup`). Both must be set to enable it.
  TLS_CERT_FILE: z.string().default(''),
  TLS_KEY_FILE: z.string().default(''),
  // Default name used until the receipt settings have been saved once.
  RESTAURANT_NAME: z.string().default('Two Hearts Cafe'),
  // Enable when behind a reverse proxy/load balancer (e.g. Render, Railway, Fly.io, Nginx)
  TRUST_PROXY: z.string().default(''),
  // Alerts for locked phones (Web Push). Make a pair once with: npx web-push generate-vapid-keys
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  VAPID_SUBJECT: z.string().default(''),
  // Paytm card/UPI terminal. OFF unless PAYTM_ENABLED=true. Stage 1 only has the practice (mock) terminal.
  PAYTM_ENABLED: z.enum(['true', 'false']).default('false'),
  PAYTM_MODE: z.enum(['mock', 'live']).default('mock'),
  PAYTM_MOCK_SCENARIO: z.enum(['SUCCESS', 'CUSTOMER_CANCEL', 'BANK_REJECT', 'TERMINAL_OFFLINE', 'SALE_TIMEOUT', 'ACCEPTED_NO_RESULT', 'DUPLICATE_ID', 'TERMINAL_BUSY', 'INVALID_CHECKSUM', 'MISMATCH_AMOUNT', 'MISMATCH_MID', 'MISMATCH_TID']).default('SUCCESS'),
  PAYTM_POLL_FAST_MS: z.coerce.number().int().min(200).max(60_000).default(3000),
  PAYTM_POLL_SLOW_MS: z.coerce.number().int().min(500).max(300_000).default(10_000),
  PAYTM_MAX_WAIT_MINUTES: z.coerce.number().min(1).max(60).default(10),
  PAYTM_SALE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
});

const env = envSchema.parse(process.env);

/** "Never": ten years, which is far longer than any phone will outlive. */
const NEVER_MS = 10 * 365 * 24 * 60 * 60_000;

export const config = {
  env: env.NODE_ENV,
  port: env.PORT,
  host: env.HOST,
  // Resolve relative to the server/ folder (the npm scripts run from there).
  databasePath:
    env.DATABASE_PATH === ':memory:' ? ':memory:' : path.resolve(process.cwd(), env.DATABASE_PATH),
  backup: {
    dir: env.BACKUP_DIR ? path.resolve(process.cwd(), env.BACKUP_DIR) : path.join(os.homedir(), 'RestaurantPOS', 'backups'),
    intervalMs: env.BACKUP_INTERVAL_HOURS * 3600_000,
    keepDays: env.BACKUP_KEEP_DAYS,
    keepRecentHours: env.BACKUP_KEEP_RECENT_HOURS,
    minKeep: env.BACKUP_MIN_KEEP,
  },
  tls:
    env.TLS_CERT_FILE || env.TLS_KEY_FILE
      ? { certFile: path.resolve(process.cwd(), env.TLS_CERT_FILE), keyFile: path.resolve(process.cwd(), env.TLS_KEY_FILE) }
      : null,
  sessionIdleMs: env.SESSION_IDLE_HOURS > 0 ? env.SESSION_IDLE_HOURS * 60 * 60_000 : NEVER_MS,
  sessionMaxMs: env.SESSION_MAX_DAYS > 0 ? env.SESSION_MAX_DAYS * 24 * 60 * 60_000 : NEVER_MS,
  cookieSecure: env.COOKIE_SECURE === 'auto' ? ('auto' as const) : env.COOKIE_SECURE === 'true',
  legacyAdminTokenSet: env.ADMIN_TOKEN !== '',
  restaurantName: env.RESTAURANT_NAME,
  corsOrigins: env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  trustProxy: env.TRUST_PROXY || false,
  paytm: {
    enabled: env.PAYTM_ENABLED === 'true',
    mode: env.PAYTM_MODE,
    mockScenario: env.PAYTM_MOCK_SCENARIO,
    pollFastMs: env.PAYTM_POLL_FAST_MS,
    pollSlowMs: env.PAYTM_POLL_SLOW_MS,
    maxWaitMinutes: env.PAYTM_MAX_WAIT_MINUTES,
    saleTimeoutMs: env.PAYTM_SALE_TIMEOUT_MS,
  },
  push: { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || undefined },
};
