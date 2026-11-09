import type { Receipt as ReceiptData, TableReceiptDTO } from '../api/types';
import { formatBps } from '../lib/amounts';
import { formatPaise } from '../lib/money';
import { METHOD_LABELS } from './ui/PaymentBadge';

export type ReceiptFormat = 'compact' | 'a4';

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * Printable receipt. Uses plain classes styled in index.css ("Receipt print styles") so it
 * prints in black on white regardless of the app theme. Works for an unpaid bill too, which
 * is clearly marked "NOT PAID" so it can't be mistaken for a receipt.
 */
export function Receipt({ data, format }: { data: ReceiptData | TableReceiptDTO; format: ReceiptFormat }) {
  const { restaurant: r, bill, payment, paymentStatus } = data;
  const isPaid = paymentStatus === 'PAID';
  const stamp = paymentStatus === 'REFUNDED' ? 'REFUNDED' : null;

  const isTableReceipt = 'table' in data;
  const table = isTableReceipt ? data.table : null;
  const order = !isTableReceipt ? data.order : null;
  const tableOrders = isTableReceipt ? data.orders : [];

  // Flatten items for table receipt or order receipt
  const items = isTableReceipt
    ? tableOrders.flatMap((o) => o.items)
    : (order?.items ?? []);

  const titleText = isPaid ? 'RECEIPT' : paymentStatus === 'REFUNDED' ? 'REFUND RECEIPT' : 'BILL';
  const labelAria = isTableReceipt ? `Receipt for Table ${table?.name}` : `Receipt for order ${order?.orderNumber}`;

  return (
    <article className={`receipt receipt-${format}`} aria-label={labelAria}>
      <header className="receipt-head">
        <h1>{r.restaurantName}</h1>
        {r.addressLine && <p>{r.addressLine}</p>}
        {r.phone && <p>Phone: {r.phone}</p>}
        {r.taxId && <p>Tax ID: {r.taxId}</p>}
      </header>

      <p className="receipt-title">{titleText}</p>
      {stamp && <p className="receipt-stamp">{stamp}</p>}

      <dl className="receipt-meta">
        {order ? (
          <div>
            <dt>Order</dt>
            <dd>#{order.orderNumber}</dd>
          </div>
        ) : (
          <div>
            <dt>Table</dt>
            <dd>{table?.name} ({tableOrders.length} order{tableOrders.length > 1 ? 's' : ''})</dd>
          </div>
        )}
        <div>
          <dt>Date</dt>
          <dd>{dateTime(order?.createdAt ?? data.generatedAt)}</dd>
        </div>
        {(() => {
          const who = order ?? tableOrders.find((o) => o.customerName || o.customerPhone);
          return who && (who.customerName || who.customerPhone) ? (
            <div>
              <dt>Customer</dt>
              <dd>{[who.customerName, who.customerPhone].filter(Boolean).join(' · ')}</dd>
            </div>
          ) : null;
        })()}
        <div>
          <dt>Type</dt>
          <dd>
            {order ? (order.orderType === 'DINE_IN' ? 'Dine-in' : 'Takeaway') : 'Dine-in'}
            {order?.tableNumber ? ` · Table ${order.tableNumber}` : table ? ` · Table ${table.name}` : ''}
          </dd>
        </div>
      </dl>

      <table className="receipt-items">
        <thead>
          <tr>
            <th>Item</th>
            <th className="num">Qty</th>
            <th className="num">Rate</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i, idx) => (
            <tr key={`${i.id}-${idx}`}>
              <td>{i.itemName}{i.packed ? ' (Pack)' : ''}</td>
              <td className="num">{i.quantity}</td>
              <td className="num">{formatPaise(i.unitPricePaise)}</td>
              <td className="num">{formatPaise(i.lineTotalPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <table className="receipt-totals">
        <tbody>
          <tr>
            <td>Subtotal</td>
            <td className="num">{formatPaise(bill.subtotalPaise)}</td>
          </tr>
          {bill.discount.paise > 0 && (
            <tr>
              <td>
                Discount{bill.discount.type === 'PERCENT' ? ` (${formatBps(bill.discount.value)})` : ''}
                {bill.discount.reason ? ` — ${bill.discount.reason}` : ''}
              </td>
              <td className="num">−{formatPaise(bill.discount.paise)}</td>
            </tr>
          )}
          {bill.taxLines.map((t) => (
            <tr key={t.name}>
              <td>
                {t.name} {formatBps(t.rateBps)}
              </td>
              <td className="num">{formatPaise(t.amountPaise)}</td>
            </tr>
          ))}
          {bill.roundOffPaise !== 0 && (
            <tr>
              <td>Round off</td>
              <td className="num">
                {bill.roundOffPaise > 0 ? '+' : '−'}
                {formatPaise(Math.abs(bill.roundOffPaise))}
              </td>
            </tr>
          )}
          <tr className="receipt-grand">
            <td>Total</td>
            <td className="num">{formatPaise(bill.totalPaise)}</td>
          </tr>
        </tbody>
      </table>

      {payment && (
        <dl className="receipt-meta receipt-payment">
          <div>
            <dt>Payment</dt>
            <dd>
              {payment.method === 'CREDIT' ? 'On credit · To be paid later' : `${METHOD_LABELS[payment.method]} · ${payment.status === 'REFUNDED' ? 'Refunded' : 'Paid'}`}
            </dd>
          </div>
          {payment.tenderedPaise !== null && (
            <div>
              <dt>Cash received</dt>
              <dd>{formatPaise(payment.tenderedPaise)}</dd>
            </div>
          )}
          {payment.changePaise !== null && payment.changePaise > 0 && (
            <div>
              <dt>Change</dt>
              <dd>{formatPaise(payment.changePaise)}</dd>
            </div>
          )}
          <div>
            <dt>Reference</dt>
            <dd>{payment.reference}</dd>
          </div>
          {payment.providerReference && (
            <div>
              <dt>{payment.method === 'UPI_MANUAL' ? 'UPI ref' : 'Txn ref'}</dt>
              <dd>{payment.providerReference}</dd>
            </div>
          )}
          {payment.completedAt && (
            <div>
              <dt>{payment.method === 'CREDIT' ? 'Put on credit' : 'Paid at'}</dt>
              <dd>{dateTime(payment.completedAt)}</dd>
            </div>
          )}
          {payment.refundedAt && (
            <div>
              <dt>Refunded</dt>
              <dd>{dateTime(payment.refundedAt)}</dd>
            </div>
          )}
        </dl>
      )}

      {r.receiptFooter && <p className="receipt-footer">{r.receiptFooter}</p>}
      <p className="receipt-printed">Printed {dateTime(data.generatedAt)}</p>
    </article>
  );
}
