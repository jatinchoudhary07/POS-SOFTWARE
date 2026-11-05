import { Router } from 'express';
import { z } from 'zod';
import { ORDER_TYPES } from '../db/schema';
import { requireRole } from '../lib/auth';
import { ORDER_PAYMENT_STATUSES } from '../lib/paymentStatus';
import type { AnalyticsService } from '../services/analyticsService';

const dateKey = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .refine((v) => {
    const [y, m, d] = v.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }, 'Not a real date');

const rangeQuery = z.object({ from: dateKey, to: dateKey });
const historyQuery = rangeQuery.extend({
  q: z.string().trim().max(60).optional(),
  payment: z.enum([...ORDER_PAYMENT_STATUSES, 'CANCELLED']).optional(),
  type: z.enum(ORDER_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Owner reports: Superadmin only (reception keeps the single-day summary at /api/reports/daily). */
export function analyticsRouter(analytics: AnalyticsService): Router {
  const router = Router();
  router.get('/analytics', requireRole('SUPERADMIN'), (req, res) => {
    const { from, to } = rangeQuery.parse(req.query);
    res.json({ analytics: analytics.analytics(from, to) });
  });

  router.get('/history', requireRole('SUPERADMIN'), (req, res) => {
    res.json(analytics.history(historyQuery.parse(req.query)));
  });

  return router;
}
