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
  SESSION_IDLE_HOURS: z.coerce.number().positive().max(24 * 30).default(12),
  SESSION_MAX_DAYS: z.coerce.number().positive().max(90).default(7),
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
});

const env = envSchema.parse(process.env);

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
  sessionIdleMs: env.SESSION_IDLE_HOURS * 60 * 60_000,
  sessionMaxMs: env.SESSION_MAX_DAYS * 24 * 60 * 60_000,
  cookieSecure: env.COOKIE_SECURE === 'auto' ? ('auto' as const) : env.COOKIE_SECURE === 'true',
  legacyAdminTokenSet: env.ADMIN_TOKEN !== '',
  restaurantName: env.RESTAURANT_NAME,
  corsOrigins: env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  trustProxy: env.TRUST_PROXY || false,
};
