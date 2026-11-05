import type { PaymentMethod } from '../db/schema';

/**
 * Boundary for payment devices/services that report an outcome themselves (e.g. a card/UPI
 * terminal). NO provider is registered in this version: a genuine Paytm POS integration needs
 * the supported device model, the approved integration method and real credentials, none of
 * which exist yet. Cash and manually verified UPI do not use a provider — the cashier confirms.
 *
 * How a provider payment is processed (see billingService.startProviderPayment):
 *   1. A PENDING attempt is committed BEFORE talking to the device (so a crash can't lose it).
 *   2. collect() is awaited, with a timeout.
 *   3. The attempt becomes SUCCEEDED / FAILED, or UNKNOWN if the outcome is unclear
 *      (timeout, error, ambiguous response). UNKNOWN is never retried automatically; it blocks
 *      new attempts until a person checks the device/bank and resolves it.
 */
export type ProviderOutcome =
  | { outcome: 'SUCCEEDED'; reference?: string }
  | { outcome: 'FAILED'; reason: string; reference?: string }
  | { outcome: 'UNKNOWN'; reason: string; reference?: string };

export interface ProviderPaymentRequest {
  paymentId: number;
  /** Unique per attempt; pass it to the device so its own retries are de-duplicated. */
  idempotencyKey: string;
  orderNumber: string;
  amountPaise: number;
}

export interface PaymentProvider {
  /** Stored in payments.provider, e.g. 'PAYTM_POS'. */
  readonly id: string;
  readonly methods: readonly PaymentMethod[];
  collect(request: ProviderPaymentRequest): Promise<ProviderOutcome>;
}
