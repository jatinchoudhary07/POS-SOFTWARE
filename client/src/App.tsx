import { Loader2, RotateCw, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError } from './api/client';
import type { MenuCategory, MenuItem, TableTileDTO } from './api/types';
import { useAppUpdate } from './lib/useAppUpdate';
import { useKeepWarm } from './lib/useKeepWarm';
import { CartBar } from './components/CartBar';
import { CategorySidebar } from './components/CategorySidebar';
import { CheckoutView } from './components/CheckoutView';
import { TableCheckoutView } from './components/TableCheckoutView';
import { TablesView } from './components/TablesView';
import { Header, type NavView, type View } from './components/Header';
import { KitchenView } from './components/KitchenView';
import { OrderAlerts } from './components/OrderAlerts';
import { MenuGrid } from './components/MenuGrid';
import { MobileNav } from './components/MobileNav';
import { OrderPanel } from './components/OrderPanel';
import { OrdersView } from './components/OrdersView';
import { SalesView } from './components/SalesView';
import { SettingsView } from './components/SettingsView';
import { Button } from './components/ui/Button';
import { useToast } from './components/ui/Toast';
import { cartProblem, cartReducer, createEmptyCart, toCreateOrderRequest } from './state/cart';
import { loadDraft, saveDraft } from './state/draftStorage';
import { useAuth, useUser } from './state/Auth';
import { useLiveOrders } from './state/LiveOrders';
import { canView, LANDING } from './state/permissions';

const RESTAURANT_NAME = import.meta.env.VITE_RESTAURANT_NAME || 'Two Hearts Cafe';

// Each screen has its own URL, so the kitchen computer can simply open /kitchen.
interface Route {
  view: View;
  orderId?: number;
  tableId?: number;
}
const PATHS: Record<NavView, string> = { tables: '/', new: '/pos', orders: '/orders', kitchen: '/kitchen', sales: '/sales', settings: '/settings' };
const pathOf = (r: Route) => (r.view === 'checkout' ? (r.tableId ? `/checkout/table/${r.tableId}` : `/checkout/${r.orderId}`) : PATHS[r.view]);
function routeFromPath(path: string): Route {
  const tableCheckout = /^\/checkout\/table\/(\d+)/.exec(path);
  if (tableCheckout) return { view: 'checkout', tableId: Number(tableCheckout[1]) };
  const checkout = /^\/checkout\/(\d+)/.exec(path);
  if (checkout) return { view: 'checkout', orderId: Number(checkout[1]) };
  for (const v of ['kitchen', 'orders', 'sales', 'settings'] as const) if (path.startsWith(PATHS[v])) return { view: v };
  if (path === '/pos' || path.startsWith('/pos/')) return { view: 'new' };
  if (path === '/tables' || path.startsWith('/tables/')) return { view: 'tables' };
  return { view: 'tables' };
}

export default function App() {
  useKeepWarm();
  useAppUpdate();
  const user = useUser();
  const { logout } = useAuth();
  const [requested, setRoute] = useState<Route>(() => routeFromPath(window.location.pathname));
  // Screens this login may not open (e.g. a typed /settings URL) fall back to its landing
  // screen. This is UX only — the server rejects the data requests anyway.
  const route: Route = canView(user.role, requested.view) ? requested : { view: LANDING[user.role] };
  const view = route.view;
  useEffect(() => {
    if (window.location.pathname !== pathOf(route)) window.history.replaceState(null, '', pathOf(route));
  }, [route]);
  const [menu, setMenu] = useState<MenuCategory[] | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [tables, setTables] = useState<string[]>([]);
  const [diningTables, setDiningTables] = useState<TableTileDTO[]>([]);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  // The draft order lives here (above all screens) and in localStorage, so switching to the
  // kitchen view or refreshing the page never loses it.
  const [cart, dispatch] = useReducer(cartReducer, undefined, () => loadDraft() ?? createEmptyCart());
  const [submitting, setSubmitting] = useState(false);
  const [highlightId, setHighlightId] = useState<number | null>(null);
  // Phones: the current order opens as a full-screen sheet over the menu.
  const [orderSheetOpen, setOrderSheetOpen] = useState(false);
  // A new draft (order sent or cleared) goes back to the menu.
  useEffect(() => setOrderSheetOpen(false), [cart.requestId]);
  useEffect(() => {
    if (!orderSheetOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOrderSheetOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [orderSheetOpen]);
  // A ref (not state) so a fast double-tap is blocked before React re-renders.
  const submittingRef = useRef(false);
  const toast = useToast();
  const live = useLiveOrders();

  const navigate = useCallback((r: Route) => {
    setRoute(r);
    if (window.location.pathname !== pathOf(r)) window.history.pushState(null, '', pathOf(r));
  }, []);
  const setView = useCallback((v: NavView) => navigate({ view: v }), [navigate]);
  // Tapping Tables while already on Tables brings it back to its first screen (the All tab).
  const [tablesHome, setTablesHome] = useState(0);
  const goView = useCallback(
    (v: NavView) => {
      if (v === 'tables' && window.location.pathname === pathOf({ view: 'tables' })) setTablesHome((n) => n + 1);
      setView(v);
    },
    [setView],
  );
  const openCheckout = useCallback((orderId: number) => navigate({ view: 'checkout', orderId }), [navigate]);
  const openTableCheckout = useCallback((tableId: number) => navigate({ view: 'checkout', tableId }), [navigate]);
  const startOrderForTable = useCallback(
    (tableId: number, tableName: string) => {
      dispatch({ type: 'setOrderType', orderType: 'DINE_IN' });
      dispatch({ type: 'setTable', tableNumber: tableName, tableId });
      navigate({ view: 'new' });
    },
    [navigate],
  );
  const startPackingOrder = useCallback(() => {
    dispatch({ type: 'setOrderType', orderType: 'TAKEAWAY' });
    dispatch({ type: 'setTable', tableNumber: '', tableId: null });
    navigate({ view: 'new' });
  }, [navigate]);
  useEffect(() => {
    const onPop = () => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => saveDraft(cart), [cart]);


  const loadMenu = useCallback(async () => {
    try {
      const categories = await api.getMenu();
      setMenu(categories);
      setMenuError(null);
      dispatch({ type: 'syncMenu', categories });
      setCategoryId((current) => (categories.some((c) => c.id === current) ? current : (categories[0]?.id ?? null)));
    } catch (e) {
      setMenuError(e instanceof ApiError ? e.message : 'Could not load the menu');
    }
  }, []);

  // Only logins that take orders load the menu (the kitchen login may not read it). Reloaded when
  // leaving Settings so menu and table edits show up straight away.
  const takesOrders = canView(user.role, 'new');
  useEffect(() => {
    if (!takesOrders || view === 'settings') return;
    void loadMenu();
    api
      .getTables()
      .then((res) => {
        setTables(res.tables);
        setDiningTables(res.diningTables);
      })
      .catch(() => {
        setTables([]);
        setDiningTables([]);
      });
  }, [loadMenu, takesOrders, view]);

  const visibleItems: MenuItem[] = useMemo(() => {
    if (!menu) return [];
    const q = search.trim().toLowerCase();
    if (q) return menu.flatMap((c) => c.items).filter((i) => i.name.toLowerCase().includes(q));
    return menu.find((c) => c.id === categoryId)?.items ?? [];
  }, [menu, categoryId, search]);

  const quantities = useMemo(() => new Map(cart.lines.map((l) => [l.menuItemId, l.quantity])), [cart.lines]);
  const title = search.trim() ? `Results for “${search.trim()}”` : (menu?.find((c) => c.id === categoryId)?.name ?? '');

  async function submit() {
    if (submittingRef.current || cartProblem(cart)) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      // The cart's requestId stays the same until success, so retrying after a
      // network failure can never create the order twice.
      const { order, merged } = await api.createOrder(toCreateOrderRequest(cart));
      dispatch({ type: 'reset' });
      live.ingest(order);
      if (merged) toast({ tone: 'success', title: `Added to order #${order.orderNumber}`, description: `${order.tableNumber ? `Table ${order.tableNumber}` : 'This table'} has one running order, so the new items were added to it.` });
      setHighlightId(order.id);
      navigate({ view: 'tables' });
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === 'ITEM_UNAVAILABLE' || e.code === 'ITEM_NOT_FOUND') {
          const ids = (e.details as { menuItemIds?: number[] } | undefined)?.menuItemIds ?? [];
          dispatch({ type: 'markUnavailable', menuItemIds: ids });
          loadMenu();
          toast({ tone: 'error', title: 'Some items are unavailable', description: `${e.message}. Remove them and send again.` });
        } else if (e.status === 0) {
          toast({ tone: 'error', title: 'Order not sent', description: `${e.message} Your order is kept — press Send again.` });
        } else {
          toast({ tone: 'error', title: 'Order not sent', description: e.message });
        }
      } else {
        toast({ tone: 'error', title: 'Order not sent', description: 'Unexpected error. Please try again.' });
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="relative flex h-full w-full max-w-full min-w-0 flex-col overflow-hidden bg-[#f8fafc]">
      {/* Apple-style subtle ambient background lighting for frosted glass refraction */}
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden select-none">
        <div className="absolute -top-40 -left-40 h-[500px] w-[500px] rounded-full bg-[radial-gradient(closest-side,rgba(226,232,240,0.55),transparent)]" />
        <div className="absolute top-1/4 -right-40 h-[600px] w-[600px] rounded-full bg-[radial-gradient(closest-side,rgba(255,228,230,0.5),transparent)]" />
        <div className="absolute -bottom-40 left-1/3 h-[550px] w-[550px] rounded-full bg-[radial-gradient(closest-side,rgba(219,234,254,0.45),transparent)]" />
      </div>

      <OrderAlerts />
      <Header
        restaurantName={RESTAURANT_NAME}
        view={view}
        onViewChange={goView}
        user={user}
        onLogout={() => void logout()}
      />

      {/* key={view} replays a short fade/slide when switching screens */}
      <main key={pathOf(route)} className="flex min-h-0 min-w-0 w-full max-w-full flex-1 overflow-hidden">
        {view === 'kitchen' ? (
          <KitchenView />
        ) : view === 'checkout' && route.tableId ? (
          <TableCheckoutView tableId={route.tableId} onBack={() => setView('tables')} />
        ) : view === 'checkout' && route.orderId ? (
          <CheckoutView orderId={route.orderId} onBack={() => setView('orders')} />
        ) : view === 'tables' ? (
          <TablesView
            onStartOrderForTable={startOrderForTable}
            onOpenTableCheckout={openTableCheckout}
            onOpenOrderCheckout={openCheckout}
            onStartPackingOrder={startPackingOrder}
            homeSignal={tablesHome}
          />
        ) : view === 'sales' ? (
          <SalesView onOpenOrder={openCheckout} />
        ) : view === 'settings' ? (
          <SettingsView />
        ) : view === 'orders' ? (
          <OrdersView highlightId={highlightId} onCheckout={openCheckout} />
        ) : menu === null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-ink-2">
            {menuError ? (
              <>
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-danger-tint text-danger">
                  <WifiOff size={22} aria-hidden />
                </span>
                <p className="font-medium text-ink">{menuError}</p>
                <Button variant="primary" icon={RotateCw} onClick={loadMenu}>
                  Try again
                </Button>
              </>
            ) : (
              <p className="flex items-center gap-2">
                <Loader2 size={18} className="animate-spin" aria-hidden /> Loading menu…
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row overflow-hidden">
              <CategorySidebar
                categories={menu}
                selectedId={search.trim() ? null : categoryId}
                onSelect={(id) => {
                  setSearch('');
                  setCategoryId(id);
                }}
              />
              <MenuGrid
                viewKey={search.trim() ? 'search' : `cat-${categoryId}`}
                title={title}
                items={visibleItems}
                quantities={quantities}
                search={search}
                onSearchChange={setSearch}
                onAdd={(item) => dispatch({ type: 'add', item })}
                onIncrement={(item) => dispatch({ type: 'increment', menuItemId: item.id })}
                onDecrement={(item) => dispatch({ type: 'decrement', menuItemId: item.id })}
              />
              <CartBar cart={cart} onOpen={() => setOrderSheetOpen(true)} />
            </div>
            <div className="hidden md:flex h-full min-h-0">
              <OrderPanel
                cart={cart}
                dispatch={dispatch}
                tables={tables}
                diningTables={diningTables}
                submitting={submitting}
                onSubmit={submit}
                onOpenTableCheckout={openTableCheckout}
                onBackToTables={() => navigate({ view: 'tables' })}
              />
            </div>
            {/* Rendered at the page root: the screen's enter animation would otherwise confine a fixed overlay. */}
            {orderSheetOpen &&
              createPortal(
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-label="Current order"
                  className="fixed inset-0 z-40 flex animate-enter flex-col bg-surface pt-[env(safe-area-inset-top)] md:hidden"
                >
                  <OrderPanel
                    cart={cart}
                    dispatch={dispatch}
                    tables={tables}
                    diningTables={diningTables}
                    submitting={submitting}
                    onSubmit={submit}
                    variant="sheet"
                    onClose={() => setOrderSheetOpen(false)}
                    onOpenTableCheckout={(tId) => {
                      setOrderSheetOpen(false);
                      openTableCheckout(tId);
                    }}
                    onBackToTables={() => {
                      setOrderSheetOpen(false);
                      navigate({ view: 'tables' });
                    }}
                  />
                </div>,
                document.body,
              )}
          </>
        )}
      </main>
      <MobileNav view={view} role={user.role} onViewChange={goView} />
    </div>
  );
}
