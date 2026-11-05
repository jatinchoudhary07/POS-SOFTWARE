import {
  BellRing,
  CheckCheck,
  CircleAlert,
  Clock,
  ConciergeBell,
  CreditCard,
  Eye,
  Flame,
  LayoutGrid,
  Loader2,
  Package,
  Plus,
  Printer,
  RefreshCw,
  Send,
  Users,
  UtensilsCrossed,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { TableDetailDTO, TableTileDTO } from '../api/types';
import { cx } from '../lib/cx';
import { formatPaise } from '../lib/money';
import { formatClock } from '../lib/time';
import { useLiveOrders } from '../state/LiveOrders';
import { useReceiptPrinter } from './ReceiptPrinter';
import { Button, IconButton } from './ui/Button';
import { PaymentBadge } from './ui/PaymentBadge';
import { StatusBadge } from './ui/StatusBadge';
import { useToast } from './ui/Toast';

interface Props {
  onStartOrderForTable: (tableId: number, tableName: string) => void;
  onOpenTableCheckout: (tableId: number) => void;
  onOpenOrderCheckout?: (orderId: number) => void;
  onStartPackingOrder: () => void;
}

const KITCHEN_STAGE = {
  NEW: { label: 'Sent to kitchen', icon: Send, cls: 'bg-blue-100 text-blue-900 border-blue-300' },
  PREPARING: { label: 'Preparing', icon: Flame, cls: 'bg-orange-100 text-orange-900 border-orange-300' },
  READY: { label: 'Ready to serve', icon: BellRing, cls: 'bg-emerald-100 text-emerald-900 border-emerald-300' },
  COMPLETED: { label: 'Served', icon: CheckCheck, cls: 'bg-slate-100 text-slate-800 border-slate-300' },
} as const;

export function TablesView({ onStartOrderForTable, onOpenTableCheckout, onOpenOrderCheckout, onStartPackingOrder }: Props) {
  const toast = useToast();
  const { subscribe } = useLiveOrders();
  const { print: printReceipt, printTable, printing } = useReceiptPrinter();
  const [printingTableId, setPrintingTableId] = useState<number | null>(null);
  const [printingOrderId, setPrintingOrderId] = useState<number | null>(null);
  const [tiles, setTiles] = useState<TableTileDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'ALL' | 'RUNNING' | 'PRINTED' | 'PAID'>('ALL');
  const [selectedTableId, setSelectedTableId] = useState<number | null>(null);
  const [detail, setDetail] = useState<TableDetailDTO | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const loadTables = useCallback(async () => {
    try {
      const data = await api.getTableOverview();
      setTiles(data);
    } catch (e) {
      toast({ tone: 'error', title: 'Could not load tables', description: e instanceof ApiError ? e.message : undefined });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadTableDetails = useCallback(
    async (id: number) => {
      setDetailLoading(true);
      try {
        const d = await api.getTableDetails(id);
        setDetail(d);
      } catch (e) {
        toast({ tone: 'error', title: 'Could not load table details', description: e instanceof ApiError ? e.message : undefined });
      } finally {
        setDetailLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void loadTables();
  }, [loadTables]);

  // Live real-time updates: whenever an order or bill changes, refresh tables & active detail.
  useEffect(() => {
    return subscribe(() => {
      void loadTables();
      if (selectedTableId) {
        void loadTableDetails(selectedTableId);
      }
    });
  }, [subscribe, loadTables, loadTableDetails, selectedTableId]);

  const handleSelectTable = (id: number) => {
    setSelectedTableId(id);
    void loadTableDetails(id);
  };

  const filteredTiles = useMemo(() => {
    let res = tiles;
    if (filter === 'RUNNING') res = res.filter((t) => t.tableStatus === 'RUNNING_KOT');
    if (filter === 'PRINTED') res = res.filter((t) => t.tableStatus === 'PRINTED');
    if (filter === 'PAID') res = res.filter((t) => t.tableStatus === 'PAID');
    return res;
  }, [tiles, filter]);

  const runningCount = useMemo(() => tiles.filter((t) => t.tableStatus === 'RUNNING_KOT').length, [tiles]);
  const printedCount = useMemo(() => tiles.filter((t) => t.tableStatus === 'PRINTED').length, [tiles]);
  const paidCount = useMemo(() => tiles.filter((t) => t.tableStatus === 'PAID').length, [tiles]);
  const availableCount = useMemo(() => tiles.filter((t) => t.status === 'AVAILABLE' || t.tableStatus === 'BLANK').length, [tiles]);

  return (
    <div className="relative flex min-h-0 min-w-0 w-full max-w-full flex-1 overflow-x-hidden overflow-y-auto">
      {/* Main Tables Grid */}
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {/* Top Control Bar - Apple Glassmorphism Header */}
        <div className="border-b border-white/80 bg-white/70 px-3.5 py-3 sm:px-6 backdrop-blur-2xl shadow-[0_1px_10px_rgba(15,23,42,0.02)]">
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
            {/* Title & Live Status */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5 sm:gap-3">
                <span className="flex h-9 w-9 sm:h-10 sm:w-10 shrink-0 items-center justify-center rounded-[12px] sm:rounded-[14px] bg-[#ffede3] text-[#ff8548] shadow-2xs ring-1 ring-[#ff8548]/20">
                  <LayoutGrid size={18} aria-hidden />
                </span>
                <div>
                  <h1 className="text-lg sm:text-xl font-bold tracking-tight text-slate-900 leading-tight">Dining Tables</h1>
                  <p className="flex items-center gap-1.5 text-[11px] sm:text-xs font-medium text-slate-500">
                    <span className="tabular-nums">{tiles.length} tables</span>
                    <span>&bull;</span>
                    <span className={runningCount + printedCount > 0 ? "text-[#ff8548] font-bold" : "text-slate-500"}>
                      {runningCount + printedCount} occupied
                    </span>
                    <span>&bull;</span>
                    <span className="text-emerald-600 font-semibold">{availableCount} ready</span>
                  </p>
                </div>
              </div>

              {/* Mobile Actions: Compact Packing Pill & Refresh */}
              <div className="flex items-center gap-1.5 sm:hidden">
                <button
                  type="button"
                  onClick={onStartPackingOrder}
                  className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full bg-[#ff8548] hover:bg-[#f07436] text-white shadow-xs shadow-[#ff8548]/25 active:scale-[0.97] transition-all cursor-pointer whitespace-nowrap px-3 text-xs font-bold"
                  title="Packing Order (Self Pick & Delivery)"
                >
                  <Package size={14} aria-hidden />
                  <span>Packing</span>
                </button>
                <IconButton
                  icon={RefreshCw}
                  variant="secondary"
                  className="h-8 w-8"
                  aria-label="Refresh tables"
                  onClick={() => void loadTables()}
                  disabled={loading}
                />
              </div>
            </div>

            {/* Right Controls: Desktop Packing + Apple Segmented Filter Capsule + Desktop Refresh */}
            <div className="flex items-center gap-2.5 w-full sm:w-auto">
              <button
                type="button"
                onClick={onStartPackingOrder}
                className="hidden sm:inline-flex h-9 items-center justify-center gap-2 rounded-full bg-[#ff8548] hover:bg-[#f07436] text-white shadow-sm shadow-[#ff8548]/25 active:scale-[0.97] transition-all cursor-pointer whitespace-nowrap px-4 py-1.5 text-sm font-bold"
                title="Packing Order (Self Pick & Delivery)"
              >
                <Package size={15} aria-hidden />
                <span>Packing</span>
                <span className="hidden xl:inline text-[11px] font-semibold text-white/85">(Self Pick &amp; Delivery)</span>
              </button>

              {/* Apple-style Unified Filter Capsule: Clean, Zero-clutter */}
              <div
                role="tablist"
                aria-label="Filter tables by status"
                className="no-scrollbar flex w-full sm:w-auto overflow-x-auto rounded-full bg-slate-200/60 p-1 border border-white/80 backdrop-blur-md shadow-2xs gap-0.5"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'ALL'}
                  onClick={() => setFilter('ALL')}
                  className={cx(
                    'flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold whitespace-nowrap transition-all duration-150',
                    filter === 'ALL'
                      ? 'bg-white text-slate-900 shadow-[0_2px_8px_rgba(15,23,42,0.08)] ring-1 ring-black/5 font-bold'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-white/40',
                  )}
                >
                  <span>All</span>
                  <span className="tabular-nums text-slate-400 font-normal">({tiles.length})</span>
                </button>

                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'RUNNING'}
                  onClick={() => setFilter('RUNNING')}
                  className={cx(
                    'flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold whitespace-nowrap transition-all duration-150',
                    filter === 'RUNNING'
                      ? 'bg-white text-amber-950 shadow-[0_2px_8px_rgba(15,23,42,0.08)] ring-1 ring-amber-400/40 font-bold'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-white/40',
                  )}
                >
                  <span className="h-2 w-2 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.8)] shrink-0" />
                  <span>Running</span>
                  <span className="tabular-nums text-slate-400 font-normal">({runningCount})</span>
                </button>

                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'PRINTED'}
                  onClick={() => setFilter('PRINTED')}
                  className={cx(
                    'flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold whitespace-nowrap transition-all duration-150',
                    filter === 'PRINTED'
                      ? 'bg-white text-emerald-950 shadow-[0_2px_8px_rgba(15,23,42,0.08)] ring-1 ring-emerald-500/40 font-bold'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-white/40',
                  )}
                >
                  <span className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.8)] shrink-0" />
                  <span>Printed</span>
                  <span className="tabular-nums text-slate-400 font-normal">({printedCount})</span>
                </button>

                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'PAID'}
                  onClick={() => setFilter('PAID')}
                  className={cx(
                    'flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold whitespace-nowrap transition-all duration-150',
                    filter === 'PAID'
                      ? 'bg-white text-blue-950 shadow-[0_2px_8px_rgba(15,23,42,0.08)] ring-1 ring-blue-500/40 font-bold'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-white/40',
                  )}
                >
                  <span className="h-2 w-2 rounded-full bg-blue-500 shadow-[0_0_6px_rgba(59,130,246,0.8)] shrink-0" />
                  <span>Paid</span>
                  <span className="tabular-nums text-slate-400 font-normal">({paidCount})</span>
                </button>
              </div>

              <div className="hidden sm:block">
                <IconButton
                  icon={RefreshCw}
                  variant="secondary"
                  aria-label="Refresh tables"
                  onClick={() => void loadTables()}
                  disabled={loading}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 p-2 sm:p-5 sm:p-6 pb-24 md:pb-6">
          {loading ? (
            <div className="flex h-64 items-center justify-center gap-2 text-ink-2">
              <Loader2 size={24} className="animate-spin text-accent" />
              <span>Loading tables...</span>
            </div>
          ) : filteredTiles.length === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center rounded-card border border-dashed border-line p-8 text-center">
              <UtensilsCrossed size={36} className="text-ink-3" />
              <p className="mt-3 text-base font-semibold text-ink">No tables match your filter</p>
              <p className="mt-1 text-sm text-ink-2">Try changing your search or status filter.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-2 sm:gap-4 md:gap-5">
              {filteredTiles.map((table) => {
                const isBlank = table.tableStatus === 'BLANK' || (table.status === 'AVAILABLE' && table.tableStatus !== 'PAID');
                const isPrinted = table.tableStatus === 'PRINTED';
                const isPaid = table.tableStatus === 'PAID';

                return !isBlank ? (
                  /* Occupied Table - Apple Frosted Glass Card */
                  <div
                    key={table.id}
                    onClick={() => onStartOrderForTable(table.id, table.name)}
                    className={cx(
                      'group relative flex flex-col justify-between rounded-2xl sm:rounded-[24px] backdrop-blur-xl border p-2.5 sm:p-5 text-left transition-all duration-300 hover:-translate-y-1 hover:shadow-xl cursor-pointer select-none',
                      isPaid
                        ? 'bg-blue-50/75 border-blue-200/80 shadow-[0_4px_24px_rgba(59,130,246,0.08)]'
                        : isPrinted
                          ? 'bg-emerald-50/75 border-emerald-200/80 shadow-[0_4px_24px_rgba(16,185,129,0.08)]'
                          : 'bg-amber-50/75 border-amber-200/80 shadow-[0_4px_24px_rgba(245,158,11,0.08)]',
                    )}
                  >
                    {/* Top Row: Squircle Avatar, Table Name & Elapsed Time */}
                    <div className="flex items-center justify-between gap-1.5 sm:gap-2">
                      <div className="flex items-center gap-1.5 sm:gap-3 min-w-0">
                        <span
                          className={cx(
                            'flex h-8 w-8 sm:h-11 sm:w-11 items-center justify-center rounded-[10px] sm:rounded-[16px] font-black text-xs sm:text-sm text-white shadow-xs ring-1 ring-black/5 group-hover:scale-105 transition-transform duration-200 shrink-0',
                            isPaid
                              ? 'bg-blue-600 shadow-blue-500/20'
                              : isPrinted
                                ? 'bg-emerald-600 shadow-emerald-500/20'
                                : 'bg-amber-500 shadow-amber-500/20',
                          )}
                        >
                          {table.name.replace(/[^0-9a-zA-Z]/g, '').substring(0, 2).toUpperCase() || 'T'}
                        </span>
                        <div className="min-w-0">
                          <h3 className="text-sm sm:text-xl font-bold tracking-tight text-slate-900 truncate leading-tight">
                            {table.name}
                          </h3>
                          <span className="hidden sm:inline text-[11px] font-medium text-slate-500">
                            {table.capacity ? `${table.capacity} seats` : 'Dining'}
                          </span>
                        </div>
                      </div>
                      <span
                        className={cx(
                          'inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 sm:px-2.5 sm:py-1 text-[10px] sm:text-xs font-bold border backdrop-blur-sm',
                          isPaid
                            ? 'bg-blue-100/80 text-blue-900 border-blue-300/80'
                            : isPrinted
                              ? 'bg-emerald-100/80 text-emerald-900 border-emerald-300/80'
                              : 'bg-amber-100/80 text-amber-950 border-amber-300/80',
                        )}
                      >
                        <Clock size={10} className="sm:w-3 sm:h-3" aria-hidden />
                        {(() => {
                          const iso = table.firstOrderAt ?? table.createdAt;
                          const mins = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
                          return `${mins}m`;
                        })()}
                      </span>
                    </div>

                    {/* Where the food is: sent / preparing / ready / served */}
                    {table.kitchenStatus && (
                      <div className="mt-2 sm:mt-3">
                        {(() => {
                          const st = KITCHEN_STAGE[table.kitchenStatus];
                          const StageIcon = st.icon;
                          return (
                            <span key={table.kitchenStatus} className={cx('animate-pop inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 sm:px-2.5 sm:py-1 text-[10px] sm:text-xs font-bold', st.cls)}>
                              <StageIcon size={12} className={cx('shrink-0', table.kitchenStatus === 'READY' && 'animate-bounce')} aria-hidden />
                              <span className="truncate">{st.label}</span>
                            </span>
                          );
                        })()}
                      </div>
                    )}

                    {/* Middle Row: Status Pill & Apple Pay-style Total */}
                    <div className="my-2 sm:my-4 flex items-baseline justify-between gap-1 sm:gap-2">
                      <span
                        className={cx(
                          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 sm:px-3 sm:py-1 text-[10px] sm:text-xs font-bold uppercase tracking-wider backdrop-blur-sm truncate max-w-[70px] sm:max-w-none',
                          isPaid
                            ? 'bg-blue-200/80 text-blue-950'
                            : isPrinted
                              ? 'bg-emerald-200/80 text-emerald-950'
                              : 'bg-amber-200/80 text-amber-950',
                        )}
                      >
                        {isPaid ? 'Paid' : isPrinted ? 'Printed' : `${table.activeOrderCount} KOT`}
                      </span>
                      <span className="text-sm sm:text-2xl font-black tabular-nums tracking-tight text-slate-900 truncate">
                        {formatPaise(table.runningTotalPaise)}
                      </span>
                    </div>

                    {/* Bottom Row: Actions */}
                    <div
                      className={cx(
                        'border-t pt-2 sm:pt-3 flex items-center justify-between gap-1 sm:gap-2',
                        isPaid
                          ? 'border-blue-200/70'
                          : isPrinted
                            ? 'border-emerald-200/70'
                            : 'border-amber-200/70',
                      )}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {isPaid ? (
                        <button
                          type="button"
                          title="Clear & Free Table"
                          onClick={async () => {
                            try {
                              await api.clearTable(table.id);
                              toast({ tone: 'success', title: `Table ${table.name} cleared` });
                              await loadTables();
                            } catch (e) {
                              toast({ tone: 'error', title: 'Could not clear table', description: e instanceof ApiError ? e.message : undefined });
                            }
                          }}
                          className="flex-1 py-1.5 sm:py-2 px-1 sm:px-2 rounded-[8px] sm:rounded-[12px] bg-blue-600 hover:bg-blue-700 text-white text-[11px] sm:text-xs font-bold flex items-center justify-center gap-1 shadow-xs active:scale-[0.98] transition-all truncate"
                        >
                          <CheckCheck size={12} className="shrink-0" />
                          <span className="truncate">Clear</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          title="Settle & Pay Bill"
                          onClick={() => onOpenTableCheckout(table.id)}
                          className={cx(
                            'flex-1 py-1.5 sm:py-2 px-1 sm:px-2 rounded-[8px] sm:rounded-[12px] text-white text-[11px] sm:text-xs font-bold flex items-center justify-center gap-1 shadow-xs active:scale-[0.98] transition-all truncate',
                            isPrinted
                              ? 'bg-emerald-600 hover:bg-emerald-700'
                              : 'bg-amber-600 hover:bg-amber-700',
                          )}
                        >
                          <CreditCard size={12} className="shrink-0" />
                          <span className="truncate">Settle</span>
                        </button>
                      )}

                      <button
                        type="button"
                        title="Print Receipt"
                        disabled={printing}
                        onClick={async () => {
                          setPrintingTableId(table.id);
                          try {
                            await printTable(table.id);
                            await loadTables();
                          } catch {
                            toast({ tone: 'error', title: 'Could not print table receipt' });
                          } finally {
                            setPrintingTableId(null);
                          }
                        }}
                        className="h-7 w-7 sm:h-8 sm:w-8 shrink-0 rounded-[8px] sm:rounded-[10px] bg-white/80 hover:bg-white text-slate-700 flex items-center justify-center border border-slate-200/80 shadow-2xs active:scale-95 transition-all"
                      >
                        {printing && printingTableId === table.id ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <Printer size={12} />
                        )}
                      </button>

                      <button
                        type="button"
                        title="View Details"
                        onClick={() => handleSelectTable(table.id)}
                        className="h-7 w-7 sm:h-8 sm:w-8 shrink-0 rounded-[8px] sm:rounded-[10px] bg-white/80 hover:bg-white text-slate-700 flex items-center justify-center border border-slate-200/80 shadow-2xs active:scale-95 transition-all"
                      >
                        <Eye size={12} />
                      </button>
                    </div>
                  </div>
                ) : (
                  /* Blank Table - Apple Frosted Glass Squircle Card */
                  <div
                    key={table.id}
                    onClick={() => onStartOrderForTable(table.id, table.name)}
                    className="group relative flex flex-col justify-between rounded-2xl sm:rounded-[24px] bg-white/75 backdrop-blur-xl border border-white/90 shadow-[0_4px_20px_-2px_rgba(15,23,42,0.04),0_0_0_1px_rgba(15,23,42,0.03)] hover:shadow-[0_16px_36px_-4px_rgba(15,23,42,0.09),0_0_0_1px_rgba(15,23,42,0.06)] hover:bg-white/92 hover:-translate-y-1 p-2.5 sm:p-5 text-left transition-all duration-250 cursor-pointer select-none"
                  >
                    {/* Top Row: Squircle Table Icon, Table Name, Capacity Capsule */}
                    <div className="flex items-center justify-between gap-1.5 sm:gap-2">
                      <div className="flex items-center gap-1.5 sm:gap-3 min-w-0">
                        <span className="flex h-8 w-8 sm:h-11 sm:w-11 items-center justify-center rounded-[10px] sm:rounded-[16px] bg-[#ffede3] text-[#ff8548] font-black text-xs sm:text-sm shadow-2xs ring-1 ring-[#ff8548]/25 group-hover:scale-105 transition-transform duration-200 shrink-0">
                          {table.name.replace(/[^0-9a-zA-Z]/g, '').substring(0, 2).toUpperCase() || 'T'}
                        </span>
                        <div className="min-w-0">
                          <h3 className="text-sm sm:text-xl font-bold tracking-tight text-slate-900 leading-tight truncate">
                            {table.name}
                          </h3>
                          <span className="hidden sm:inline text-[11px] font-medium text-slate-400">
                            Dining
                          </span>
                        </div>
                      </div>
                      {table.capacity && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-slate-100/80 px-1.5 py-0.5 sm:px-2.5 sm:py-1 text-[10px] sm:text-xs font-semibold text-slate-600 backdrop-blur-xs border border-slate-200/50">
                          <Users size={10} className="sm:w-3 sm:h-3" aria-hidden />
                          {table.capacity}s
                        </span>
                      )}
                    </div>

                    {/* Middle Row: Apple Live Glowing Status Pill */}
                    <div className="my-2 sm:my-4 flex items-center justify-between">
                      <span className="inline-flex items-center gap-1.5 sm:gap-2 rounded-full bg-emerald-500/10 px-1.5 py-0.5 sm:px-3 sm:py-1 text-[10px] sm:text-xs font-semibold text-emerald-700 ring-1 ring-emerald-500/20 backdrop-blur-md">
                        <span className="relative flex h-1.5 w-1.5 sm:h-2 sm:w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-1.5 w-1.5 sm:h-2 sm:w-2 bg-emerald-500"></span>
                        </span>
                        <span>Available</span>
                      </span>
                      <span className="text-[10px] sm:text-xs font-medium text-slate-400">Ready</span>
                    </div>

                    {/* Bottom Row: Warm Orange Take Order Button */}
                    <div className="pt-2 sm:pt-3 border-t border-slate-100/90">
                      <button
                        type="button"
                        className="w-full flex items-center justify-center gap-1 sm:gap-2 py-1.5 sm:py-2.5 px-2 sm:px-4 rounded-[10px] sm:rounded-[14px] bg-[#ff8548] hover:bg-[#f07436] text-white text-[11px] sm:text-xs font-bold shadow-sm shadow-[#ff8548]/25 active:scale-[0.98] transition-all"
                      >
                        <Plus size={13} strokeWidth={2.5} className="shrink-0" />
                        <span className="truncate">Take Order</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Drawer Backdrop on mobile */}
      {selectedTableId !== null && (
        <div
          role="presentation"
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-xs transition-opacity sm:hidden"
          onClick={() => {
            setSelectedTableId(null);
            setDetail(null);
          }}
        />
      )}

      {/* Drawer: Table Details & Active Orders */}
      {selectedTableId !== null && (
        <aside
          aria-label="Table details"
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col border-l border-white/60 bg-white/85 backdrop-blur-2xl shadow-2xl transition-all pt-[env(safe-area-inset-top)] pb-[calc(1rem+env(safe-area-inset-bottom))] sm:w-[440px] sm:pt-0 sm:pb-0"
        >
          {detailLoading && !detail ? (
            <div className="flex h-full items-center justify-center gap-2 text-ink-2">
              <Loader2 size={24} className="animate-spin text-accent" />
              <span>Loading table details...</span>
            </div>
          ) : detail ? (
            <div className="flex h-full flex-col">
              {/* Drawer Header */}
              <div className="border-b border-slate-200/60 bg-white/50 backdrop-blur-md px-5 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="text-xl font-bold tracking-tight text-slate-900">{detail.table.name}</h2>
                      {detail.table.capacity && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-600 font-semibold">
                          <Users size={12} aria-hidden />
                          {detail.table.capacity} seats
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <span
                        className={cx(
                          'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold',
                          detail.table.status === 'OCCUPIED' ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-900',
                        )}
                      >
                        <span
                          className={cx(
                            'h-1.5 w-1.5 rounded-full',
                            detail.table.status === 'OCCUPIED' ? 'bg-amber-500' : 'bg-emerald-500',
                          )}
                          aria-hidden
                        />
                        {detail.table.status === 'OCCUPIED' ? 'Occupied' : 'Available'}
                      </span>
                    </div>
                  </div>

                  <IconButton
                    icon={X}
                    variant="plain"
                    aria-label="Close details"
                    onClick={() => {
                      setSelectedTableId(null);
                      setDetail(null);
                    }}
                  />
                </div>

                {/* Running Total Highlight */}
                {detail.table.status === 'OCCUPIED' && (
                  <div className="mt-4 flex items-baseline justify-between rounded-[16px] bg-[#ff8548] text-white px-4.5 py-3.5 shadow-sm shadow-[#ff8548]/25">
                    <span className="text-xs font-semibold uppercase tracking-wider text-white/85">Running Total Due</span>
                    <span className="text-2xl font-black tabular-nums tracking-tight text-white">
                      {formatPaise(detail.runningTotalPaise)}
                    </span>
                  </div>
                )}
              </div>

              {/* Order Actions */}
              <div className="flex gap-2 border-b border-line bg-canvas/50 px-5 py-3">
                <Button
                  size="md"
                  variant="secondary"
                  icon={Plus}
                  className="flex-1"
                  onClick={() => onStartOrderForTable(detail.table.id, detail.table.name)}
                >
                  + Add another order
                </Button>
                {detail.table.tableStatus === 'PAID' ? (
                  <Button
                    size="md"
                    variant="primary"
                    icon={CheckCheck}
                    className="flex-1"
                    onClick={async () => {
                      try {
                        await api.clearTable(detail.table.id);
                        toast({ tone: 'success', title: `Table ${detail.table.name} cleared` });
                        setSelectedTableId(null);
                        setDetail(null);
                        await loadTables();
                      } catch {
                        toast({ tone: 'error', title: 'Could not clear table' });
                      }
                    }}
                  >
                    Clear &amp; Free Table
                  </Button>
                ) : detail.orders.length > 0 ? (
                  <Button
                    size="md"
                    variant="primary"
                    icon={CreditCard}
                    className="flex-1"
                    onClick={() => onOpenTableCheckout(detail.table.id)}
                  >
                    Proceed to billing
                  </Button>
                ) : null}
              </div>

              {/* Drawer Scrollable Body: Active Dine-in Orders */}
              <div className="flex-1 overflow-y-auto p-5">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-bold tracking-tight text-ink uppercase">
                    Active Orders ({detail.orders.length})
                  </h3>
                  {detailLoading && <Loader2 size={14} className="animate-spin text-ink-3" />}
                </div>

                {detail.orders.length === 0 ? (
                  <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-line p-8 text-center text-ink-2">
                    <ConciergeBell size={32} className="text-ink-3" />
                    <p className="mt-2 text-sm font-medium">No active unpaid orders</p>
                    <p className="mt-1 text-xs text-ink-3">Tap "+ Add another order" to start a new order for this table.</p>
                  </div>
                ) : (
                  <div className="space-y-3.5">
                    {detail.orders.map((o) => (
                      <div key={o.id} className="rounded-card border border-line bg-surface p-4 shadow-sm">
                        <div className="flex items-start justify-between gap-2 border-b border-line/60 pb-2.5">
                          <div>
                            <span className="font-mono text-sm font-bold text-ink">#{o.orderNumber}</span>
                            <div className="flex items-center gap-1.5 text-xs text-ink-2">
                              <Clock size={12} aria-hidden />
                              <span>{formatClock(o.createdAt)}</span>
                            </div>
                          </div>
                          <div className="flex flex-col items-end gap-1">
                            <StatusBadge status={o.status} />
                            <PaymentBadge status={o.paymentStatus} />
                          </div>
                        </div>

                        {/* Order Items */}
                        <div className="mt-2.5 space-y-1.5 text-sm">
                          {o.items.map((i) => (
                            <div key={i.id} className="flex justify-between text-ink">
                              <span>
                                <strong className="tabular-nums font-semibold">{i.quantity}&times;</strong> {i.itemName}
                              </span>
                              <span className="tabular-nums text-ink-2">{formatPaise(i.lineTotalPaise)}</span>
                            </div>
                          ))}
                        </div>

                        {/* Order Subtotal */}
                        <div className="mt-3 flex items-baseline justify-between border-t border-line/60 pt-2 text-sm">
                          <span className="text-xs text-ink-2">Order subtotal</span>
                          <span className="font-semibold tabular-nums text-ink">{formatPaise(o.subtotalPaise)}</span>
                        </div>

                        {/* Order Actions */}
                        <div className="mt-3 flex items-center justify-end gap-2 border-t border-line/60 pt-2.5">
                          {onOpenOrderCheckout && (
                            <Button
                              size="sm"
                              variant="plain"
                              onClick={() => onOpenOrderCheckout(o.id)}
                            >
                              Open bill
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="secondary"
                            icon={Printer}
                            loading={printing && printingOrderId === o.id}
                            disabled={printing}
                            onClick={async () => {
                              setPrintingOrderId(o.id);
                              try {
                                await printReceipt(o.id);
                              } finally {
                                setPrintingOrderId(null);
                              }
                            }}
                          >
                            Print receipt
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Bottom Sticky Settle Bar */}
              {detail.table.tableStatus === 'PAID' ? (
                <div className="border-t border-line bg-surface p-4 shadow-lg flex gap-2">
                  <Button
                    size="lg"
                    variant="secondary"
                    icon={Printer}
                    disabled={printing}
                    className="flex-1"
                    onClick={async () => {
                      try {
                        await printTable(detail.table.id);
                      } catch {
                        toast({ tone: 'error', title: 'Could not print table receipt' });
                      }
                    }}
                  >
                    Print Receipt
                  </Button>
                  <Button
                    size="lg"
                    variant="primary"
                    icon={CheckCheck}
                    className="flex-1"
                    onClick={async () => {
                      try {
                        await api.clearTable(detail.table.id);
                        toast({ tone: 'success', title: `Table ${detail.table.name} cleared` });
                        setSelectedTableId(null);
                        setDetail(null);
                        await loadTables();
                      } catch {
                        toast({ tone: 'error', title: 'Could not clear table' });
                      }
                    }}
                  >
                    Clear Table
                  </Button>
                </div>
              ) : detail.orders.length > 0 ? (
                <div className="border-t border-line bg-surface p-4 shadow-lg">
                  <Button
                    size="lg"
                    variant="primary"
                    icon={CreditCard}
                    className="w-full text-base"
                    onClick={() => onOpenTableCheckout(detail.table.id)}
                  >
                    Combine {detail.orders.length} order{detail.orders.length === 1 ? '' : 's'} &amp; Bill &bull; {formatPaise(detail.runningTotalPaise)}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center p-6 text-center text-ink-2">
              <CircleAlert size={36} className="text-warning" />
              <p className="mt-2 text-sm">Table information could not be retrieved.</p>
              <Button size="sm" variant="secondary" onClick={() => setSelectedTableId(null)} className="mt-4">
                Close
              </Button>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
