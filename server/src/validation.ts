import { z } from 'zod';
import { ORDER_STATUSES, ORDER_TYPES } from './db/schema';
import { MAX_QUANTITY_PER_LINE } from './lib/money';

/** Turns blank strings into undefined so "   " is treated as "not provided". */
const optionalTrimmed = (max: number, label: string) =>
  z
    .string({ error: `${label} must be text` })
    .trim()
    .max(max, `${label} must be at most ${max} characters`)
    .optional()
    .nullable()
    .transform((v) => (v ? v : undefined));

/** Optional phone number: exactly 10 digits. */
const optionalPhone = z
  .string()
  .trim()
  .regex(/^[0-9]{10}$/, 'Phone number must be exactly 10 digits')
  .optional()
  .nullable()
  .or(z.literal(''))
  .transform((v) => (v ? v : undefined));

const orderLinesSchema = z
  .array(
  z.object({
    menuItemId: z
      .number({ error: 'menuItemId must be a number' })
      .int()
      .positive('menuItemId must be positive'),
    quantity: z
      .number({ error: 'Quantity must be a number' })
      .int('Quantity must be a whole number')
      .min(1, 'Quantity must be at least 1')
      .max(MAX_QUANTITY_PER_LINE, `Quantity must be at most ${MAX_QUANTITY_PER_LINE}`),
    /** "Pack this": the guest is eating in but takes this dish away. Only meaningful on dine-in orders. */
    packed: z.boolean().optional(),
  }),
  { error: 'items must be a list' },
  )
  .min(1, 'Order must contain at least one item')
  .max(100, 'Order has too many lines');

export const createOrderSchema = z
  .object({
    clientRequestId: z
      .string({ error: 'clientRequestId is required' })
      .trim()
      .min(8, 'clientRequestId is too short')
      .max(64, 'clientRequestId is too long'),
    orderType: z.enum(ORDER_TYPES, { error: 'Order type must be DINE_IN or TAKEAWAY' }),
    tableId: z.number().int().positive().optional().nullable(),
    tableNumber: optionalTrimmed(20, 'Table number'),
    notes: optionalTrimmed(500, 'Notes'),
    customerName: optionalTrimmed(60, 'Customer name'),
    customerPhone: optionalPhone,
    items: orderLinesSchema,
  })
  .refine((o) => o.orderType === 'DINE_IN' || (!o.tableNumber && !o.tableId), {
    message: 'Table number is only allowed for dine-in orders',
    path: ['tableNumber'],
  });

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

const itemName = z.string().trim().min(1, 'Item name is required').max(80);
const itemDescription = z
  .string()
  .trim()
  .max(200)
  .nullable()
  .transform((v) => (v ? v : null));
const itemPrice = z.number().int('Price must be whole paise').min(0).max(10_000_000, 'Price is too large');
const categoryName = z.string().trim().min(1, 'Category name is required').max(60);

export const createMenuItemSchema = z
  .object({
    categoryId: z.number().int().positive(),
    name: itemName,
    description: itemDescription.optional(),
    pricePaise: itemPrice,
    isVeg: z.boolean().default(true),
  })
  .strict();

export const updateMenuItemSchema = z
  .object({
    name: itemName.optional(),
    description: itemDescription.optional(),
    pricePaise: itemPrice.optional(),
    isAvailable: z.boolean().optional(),
    isVeg: z.boolean().optional(),
    categoryId: z.number().int().positive().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'Nothing to update' });

/** Ids in the order they should be shown (first = top of the list). */
export const reorderSchema = z
  .object({
    ids: z
      .array(z.number().int().positive())
      .max(1000)
      .refine((ids) => new Set(ids).size === ids.length, 'Each id may appear once'),
  })
  .strict();

export const createCategorySchema = z.object({ name: categoryName }).strict();
export const updateCategorySchema = z
  .object({ name: categoryName.optional(), isActive: z.boolean().optional() })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'Nothing to update' });

/** The full list of dining tables, in display order. Replaces the previous list. */
export const saveTablesSchema = z
  .object({
    tables: z
      .array(z.string().trim().min(1, 'A table name cannot be empty').max(20, 'Table names are at most 20 characters'))
      .max(100, 'At most 100 tables')
      .refine((names) => new Set(names.map((n) => n.toLowerCase())).size === names.length, 'Each table needs a different name'),
  })
  .strict();

export const createTableSchema = z
  .object({
    name: z.string().trim().min(1, 'A table name cannot be empty').max(20, 'Table names are at most 20 characters'),
    capacity: z
      .number({ error: 'Capacity must be a number' })
      .int('Capacity must be a whole number')
      .min(1, 'Capacity must be at least 1')
      .max(999, 'Capacity is too large')
      .nullable()
      .optional(),
  })
  .strict();
export type CreateTableInput = z.infer<typeof createTableSchema>;

export const updateTableSchema = z
  .object({
    name: z.string().trim().min(1, 'A table name cannot be empty').max(20, 'Table names are at most 20 characters').optional(),
    capacity: z
      .number({ error: 'Capacity must be a number' })
      .int('Capacity must be a whole number')
      .min(1, 'Capacity must be at least 1')
      .max(999, 'Capacity is too large')
      .nullable()
      .optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
    force: z.boolean().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'Nothing to update' });
export type UpdateTableInput = z.infer<typeof updateTableSchema>;

export const listOrdersQuerySchema = z.object({
  // One status ("READY") or a comma-separated list ("NEW,PREPARING,READY").
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()) : undefined))
    .pipe(z.array(z.enum(ORDER_STATUSES, { error: 'Unknown order status' })).optional()),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Only the status may be changed through the API; any other field is rejected. */
export const updateOrderStatusSchema = z
  .object({
    status: z.enum(ORDER_STATUSES, { error: 'Unknown order status' }),
  })
  .strict();

export const idParamSchema = z.coerce.number().int().positive();

// ---------------------------------------------------------------------------
// Billing & payments (Day 3). All money is integer paise; rates are basis points.
// ---------------------------------------------------------------------------

const paise = (label: string, max = 100_000_000) =>
  z
    .number({ error: `${label} must be a number` })
    .int(`${label} must be whole paise`)
    .min(0, `${label} cannot be negative`)
    .max(max, `${label} is too large`);

const optionalText = (max: number, label: string) =>
  z
    .string({ error: `${label} must be text` })
    .trim()
    .max(max, `${label} must be at most ${max} characters`)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

export const generateBillSchema = z
  .object({
    discount: z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('NONE') }).strict(),
        z
          .object({
            type: z.literal('PERCENT'),
            bps: z.number().int().min(1, 'Discount must be more than 0%').max(10_000, 'Discount cannot exceed 100%'),
            reason: z.string().trim().min(3, 'Give a reason for the discount').max(120),
          })
          .strict(),
        z
          .object({
            type: z.literal('AMOUNT'),
            paise: paise('Discount').refine((v) => v > 0, 'Discount must be more than ₹0'),
            reason: z.string().trim().min(3, 'Give a reason for the discount').max(120),
          })
          .strict(),
      ])
      .default({ type: 'NONE' }),
  })
  .strict();
export type GenerateBillInput = z.infer<typeof generateBillSchema>;

const idempotencyKey = z.string({ error: 'idempotencyKey is required' }).trim().min(8).max(64);
// The total the cashier saw. Not used to compute anything — only to refuse the payment if
// the bill changed in the meantime (e.g. someone added a discount on another screen).
const expectedTotalPaise = paise('Expected total').refine((v) => v > 0, 'Expected total must be more than ₹0');

export const recordPaymentSchema = z.discriminatedUnion('method', [
  z
    .object({
      method: z.literal('CASH'),
      idempotencyKey,
      expectedTotalPaise,
      tenderedPaise: paise('Cash received', 10_000_000),
    })
    .strict(),
  z
    .object({
      method: z.literal('UPI_MANUAL'),
      idempotencyKey,
      expectedTotalPaise,
      outcome: z.enum(['SUCCEEDED', 'FAILED']),
      // Required for SUCCEEDED: the cashier confirms they saw the money in the merchant app/bank.
      manuallyVerified: z.literal(true).optional(),
      providerReference: optionalText(64, 'UPI reference'),
      failureReason: optionalText(200, 'Failure reason'),
    })
    .strict()
    .refine((p) => p.outcome !== 'SUCCEEDED' || p.manuallyVerified === true, {
      message: 'Confirm that you checked the UPI payment in the merchant app or bank before recording it',
      path: ['manuallyVerified'],
    })
    .refine((p) => p.outcome !== 'FAILED' || !!p.failureReason, {
      message: 'Describe why the UPI payment failed',
      path: ['failureReason'],
    }),
  z.object({ method: z.literal('TERMINAL'), idempotencyKey, expectedTotalPaise }).strict(),
  // The bill goes on the customer's account (paid later). Name and phone are required so it can be collected.
  z
    .object({
      method: z.literal('CREDIT'),
      idempotencyKey,
      expectedTotalPaise,
      customerName: z.string({ error: 'Enter the customer name' }).trim().min(1, 'Enter the customer name').max(60),
      customerPhone: z.string({ error: 'Enter the customer phone number' }).trim().regex(/^[0-9]{10}$/, 'Phone number must be exactly 10 digits'),
    })
    .strict(),
]);
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

export const resolvePaymentSchema = z
  .object({
    outcome: z.enum(['SUCCEEDED', 'FAILED']),
    providerReference: optionalText(64, 'Reference'),
    note: z.string().trim().min(3, 'Explain how you verified the outcome').max(300),
  })
  .strict();

export const refundPaymentSchema = z
  .object({
    reason: z.string().trim().min(3, 'Give a reason for the refund').max(200),
    // The operator confirms the money has actually been given back.
    confirmed: z.literal(true, { error: 'Confirm that the money has been returned to the customer' }),
  })
  .strict();

export const updateSettingsSchema = z
  .object({
    restaurantName: z.string().trim().min(1, 'Restaurant name is required').max(80),
    addressLine: optionalText(160, 'Address'),
    phone: optionalText(40, 'Phone'),
    taxId: optionalText(40, 'Tax ID'),
    receiptFooter: optionalText(160, 'Receipt footer'),
    roundToRupee: z.boolean(),
    taxes: z
      .array(
        z
          .object({
            name: z.string().trim().min(1, 'Tax name is required').max(30),
            rateBps: z.number().int('Tax rate must be in whole basis points').min(0).max(10_000, 'Tax rate cannot exceed 100%'),
          })
          .strict(),
      )
      .max(5, 'At most 5 tax lines')
      .refine((taxes) => new Set(taxes.map((t) => t.name.toLowerCase())).size === taxes.length, 'Each tax line needs a different name'),
  })
  .strict();
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

export const reportDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .refine((v) => {
    const [y, m, d] = v.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }, 'Not a real date')
  .optional();

/** Change the items (and note) of an order the kitchen has not started yet. */
export const replaceOrderItemsSchema = z
  .object({
    items: orderLinesSchema,
    notes: optionalTrimmed(500, 'Notes'),
  })
  .strict();
export type ReplaceOrderItemsInput = z.infer<typeof replaceOrderItemsSchema>;

export const cancelOrderSchema = z
  .object({
    reason: z.string({ error: 'Give a reason for cancelling' }).trim().min(3, 'Give a short reason (3+ letters)').max(200),
  })
  .strict();

/** Money received from a customer who owes on credit. Without creditSaleId it pays the oldest bills first. */
export const collectCreditSchema = z
  .object({
    amountPaise: z.number({ error: 'Enter the amount received' }).int('Amount must be whole paise').min(1, 'Enter the amount received').max(100_000_000),
    method: z.enum(['CASH', 'UPI_MANUAL']),
    creditSaleId: z.number().int().positive().optional(),
    // UPI: the cashier confirms they saw the money, as for a normal UPI payment.
    manuallyVerified: z.boolean().optional(),
    providerReference: optionalText(64, 'UPI reference'),
    note: optionalText(200, 'Note'),
    idempotencyKey,
  })
  .strict()
  .refine((p) => p.method !== 'UPI_MANUAL' || p.manuallyVerified === true, {
    message: 'Confirm that you checked the UPI payment in the merchant app or bank before recording it',
    path: ['manuallyVerified'],
  });
export type CollectCreditInput = z.infer<typeof collectCreditSchema>;
