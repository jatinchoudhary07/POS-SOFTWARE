import { Router } from 'express';
import { requireRole, requireSession } from '../lib/auth';
import type { BillingService } from '../services/billingService';
import type { TablesService } from '../services/tablesService';
import {
  createTableSchema,
  generateBillSchema,
  idParamSchema,
  recordPaymentSchema,
  saveTablesSchema,
  updateTableSchema,
} from '../validation';

const staff = requireRole('SUPERADMIN', 'RECEPTION');
const superadmin = requireRole('SUPERADMIN');

export function tablesRouter(tables: TablesService, billing: BillingService): Router {
  const router = Router();

  // Reception needs the list to pick a table; also includes detailed diningTables for tiles/selector.
  router.get('/', staff, (_req, res) => {
    res.json({
      tables: tables.list(),
      diningTables: tables.listTiles(),
    });
  });

  // Visual table tiles with live status, running amounts, and active order counts.
  router.get('/overview', staff, (_req, res) => {
    res.json({ tables: tables.listTiles() });
  });

  // Create a new table (Superadmin only)
  router.post('/', superadmin, (req, res) => {
    const table = tables.create(createTableSchema.parse(req.body));
    res.status(201).json({ table });
  });

  // Details for a specific table: active unpaid orders, status, and running total
  router.get('/:id', staff, (req, res) => {
    const id = idParamSchema.parse(req.params.id);
    res.json(tables.getTableDetails(id));
  });

  // Vacate / clear a settled table so it becomes available
  router.post('/:id/clear', staff, (req, res) => {
    const id = idParamSchema.parse(req.params.id);
    res.json({ table: tables.clearTable(id) });
  });

  // Update/rename/activate/deactivate a table (Superadmin only)
  router.patch('/:id', superadmin, (req, res) => {
    const id = idParamSchema.parse(req.params.id);
    const table = tables.update(id, updateTableSchema.parse(req.body));
    res.json({ table });
  });

  // Legacy bulk-save endpoint (Superadmin only)
  router.put('/', superadmin, (req, res) => {
    res.json({ tables: tables.save(saveTablesSchema.parse(req.body).tables) });
  });

  // -------------------------------------------------------------------------
  // Table Combined Billing & Checkout
  // -------------------------------------------------------------------------

  router.get('/:id/checkout', staff, (req, res) => {
    const id = idParamSchema.parse(req.params.id);
    res.json(billing.checkoutTable(id));
  });

  router.post('/:id/bill', staff, (req, res) => {
    const id = idParamSchema.parse(req.params.id);
    const canChangeDiscount = requireSession(res).user.role === 'SUPERADMIN';
    res.json(billing.generateTableBill(id, generateBillSchema.parse(req.body ?? {}), { canChangeDiscount }));
  });

  router.post('/:id/payments', staff, (req, res) => {
    const id = idParamSchema.parse(req.params.id);
    const input = recordPaymentSchema.parse(req.body);
    if (input.method === 'TERMINAL') {
      throw new Error('Terminal payment not supported for table checkout yet');
    }
    const result = billing.recordTablePayment(id, input);
    res.status(result.duplicate ? 200 : 201).json(result);
  });

  router.get('/:id/receipt', staff, (req, res) => {
    const id = idParamSchema.parse(req.params.id);
    res.json(billing.tableReceipt(id));
  });

  return router;
}
