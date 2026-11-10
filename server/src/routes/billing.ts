import { Router } from 'express';
import { requireRole, requireSession } from '../lib/auth';
import { AppError } from '../lib/errors';
import type { BillingService } from '../services/billingService';
import type { PaytmPayments } from '../payments/paytm/service';
import { scenarioFromName } from '../payments/paytm/setup';
import {
  generateBillSchema,
  idParamSchema,
  recordPaymentSchema,
  refundPaymentSchema,
  reportDateSchema,
  resolvePaymentSchema,
  dailyGoalSchema,
  mockScenarioSchema,
  updateSettingsSchema,
} from '../validation';

/** /api/orders/:id/... — bill, checkout, payments and receipt for one order. */
const staff = requireRole('SUPERADMIN', 'RECEPTION');
const superadmin = requireRole('SUPERADMIN');

export function orderBillingRouter(billing: BillingService, paytm?: PaytmPayments): Router {
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
    // A terminal payment answers as soon as the terminal has the request (the customer then pays on the terminal), so it
    // never holds this request open; the outcome arrives by status checks.
    const result =
      input.method === 'TERMINAL'
        ? paytm
          ? await paytm.startForOrder(id, input)
          : await billing.startProviderPayment(id, input)
        : billing.recordManualPayment(id, input);
    res.status(result.duplicate ? 200 : 201).json(result);
  });

  router.get('/:id/receipt', staff, (req, res) => {
    res.json(billing.receipt(idParamSchema.parse(req.params.id)));
  });

  return router;
}

/** /api/payments/:id/... — Superadmin-only corrections. */
export function paymentsRouter(billing: BillingService, paytm?: PaytmPayments): Router {
  const router = Router();
  const terminal = () => {
    if (!paytm) throw new AppError(409, 'TERMINAL_NOT_ENABLED', 'Terminal payments are not turned on');
    return paytm;
  };
  // Where a terminal payment stands (read by the checkout screen while it waits).
  router.get('/:id/terminal', staff, (req, res) => {
    res.json({ terminal: terminal().summary(idParamSchema.parse(req.params.id)) });
  });
  // "Check now": ask the terminal service about this payment.
  router.post('/:id/terminal-check', staff, async (req, res) => {
    res.json({ terminal: await terminal().check(idParamSchema.parse(req.params.id)) });
  });
  // Same-day void of a successful terminal payment (Superadmin).
  router.post('/:id/terminal-void', superadmin, async (req, res) => {
    res.json({ terminal: await terminal().voidPayment(idParamSchema.parse(req.params.id)) });
  });
  router.post('/:id/resolve', superadmin, (req, res) => {
    res.json(billing.resolvePayment(idParamSchema.parse(req.params.id), resolvePaymentSchema.parse(req.body)));
  });
  router.post('/:id/refund', superadmin, (req, res) => {
    res.json(billing.refundPayment(idParamSchema.parse(req.params.id), refundPaymentSchema.parse(req.body)));
  });
  return router;
}

export function settingsRouter(billing: BillingService, paytm?: PaytmPayments): Router {
  const router = Router();
  // Whether the checkout screens offer the card/UPI terminal. Never contains a secret.
  router.get('/payments', staff, (_req, res) => {
    res.json({ terminal: paytm ? paytm.capabilities() : { enabled: false } });
  });
  // Practice mode only (the pretend terminal): choose what it does with the next payments.
  router.put('/payments/mock-scenario', superadmin, (req, res) => {
    if (!paytm || paytm.mode !== 'mock') throw new AppError(409, 'NOT_MOCK', 'There is no practice terminal to script');
    const body = mockScenarioSchema.parse(req.body);
    paytm.setMockScenario(scenarioFromName(body.scenario, body.afterPolls));
    res.json({ terminal: paytm.capabilities(), scenario: body.scenario });
  });
  router.get('/', staff, (_req, res) => {
    res.json({ settings: billing.getSettings() });
  });
  router.put('/', superadmin, (req, res) => {
    res.json({ settings: billing.updateSettings(updateSettingsSchema.parse(req.body)) });
  });
  // The daily sales goal: every signed-in staff device reads it, only the Superadmin changes it.
  router.get('/daily-goal', staff, (_req, res) => {
    res.json({ dailyGoalPaise: billing.getDailyGoal() });
  });
  router.put('/daily-goal', superadmin, (req, res) => {
    res.json({ dailyGoalPaise: billing.setDailyGoal(dailyGoalSchema.parse(req.body).dailyGoalPaise) });
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
