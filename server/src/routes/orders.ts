import { Router } from 'express';
import type { OrderStatus, UserRole } from '../db/schema';
import { requireRole, requireSession } from '../lib/auth';
import { AppError } from '../lib/errors';
import { toKitchenOrder, type OrderService } from '../services/orderService';
import { cancelOrderSchema, createOrderSchema, idParamSchema, listOrdersQuerySchema, replaceOrderItemsSchema, updateOrderStatusSchema } from '../validation';

/** Which status each login may set. The transition itself is still validated by the service. */
export const STATUS_PERMISSIONS: Record<UserRole, readonly OrderStatus[]> = {
  KITCHEN: ['PREPARING', 'READY'],
  RECEPTION: ['COMPLETED'], // "Mark served"
  SUPERADMIN: ['PREPARING', 'READY', 'COMPLETED'],
};

// Statuses some login may set. Others (NEW, CANCELLED) are invalid for everyone: the service
// answers those with 409 INVALID_TRANSITION rather than a misleading 403.
const SETTABLE = new Set(Object.values(STATUS_PERMISSIONS).flat());

const staff = requireRole('SUPERADMIN', 'RECEPTION');

export function ordersRouter(orders: OrderService): Router {
  const router = Router();

  router.get('/', staff, (req, res) => {
    const { status, limit } = listOrdersQuerySchema.parse(req.query);
    res.json({ orders: orders.list({ statuses: status, limit }) });
  });

  router.get('/:id', staff, (req, res) => {
    res.json({ order: orders.getById(idParamSchema.parse(req.params.id)) });
  });

  router.post('/', staff, (req, res) => {
    const input = createOrderSchema.parse(req.body);
    const { order, duplicate, merged } = orders.create(input);
    // 201 = newly created or added to a running order; 200 = this exact submission was already saved earlier.
    res.status(duplicate ? 200 : 201).json({ order, duplicate, merged });
  });

  // Change what is on an order the kitchen has not started yet.
  router.put('/:id/items', staff, (req, res) => {
    const order = orders.replaceItems(idParamSchema.parse(req.params.id), replaceOrderItemsSchema.parse(req.body));
    res.json({ order });
  });

  // Cancel an unpaid order the kitchen has not started (reason required).
  router.post('/:id/cancel', staff, (req, res) => {
    const { reason } = cancelOrderSchema.parse(req.body);
    res.json({ order: orders.cancel(idParamSchema.parse(req.params.id), reason) });
  });

  // Kitchen/reception workflow: NEW -> PREPARING -> READY -> COMPLETED ("Served").
  router.patch('/:id/status', requireRole('SUPERADMIN', 'RECEPTION', 'KITCHEN'), (req, res) => {
    const { user } = requireSession(res);
    const id = idParamSchema.parse(req.params.id);
    const { status } = updateOrderStatusSchema.parse(req.body);
    if (SETTABLE.has(status) && !STATUS_PERMISSIONS[user.role].includes(status)) {
      throw new AppError(403, 'FORBIDDEN', "Your login doesn't have permission to set that status");
    }
    const { order, changed } = orders.updateStatus(id, status);
    res.json({ order: user.role === 'KITCHEN' ? toKitchenOrder(order) : order, changed });
  });

  return router;
}

/** /api/kitchen — the kitchen display's data, without prices or payment details. */
export function kitchenRouter(orders: OrderService): Router {
  const router = Router();
  router.get('/orders', requireRole('SUPERADMIN', 'KITCHEN'), (_req, res) => {
    res.json({ orders: orders.list({ statuses: ['NEW', 'PREPARING', 'READY'], limit: 200 }).map(toKitchenOrder) });
  });
  return router;
}
