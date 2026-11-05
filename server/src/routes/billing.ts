import { Router } from 'express';
import { requireRole, requireSession } from '../lib/auth';
import { AppError } from '../lib/errors';
import type { BillingService } from '../services/billingService';
import {
  generateBillSchema,
  idParamSchema,
  recordPaymentSchema,
  refundPaymentSchema,
  reportDateSchema,
  resolvePaymentSchema,
  updateSettingsSchema,
} from '../validation';

/** /api/orders/:id/... — bill, checkout, payments and receipt for one order. */
const staff = requireRole('SUPERADMIN', 'RECEPTION');
const superadmin = requireRole('SUPERADMIN');

export function orderBillingRouter(billing: BillingService): Router {
  const router = Router();

  router.get('/:id/checkout', staff, (req, res) => {
    res.json(billing.checkout(idParamSchema.parse(req.params.id)));
  });

  // Creates or recalculates the open bill (amounts come from the stored order + tax settings).
  router.post('/:id/bill', staff, (req, res) => {
    const id = idParamSchema.parse(req.params.id);
    const canChangeDiscount = requireSession(res).user.role === 'SUPERADMIN';
    res.json(billing.generateBill(id, generateBillSchema.parse(req.body ?? {}), { canChangeDiscount }));
  });

  // 201 = a new payment attempt was recorded; 200 = same idempotencyKey seen before.
  router.post('/:id/payments', staff, async (req, res) => {
    const id = idParamSchema.parse(req.params.id);
    const input = recordPaymentSchema.parse(req.body);
    const result =
      input.method === 'TERMINAL' ? await billing.startProviderPayment(id, input) : billing.recordManualPayment(id, input);
    res.status(result.duplicate ? 200 : 201).json(result);
  });

  router.get('/:id/receipt', staff, (req, res) => {
    res.json(billing.receipt(idParamSchema.parse(req.params.id)));
  });

  return router;
}

/** /api/payments/:id/... — Superadmin-only corrections. */
export function paymentsRouter(billing: BillingService): Router {
  const router = Router();
  router.post('/:id/resolve', superadmin, (req, res) => {
    res.json(billing.resolvePayment(idParamSchema.parse(req.params.id), resolvePaymentSchema.parse(req.body)));
  });
  router.post('/:id/refund', superadmin, (req, res) => {
    res.json(billing.refundPayment(idParamSchema.parse(req.params.id), refundPaymentSchema.parse(req.body)));
  });
  return router;
}

export function settingsRouter(billing: BillingService): Router {
  const router = Router();
  router.get('/', staff, (_req, res) => {
    res.json({ settings: billing.getSettings() });
  });
  router.put('/', superadmin, (req, res) => {
    res.json({ settings: billing.updateSettings(updateSettingsSchema.parse(req.body)) });
  });
  return router;
}

export function reportsRouter(billing: BillingService): Router {
  const router = Router();
  router.get('/daily', staff, (req, res) => {
    const date = reportDateSchema.parse(typeof req.query.date === 'string' ? req.query.date : undefined);
    // Reception sees today's figures for daily operations; other days are Superadmin-only.
    if (requireSession(res).user.role !== 'SUPERADMIN' && date && date !== billing.todayKey()) {
      throw new AppError(403, 'FORBIDDEN', "Only the Superadmin can view other days' sales");
    }
    res.json({ summary: billing.dailySummary(date) });
  });
  return router;
}
