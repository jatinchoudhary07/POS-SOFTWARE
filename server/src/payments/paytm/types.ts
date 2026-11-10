/**
 * The boundary between the POS and a Paytm wireless-ECR terminal service.
 *
 * STAGE 1: only the in-memory MockPaytmClient implements this. There is deliberately NO real client:
 * nothing here knows Paytm's checksum algorithm, hostnames or credentials, and nothing can reach the network.
 * A real client is a separate, approved piece of work (it must also supply a ChecksumSigner).
 *
 * The shapes follow Paytm's published Sale / Status Enquiry / Void APIs (amounts in paise, `merchantTransactionId`
 * 8-32 alphanumeric characters, resultStatus A = accepted, S = success, F = failed, U = pending).
 */

/** A request that did not complete: timeout, connection error, unreadable answer. The outcome is UNKNOWN, never "failed". */
export class PaytmTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaytmTransportError';
  }
}

export interface PaytmSaleRequest {
  merchantTransactionId: string;
  amountPaise: number;
  /** yyyy-MM-dd HH:mm:ss */
  transactionDateTime: string;
  /** Shown on the terminal, e.g. the bill number. */
  merchantReferenceNo?: string;
}

export type PaytmSaleResult =
  /** resultStatus A / 0009 ACCEPTED_SUCCESS: the terminal service took the request. This is NOT a payment. */
  | { kind: 'ACCEPTED' }
  /** resultStatus F: not accepted (see resultCodeId). */
  | { kind: 'REJECTED'; resultCodeId: string; resultMsg: string };

export interface PaytmStatusRequest {
  merchantTransactionId: string;
  transactionDateTime: string;
  /** 'VOID' asks about the void of this transaction instead of the sale. */
  event?: 'VOID';
}

export type PaytmStatusResult =
  | {
      kind: 'RESPONSE';
      /** A accepted, S success, F failed, U pending */
      resultStatus: 'A' | 'S' | 'F' | 'U';
      resultCodeId: string;
      resultMsg: string;
      // Echoed by the service; checked against what we sent before any money is believed.
      mid?: string;
      tid?: string;
      merchantTransactionId?: string;
      amountPaise?: number;
      acquirementId?: string;
      /** Bank retrieval reference number */
      rrn?: string;
      payMethod?: string;
    }
  /** 0404: no such transaction id */
  | { kind: 'NOT_FOUND' }
  /** The service answered but could not tell us (e.g. 0012 internal error): ask again later. */
  | { kind: 'ERROR'; resultCodeId?: string; resultMsg: string };

export interface PaytmVoidRequest {
  merchantTransactionId: string;
  transactionDateTime: string;
}

export type PaytmVoidResult = { kind: 'ACCEPTED' } | { kind: 'REJECTED'; resultCodeId: string; resultMsg: string };

/** All calls may throw PaytmTransportError. A client must never retry a Sale by itself. */
export interface PaytmClient {
  /** The merchant and terminal this client talks for (a request/response is checked against them). */
  readonly mid: string;
  readonly tid: string;
  sale(request: PaytmSaleRequest): Promise<PaytmSaleResult>;
  status(request: PaytmStatusRequest): Promise<PaytmStatusResult>;
  void(request: PaytmVoidRequest): Promise<PaytmVoidResult>;
}

/**
 * Signs and verifies request bodies. Stage 1 has NO implementation on purpose: Paytm's exact checksum method
 * (what is signed, with which key) is still unconfirmed, so it must not be guessed. The real client will take one.
 */
export interface ChecksumSigner {
  sign(body: string): string;
  verify(body: string, checksum: string): boolean;
}
