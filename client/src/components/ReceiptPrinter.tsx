import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError } from '../api/client';
import type { Receipt as ReceiptData } from '../api/types';
import { Receipt, type ReceiptFormat } from './Receipt';
import { useToast } from './ui/Toast';

const FORMAT_KEY = 'pos.receiptFormat';

// Paper size for the browser's print dialog. "compact" suits 80 mm roll printers that have a
// normal system printer driver; it is not a direct thermal-printer integration.
// CSS has no valid "80mm × auto" page size, so the compact page height is measured from the
// rendered receipt (+ margins) so the roll isn't fed a full A4/Letter-length page.
// Page margins are 0 so Chrome has no space to print its date/URL header and footer; the
// receipt has its own padding instead (index.css).
function pageCss(format: ReceiptFormat, receiptHeightMm: number): string {
  return format === 'a4'
    ? '@page { size: A4; margin: 0; }'
    : `@page { size: 80mm ${Math.ceil(receiptHeightMm + 2)}mm; margin: 0; }`;
}

/** Height of the (normally hidden) receipt in millimetres, measured off-screen. */
function measureReceiptMm(container: HTMLElement): number {
  const previous = container.style.cssText;
  container.style.cssText = 'display:block;position:absolute;left:-10000px;top:0;';
  const px = container.firstElementChild?.getBoundingClientRect().height ?? 0;
  container.style.cssText = previous;
  return (px * 25.4) / 96; // CSS px are 1/96 inch
}

interface PrinterValue {
  format: ReceiptFormat;
  setFormat: (f: ReceiptFormat) => void;
  /** Fetches the receipt from the server (never builds it from screen state) and prints it. */
  print: (orderId: number) => Promise<void>;
  /** Fetches the combined table receipt/bill and prints it. */
  printTable: (tableId: number) => Promise<void>;
  printing: boolean;
}

const PrinterContext = createContext<PrinterValue | null>(null);

export function useReceiptPrinter() {
  const ctx = useContext(PrinterContext);
  if (!ctx) throw new Error('useReceiptPrinter must be used inside <ReceiptPrinterProvider>');
  return ctx;
}

function loadFormat(): ReceiptFormat {
  try {
    return localStorage.getItem(FORMAT_KEY) === 'a4' ? 'a4' : 'compact';
  } catch {
    return 'compact';
  }
}

export function ReceiptPrinterProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [format, setFormatState] = useState<ReceiptFormat>(loadFormat);
  const [job, setJob] = useState<{ data: ReceiptData | import('../api/types').TableReceiptDTO; format: ReceiptFormat } | null>(null);
  const [printing, setPrinting] = useState(false);
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    // A container outside #root: on paper only this is shown (see index.css @media print).
    const el = document.createElement('div');
    el.id = 'print-root';
    document.body.appendChild(el);
    setTarget(el);
    return () => el.remove();
  }, []);

  const setFormat = useCallback((f: ReceiptFormat) => {
    setFormatState(f);
    try {
      localStorage.setItem(FORMAT_KEY, f);
    } catch {
      /* ignore */
    }
  }, []);

  const print = useCallback(
    async (orderId: number) => {
      setPrinting(true);
      try {
        let receiptData: ReceiptData;
        try {
          receiptData = await api.getReceipt(orderId);
        } catch (err) {
          if (err instanceof ApiError && err.code === 'BILL_REQUIRED') {
            await api.generateBill(orderId, { type: 'NONE' });
            receiptData = await api.getReceipt(orderId);
          } else {
            throw err;
          }
        }
        setJob({ data: receiptData, format });
      } catch (e) {
        setPrinting(false);
        toast({ tone: 'error', title: 'Could not print receipt', description: e instanceof ApiError ? e.message : undefined });
      }
    },
    [format, toast],
  );

  const printTable = useCallback(
    async (tableId: number) => {
      setPrinting(true);
      try {
        let tableData = await api.getTableReceipt(tableId);
        setJob({ data: tableData, format });
      } catch (e) {
        setPrinting(false);
        toast({ tone: 'error', title: 'Could not print table receipt', description: e instanceof ApiError ? e.message : undefined });
      }
    },
    [format, toast],
  );

  // Once the receipt is in the DOM, open the browser's print dialog.
  useEffect(() => {
    if (!job || !target) return;
    const style = document.createElement('style');
    style.id = 'receipt-page-size';
    style.textContent = pageCss(job.format, measureReceiptMm(target));
    document.head.appendChild(style);
    const done = () => {
      setJob(null);
      setPrinting(false);
    };
    window.addEventListener('afterprint', done, { once: true });
    const raf = requestAnimationFrame(() => window.print());
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('afterprint', done);
      style.remove();
    };
  }, [job, target]);

  return (
    <PrinterContext.Provider value={{ format, setFormat, print, printTable, printing }}>
      {children}
      {target && job && createPortal(<Receipt data={job.data} format={job.format} />, target)}
    </PrinterContext.Provider>
  );
}
