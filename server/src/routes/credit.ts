import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../lib/auth';
import type { CreditService } from '../services/creditService';
import { collectCreditSchema, idParamSchema } from '../validation';

const staff = requireRole('SUPERADMIN', 'RECEPTION');

/** /api/credit — customers who took food on credit ("pay later") and what they still owe. */
export function creditRouter(credit: CreditService): Router {
  const router = Router();

  router.get('/customers', staff, (req, res) => {
    const { q, all } = z.object({ q: z.string().trim().max(60).optional(), all: z.enum(['1', '0']).optional() }).parse(req.query);
    res.json({ customers: credit.list({ q, includeSettled: all === '1' }) });
  });

  // Exact phone match: lets the checkout screen fill in the name and show what that customer already owes.
  router.get('/lookup', staff, (req, res) => {
    const { phone } = z.object({ phone: z.string().regex(/^[0-9]{10}$/, 'Phone number must be exactly 10 digits') }).parse(req.query);
    res.json({ customer: credit.lookupByPhone(phone) });
  });

  router.get('/customers/:id', staff, (req, res) => {
    res.json(credit.get(idParamSchema.parse(req.params.id)));
  });

  router.post('/customers/:id/collect', staff, (req, res) => {
    const result = credit.collect(idParamSchema.parse(req.params.id), collectCreditSchema.parse(req.body));
    res.status(result.duplicate ? 200 : 201).json(result);
  });

  return router;
}
