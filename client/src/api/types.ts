// Shapes returned by the backend API (see server/src/services/*). Money is integer paise.

export type OrderType = 'DINE_IN' | 'TAKEAWAY';
export type OrderStatus = 'NEW' | 'PREPARING' | 'READY' | 'COMPLETED' | 'CANCELLED';

export interface MenuItem {
  id: number;
  categoryId: number;
  name: string;
  description: string | null;
  pricePaise: number;
  isAvailable: boolean;
  isVeg: boolean;
}

export interface MenuCategory {
  id: number;
  name: string;
  items: MenuItem[];
}

/** Category as returned to the menu editor (hidden categories included). */
export interface ManagedCategory extends MenuCategory {
  isActive: boolean;
}

export interface NewMenuItem {
  categoryId: number;
  name: string;
  description?: string | null;
  pricePaise: number;
  isVeg: boolean;
}

export type MenuItemChanges = Partial<Pick<MenuItem, 'name' | 'description' | 'pricePaise' | 'isAvailable' | 'isVeg' | 'categoryId'>>;

export interface OrderItem {
  id: number;
  menuItemId: number | null;
  itemName: string;
  unitPricePaise: number;
  quantity: number;
  lineTotalPaise: number;
  /** false for items added to a running order that the kitchen has not taken yet */
  sentToKitchen?: boolean;
}

export type OrderPaymentStatus = 'UNPAID' | 'PAID' | 'FAILED' | 'UNCERTAIN' | 'REFUNDED';
export type PaymentMethod = 'CASH' | 'UPI_MANUAL' | 'TERMINAL' | 'CREDIT';
export type PaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'REFUNDED';

export interface Order {
  id: number;
  orderNumber: string;
  orderType: OrderType;
  tableId?: number | null;
  tableNumber: string | null;
  notes: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  /** Why the order was cancelled (only when status is CANCELLED) */
  cancelReason?: string | null;
  /** Kitchen workflow status */
  status: OrderStatus;
  /** Payment state — independent of the kitchen status */
  paymentStatus: OrderPaymentStatus;
  paymentMethod: PaymentMethod | null;
  billTotalPaise: number | null;
  subtotalPaise: number;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  items: OrderItem[];
}

export interface CreateOrderRequest {
  clientRequestId: string;
  orderType: OrderType;
  tableId?: number | null;
  tableNumber?: string;
  notes?: string;
  /** Optional: who the order is for */
  customerName?: string;
  customerPhone?: string;
  items: { menuItemId: number; quantity: number }[];
}

export interface TableDTO {
  id: number;
  name: string;
  capacity: number | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface TableTileDTO extends TableDTO {
  status: 'AVAILABLE' | 'OCCUPIED';
  tableStatus?: 'BLANK' | 'RUNNING_KOT' | 'PRINTED' | 'PAID';
  activeOrderCount: number;
  runningTotalPaise: number;
  firstOrderAt?: string | null;
  /** How far the table's order is in the kitchen (the least advanced one); null when the table is empty */
  kitchenStatus?: 'NEW' | 'PREPARING' | 'READY' | 'COMPLETED' | null;
  /** PAID once everything on the table is paid (stays until the table is cleared) */
  paymentState?: 'PAID' | 'UNPAID' | null;
}

export interface TableDetailDTO {
  table: TableTileDTO;
  orders: Order[];
  runningTotalPaise: number;
}

export interface TableCheckoutDTO {
  table: { id: number; name: string };
  orders: Order[];
  bill: Bill | null;
  payments: Payment[];
}

export interface TableReceiptDTO {
  restaurant: Omit<Settings, 'taxes' | 'roundToRupee' | 'configured'>;
  table: { id: number; name: string };
  orders: Order[];
  bill: Bill;
  paymentStatus: OrderPaymentStatus;
  payment: Payment | null;
  generatedAt: string;
}

export interface TaxLine {
  name: string;
  rateBps: number;
  amountPaise: number;
}

export interface Bill {
  id: number;
  orderId: number;
  status: 'OPEN' | 'PAID' | 'REFUNDED';
  subtotalPaise: number;
  discount: { type: 'NONE' | 'PERCENT' | 'AMOUNT'; value: number; reason: string | null; paise: number };
  taxablePaise: number;
  taxLines: TaxLine[];
  taxPaise: number;
  roundOffPaise: number;
  totalPaise: number;
  updatedAt: string;
}

export interface Payment {
  id: number;
  reference: string;
  orderId: number;
  billId: number;
  method: PaymentMethod;
  status: PaymentStatus;
  amountPaise: number;
  tenderedPaise: number | null;
  changePaise: number | null;
  provider: string;
  providerReference: string | null;
  failureReason: string | null;
  note: string | null;
  createdAt: string;
  completedAt: string | null;
  refundedAt: string | null;
  refundReason: string | null;
}

export interface Checkout {
  order: Order;
  bill: Bill | null;
  payments: Payment[];
}

export type DiscountRequest =
  | { type: 'NONE' }
  | { type: 'PERCENT'; bps: number; reason: string }
  | { type: 'AMOUNT'; paise: number; reason: string };

export type PaymentRequest =
  | { method: 'CASH'; idempotencyKey: string; expectedTotalPaise: number; tenderedPaise: number }
  | {
      method: 'UPI_MANUAL';
      idempotencyKey: string;
      expectedTotalPaise: number;
      outcome: 'SUCCEEDED' | 'FAILED';
      manuallyVerified?: true;
      providerReference?: string;
      failureReason?: string;
    }
  // The bill goes on the customer's account (pay later)
  | { method: 'CREDIT'; idempotencyKey: string; expectedTotalPaise: number; customerName: string; customerPhone: string };

export interface Settings {
  restaurantName: string;
  addressLine: string | null;
  phone: string | null;
  taxId: string | null;
  receiptFooter: string | null;
  roundToRupee: boolean;
  taxes: { name: string; rateBps: number }[];
  configured: boolean;
}

export interface Receipt {
  restaurant: Pick<Settings, 'restaurantName' | 'addressLine' | 'phone' | 'taxId' | 'receiptFooter'>;
  order: Order;
  bill: Bill;
  paymentStatus: OrderPaymentStatus;
  payment: Payment | null;
  generatedAt: string;
}

export interface DailySummary {
  date: string;
  from: string;
  to: string;
  orderCount: number;
  grossSalesPaise: number;
  paidCount: number;
  byMethod: Record<PaymentMethod, { count: number; totalPaise: number }>;
  refundCount: number;
  refundTotalPaise: number;
  netSalesPaise: number;
  unpaidCount: number;
  unpaidTotalPaise: number;
  failedAttemptCount: number;
  uncertainAttemptCount: number;
  credit: CreditTotals;
  payments: (Payment & { orderNumber: string })[];
}

// --- Authentication (Day 4) -------------------------------------------------

export type Role = 'SUPERADMIN' | 'RECEPTION' | 'KITCHEN';

export interface User {
  id: number;
  username: string;
  role: Role;
}

export interface LoginAccount {
  id: number;
  role: Role;
  username: string;
  isActive: boolean;
  passwordChangedAt: string;
  createdAt: string;
}

/** What KITCHEN logins receive: no prices, totals or payment state. */
export interface KitchenOrder {
  id: number;
  orderNumber: string;
  orderType: OrderType;
  tableNumber: string | null;
  notes: string | null;
  status: OrderStatus;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  items: { id: number; itemName: string; quantity: number; sent?: boolean }[];
}

/** Orders on the live screens: full orders for staff, kitchen orders for the kitchen login. */
export type LiveOrder = Order | KitchenOrder;
export const isFullOrder = (o: LiveOrder): o is Order => 'subtotalPaise' in o;

// --- Backups (Day 5) ---------------------------------------------------------
export interface BackupInfo {
  enabled: boolean;
  status?: {
    dir: string;
    intervalHours: number;
    keepDays: number;
    minKeep: number;
    lastSuccess: { at: string; file: string; sizeBytes: number } | null;
    lastError: { at: string; message: string } | null;
    lastSkipped: { at: string; reason: string } | null;
    count: number;
  };
  files?: { name: string; sizeBytes: number; createdAt: string; reason: string }[];
}

// --- Owner dashboard (Superadmin) --------------------------------------------

export interface PeriodTotals {
  grossPaise: number;
  refundPaise: number;
  netPaise: number;
  paidCount: number;
  orderCount: number;
  cancelledCount: number;
  avgOrderPaise: number;
}

export interface Bucket {
  count: number;
  totalPaise: number;
}

export interface ItemStat {
  name: string;
  quantity: number;
  revenuePaise: number;
}

export interface Analytics {
  from: string;
  to: string;
  days: number;
  totals: PeriodTotals & { discountPaise: number; taxPaise: number; itemsSold: number };
  previous: PeriodTotals;
  byDay: { date: string; netPaise: number; orders: number }[];
  byHour: Bucket[];
  byWeekday: Bucket[];
  byMethod: Record<PaymentMethod, Bucket>;
  credit: CreditTotals;
  byType: Record<OrderType, Bucket>;
  byTable: { table: string; count: number; totalPaise: number }[];
  topItems: ItemStat[];
  slowItems: ItemStat[];
  byCategory: { category: string; quantity: number; revenuePaise: number }[];
}

export interface HistoryRow {
  id: number;
  orderNumber: string;
  createdAt: string;
  orderType: OrderType;
  tableNumber: string | null;
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  paymentMethod: PaymentMethod | null;
  totalPaise: number;
  itemCount: number;
  itemsSummary: string;
}

export interface HistoryQuery {
  from: string;
  to: string;
  q?: string;
  payment?: OrderPaymentStatus | 'CANCELLED';
  type?: OrderType;
  limit?: number;
  offset?: number;
}

// --- Credit ("pay later") ---------------------------------------------------

export interface CreditTotals {
  /** Bills put on credit in the period */
  givenPaise: number;
  givenCount: number;
  /** Money collected from customers in the period */
  collectedCashPaise: number;
  collectedUpiPaise: number;
  collectedPaise: number;
  /** What customers owe right now */
  outstandingPaise: number;
  owingCustomers: number;
}

export interface CreditCustomer {
  id: number;
  name: string;
  phone: string;
  outstandingPaise: number;
  givenPaise: number;
  collectedPaise: number;
  openBills: number;
  lastActivityAt: string;
}

export interface CreditReceipt {
  id: number;
  amountPaise: number;
  method: 'CASH' | 'UPI_MANUAL';
  providerReference: string | null;
  note: string | null;
  createdAt: string;
}

/** One bill that was put on credit, and how much of it is still owed. */
export interface CreditSale {
  id: number;
  createdAt: string;
  orderNumbers: string[];
  tableName: string | null;
  itemsSummary: string;
  amountPaise: number;
  paidPaise: number;
  remainingPaise: number;
  receipts: CreditReceipt[];
}

export interface CreditCustomerDetail {
  customer: CreditCustomer;
  sales: CreditSale[];
}

export interface CollectCreditRequest {
  amountPaise: number;
  method: 'CASH' | 'UPI_MANUAL';
  /** Leave out to pay the oldest bills first */
  creditSaleId?: number;
  manuallyVerified?: boolean;
  providerReference?: string;
  note?: string;
  idempotencyKey: string;
}
