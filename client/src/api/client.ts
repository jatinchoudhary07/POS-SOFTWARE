import { API_BASE } from '../lib/config';
import { recordServerDate } from '../lib/serverClock';
import type {
  Analytics,
  HistoryQuery,
  HistoryRow,
  Checkout,
  CreateOrderRequest,
  KitchenOrder,
  CollectCreditRequest,
  CreditCustomer,
  CreditCustomerDetail,
  LoginAccount,
  Role,
  User,
  DailySummary,
  DiscountRequest,
  ManagedCategory,
  MenuCategory,
  MenuItem,
  MenuItemChanges,
  NewMenuItem,
  Order,
  OrderStatus,
  Payment,
  PaymentRequest,
  Receipt,
  Settings,
  PaymentsConfig,
  TerminalAttempt,
  MockScenarioName,
  TableCheckoutDTO,
  TableDetailDTO,
  TableDTO,
  TableReceiptDTO,
  TableTileDTO,
} from './types';

/** Error with a machine-readable code from the server (or NETWORK_ERROR / TIMEOUT). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const TIMEOUT_MS = 10_000;

// Called when the server says the session is missing/expired (401 outside /auth), so the app
// can return to the login screen. Registered by the AuthProvider.
let onUnauthenticated: (() => void) | null = null;
export const setUnauthenticatedHandler = (fn: (() => void) | null) => {
  onUnauthenticated = fn;
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api${path}`, {
      ...init,
      // The session is an HttpOnly cookie: the browser sends it, page scripts can't read it.
      credentials: API_BASE ? 'include' : 'same-origin',
      headers: { 'Content-Type': 'application/json', ...init.headers },
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new ApiError(0, 'TIMEOUT', 'The server took too long to respond.');
    }
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the POS server. Check that it is running.');
  } finally {
    clearTimeout(timer);
  }

  recordServerDate(res.headers.get('Date'));
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const e = body?.error;
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthenticated?.();
    throw new ApiError(res.status, e?.code ?? 'HTTP_ERROR', e?.message ?? `Server error (${res.status})`, e?.details);
  }
  return body as T;
}

export const api = {
  getMenu: () => request<{ categories: MenuCategory[] }>('/menu').then((r) => r.categories),

  // --- Menu & table editing (Superadmin) ---------------------------------------
  getManagedMenu: () => request<{ categories: ManagedCategory[] }>('/menu/manage').then((r) => r.categories),
  createCategory: (name: string) =>
    request<{ category: ManagedCategory }>('/menu/categories', { method: 'POST', body: JSON.stringify({ name }) }).then((r) => r.category),
  updateCategory: (id: number, body: { name?: string; isActive?: boolean }) =>
    request<{ category: { id: number; name: string; isActive: boolean } }>(`/menu/categories/${id}`, { method: 'PATCH', body: JSON.stringify(body) }).then((r) => r.category),
  deleteCategory: (id: number) => request<{ ok: true }>(`/menu/categories/${id}`, { method: 'DELETE' }),
  reorderCategories: (ids: number[]) => request<{ ok: true }>('/menu/categories/order', { method: 'PUT', body: JSON.stringify({ ids }) }),
  reorderItems: (categoryId: number, ids: number[]) =>
    request<{ ok: true }>(`/menu/categories/${categoryId}/items/order`, { method: 'PUT', body: JSON.stringify({ ids }) }),
  createMenuItem: (body: NewMenuItem) =>
    request<{ item: MenuItem }>('/menu/items', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.item),
  updateMenuItem: (id: number, body: MenuItemChanges) =>
    request<{ item: MenuItem }>(`/menu/items/${id}`, { method: 'PATCH', body: JSON.stringify(body) }).then((r) => r.item),
  deleteMenuItem: (id: number) => request<{ ok: true }>(`/menu/items/${id}`, { method: 'DELETE' }),
  saveTables: (tables: string[]) =>
    request<{ tables: string[] }>('/tables', { method: 'PUT', body: JSON.stringify({ tables }) }).then((r) => r.tables),

  listOrders: (params: { statuses?: OrderStatus[]; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.statuses?.length) q.set('status', params.statuses.join(','));
    if (params.limit) q.set('limit', String(params.limit));
    const qs = q.toString();
    return request<{ orders: Order[] }>(`/orders${qs ? `?${qs}` : ''}`).then((r) => r.orders);
  },

  createOrder: (body: CreateOrderRequest) =>
    request<{ order: Order; duplicate: boolean; merged: boolean }>('/orders', { method: 'POST', body: JSON.stringify(body) }),

  // --- Billing & payments (Day 3) -------------------------------------------
  getCheckout: (orderId: number) => request<Checkout>(`/orders/${orderId}/checkout`),

  /** (Re)calculates the open bill on the server. Only the discount is chosen by the cashier. */
  generateBill: (orderId: number, discount: DiscountRequest = { type: 'NONE' }) =>
    request<Checkout>(`/orders/${orderId}/bill`, { method: 'POST', body: JSON.stringify({ discount }) }),

  recordPayment: (orderId: number, body: PaymentRequest) =>
    request<{ checkout: Checkout; payment: Payment; duplicate: boolean }>(`/orders/${orderId}/payments`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getReceipt: (orderId: number) => request<Receipt>(`/orders/${orderId}/receipt`),

  refundPayment: (paymentId: number, reason: string) =>
    request<{ checkout: Checkout; payment: Payment; changed: boolean }>(`/payments/${paymentId}/refund`, {
      method: 'POST',
      body: JSON.stringify({ reason, confirmed: true }),
    }),

  resolvePayment: (paymentId: number, body: { outcome: 'SUCCEEDED' | 'FAILED'; providerReference?: string; note: string }) =>
    request<{ checkout: Checkout; payment: Payment; changed: boolean }>(`/payments/${paymentId}/resolve`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getSettings: () => request<{ settings: Settings }>('/settings').then((r) => r.settings),
  /** Is the card/UPI terminal available? */
  getPaymentsConfig: () => request<PaymentsConfig>('/settings/payments'),
  getTerminalAttempt: (paymentId: number) => request<{ terminal: TerminalAttempt }>(`/payments/${paymentId}/terminal`).then((r) => r.terminal),
  /** "Check now": ask the terminal service about this payment. */
  checkTerminalPayment: (paymentId: number) => request<{ terminal: TerminalAttempt }>(`/payments/${paymentId}/terminal-check`, { method: 'POST', body: '{}' }).then((r) => r.terminal),
  /** Superadmin: cancel a successful terminal payment on the day it was taken. */
  voidTerminalPayment: (paymentId: number) => request<{ terminal: TerminalAttempt }>(`/payments/${paymentId}/terminal-void`, { method: 'POST', body: '{}' }).then((r) => r.terminal),
  /** Practice mode only (Superadmin): what the pretend terminal does next. */
  setMockScenario: (scenario: MockScenarioName) => request<{ scenario: MockScenarioName }>('/settings/payments/mock-scenario', { method: 'PUT', body: JSON.stringify({ scenario }) }),
  /** The daily sales goal shared by every device (paise). Only the Superadmin can change it. */
  getDailyGoal: () => request<{ dailyGoalPaise: number }>('/settings/daily-goal').then((r) => r.dailyGoalPaise),
  setDailyGoal: (dailyGoalPaise: number) =>
    request<{ dailyGoalPaise: number }>('/settings/daily-goal', { method: 'PUT', body: JSON.stringify({ dailyGoalPaise }) }).then((r) => r.dailyGoalPaise),

  saveSettings: (body: Omit<Settings, 'configured'>) =>
    request<{ settings: Settings }>('/settings', { method: 'PUT', body: JSON.stringify(body) }).then((r) => r.settings),

  // --- Authentication (Day 4) ------------------------------------------------
  authStatus: () => request<{ setupRequired: boolean }>('/auth/status'),
  // --- Alerts for locked phones (Web Push) -----------------------------------
  pushKey: () => request<{ enabled: boolean; publicKey: string }>('/push/key'),
  pushSubscribe: (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    request<{ ok: true }>('/push/subscribe', { method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint, keys: subscription.keys }) }),
  pushUnsubscribe: (endpoint: string) => request<{ ok: true }>('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) }),
  pushTest: () => request<{ sentTo: number }>('/push/test', { method: 'POST' }),
  /** Only username + password are sent; the role comes from the account on the server. */
  login: (username: string, password: string) =>
    request<{ user: User; expiresAt: string }>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),
  me: () => request<{ user: User; expiresAt: string }>('/auth/me'),
  listAccounts: () => request<{ accounts: LoginAccount[] }>('/auth/accounts').then((r) => r.accounts),
  createAccount: (body: { role: Role; username: string; password: string }) =>
    request<{ account: LoginAccount; accounts: LoginAccount[] }>('/auth/accounts', { method: 'POST', body: JSON.stringify(body) }),
  updateAccount: (id: number, body: { username?: string; password?: string; role?: Role; isActive?: boolean; currentPassword: string }) =>
    request<{ account: LoginAccount; accounts: LoginAccount[] }>(`/auth/accounts/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteAccount: (id: number, currentPassword: string) =>
    request<{ accounts: LoginAccount[] }>(`/auth/accounts/${id}`, { method: 'DELETE', body: JSON.stringify({ currentPassword }) }),


  /** Kitchen display data (no prices). */
  kitchenOrders: () => request<{ orders: KitchenOrder[] }>('/kitchen/orders').then((r) => r.orders),

  dailySummary: (date: string) =>
    request<{ summary: DailySummary }>(`/reports/daily?date=${encodeURIComponent(date)}`).then((r) => r.summary),

  analytics: (from: string, to: string) =>
    request<{ analytics: Analytics }>(`/reports/analytics?from=${from}&to=${to}&tz=${new Date().getTimezoneOffset()}`).then((r) => r.analytics),

  orderHistory: (query: HistoryQuery) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') q.set(k, String(v));
    return request<{ total: number; rows: HistoryRow[] }>(`/reports/history?${q}`);
  },

  /** Server validates the transition; `changed` is false if it was already in that status. */
  updateOrderStatus: (id: number, status: OrderStatus) =>
    request<{ order: Order | KitchenOrder; changed: boolean }>(`/orders/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
  // --- Credit (pay later) ---------------------------------------------------
  creditCustomers: (opts: { q?: string; all?: boolean } = {}) =>
    request<{ customers: CreditCustomer[] }>(`/credit/customers?${new URLSearchParams({ ...(opts.q ? { q: opts.q } : {}), ...(opts.all ? { all: '1' } : {}) })}`).then((r) => r.customers),
  creditLookup: (phone: string) => request<{ customer: CreditCustomer | null }>(`/credit/lookup?phone=${encodeURIComponent(phone)}`).then((r) => r.customer),
  creditCustomer: (id: number) => request<CreditCustomerDetail>(`/credit/customers/${id}`),
  collectCredit: (id: number, body: CollectCreditRequest) =>
    request<CreditCustomerDetail & { duplicate: boolean }>(`/credit/customers/${id}/collect`, { method: 'POST', body: JSON.stringify(body) }),

  cancelOrder: (id: number, reason: string) =>
    request<{ order: Order }>(`/orders/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),
  replaceOrderItems: (id: number, items: { menuItemId: number; quantity: number; packed?: boolean }[], notes?: string) =>
    request<{ order: Order }>(`/orders/${id}/items`, { method: 'PUT', body: JSON.stringify({ items, notes }) }),

  // --- Tables & Table Billing ---
  getTables: () => request<{ tables: string[]; diningTables: TableTileDTO[] }>('/tables'),
  getTableOverview: () => request<{ tables: TableTileDTO[] }>('/tables/overview').then((r) => r.tables),
  getTableDetails: (id: number) => request<TableDetailDTO>(`/tables/${id}`),
  createTable: (body: { name: string; capacity?: number | null }) =>
    request<{ table: TableDTO }>('/tables', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.table),
  updateTable: (id: number, body: { name?: string; capacity?: number | null; isActive?: boolean; sortOrder?: number; force?: boolean }) =>
    request<{ table: TableDTO }>(`/tables/${id}`, { method: 'PATCH', body: JSON.stringify(body) }).then((r) => r.table),
  getTableCheckout: (id: number) => request<TableCheckoutDTO>(`/tables/${id}/checkout`),
  generateTableBill: (id: number, discount: DiscountRequest) =>
    request<TableCheckoutDTO>(`/tables/${id}/bill`, { method: 'POST', body: JSON.stringify({ discount }) }),
  recordTablePayment: (id: number, payment: PaymentRequest) =>
    request<{ checkout: TableCheckoutDTO; payment: Payment; duplicate: boolean }>(`/tables/${id}/payments`, {
      method: 'POST',
      body: JSON.stringify(payment),
    }),
  getTableReceipt: (id: number) => request<TableReceiptDTO>(`/tables/${id}/receipt`),
  clearTable: (id: number) => request<{ table: TableTileDTO }>(`/tables/${id}/clear`, { method: 'POST' }).then((r) => r.table),
};
