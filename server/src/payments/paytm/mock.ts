import { CODE } from './codes';
import {
  PaytmTransportError,
  type PaytmClient,
  type PaytmSaleRequest,
  type PaytmSaleResult,
  type PaytmStatusRequest,
  type PaytmStatusResult,
  type PaytmVoidRequest,
  type PaytmVoidResult,
} from './types';

/**
 * What the pretend terminal does with the next payment. `afterPolls` = how many status checks answer "pending"
 * before the final answer arrives (default 2).
 */
export type MockScenario =
  | { kind: 'SUCCESS'; afterPolls?: number }
  /** The customer pressed cancel on the terminal. */
  | { kind: 'CUSTOMER_CANCEL'; afterPolls?: number }
  /** The bank declined the card/UPI. */
  | { kind: 'BANK_REJECT'; afterPolls?: number }
  /** Sale is refused: terminal offline / not active (0007). */
  | { kind: 'TERMINAL_OFFLINE' }
  /** The Sale request gets no answer. `thenCompletes`: the terminal DID receive it and the customer pays. */
  | { kind: 'SALE_TIMEOUT'; thenCompletes?: 'SUCCESS' | 'NEVER'; afterPolls?: number }
  /** Accepted, but no final result ever arrives. */
  | { kind: 'ACCEPTED_NO_RESULT' }
  /** Sale is refused as a duplicate transaction id (0233); `existing` is what status then says about it. */
  | { kind: 'DUPLICATE_ID'; existing?: 'SUCCESS' | 'NOT_FOUND' }
  /** Sale is refused: another payment is running on the terminal (0333). */
  | { kind: 'TERMINAL_BUSY' }
  /** Sale is refused: invalid checksum (0330). */
  | { kind: 'INVALID_CHECKSUM' }
  /** The final status says success but one field differs from the request. */
  | { kind: 'MISMATCH'; field: 'amount' | 'mid' | 'tid' | 'transactionId'; afterPolls?: number }
  /** The first `errors` status checks fail with an internal error (0012), then behave like `then`. */
  | { kind: 'STATUS_ERRORS'; errors: number; then: MockScenario };

export interface MockOptions {
  /** Default 'MOCKMID00000000000001'. Clearly not a real merchant id. */
  mid?: string;
  /** Default 'MOCKTID1'. Clearly not a real terminal id. */
  tid?: string;
  defaultScenario?: MockScenario;
  /** Sets the clock used to decide whether a void is still "same day". */
  now?: () => Date;
}

interface MockTxn {
  request: PaytmSaleRequest;
  scenario: MockScenario;
  /** The terminal actually has this transaction (false for e.g. a Sale that was refused). */
  exists: boolean;
  polls: number;
  /** final status delivered to the caller already */
  delivered: 'S' | 'F' | null;
  voided: boolean;
  saleDay: string;
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const TXN_ID = /^[A-Za-z0-9]{8,32}$/;

/**
 * A pretend Paytm terminal that lives in memory. It never touches the network and needs no credentials. It behaves like the
 * published API: one payment at a time per terminal (0333), unique transaction ids (0233), amounts in paise, same-day void only.
 */
export class MockPaytmClient implements PaytmClient {
  readonly mid: string;
  readonly tid: string;
  private readonly now: () => Date;
  private defaultScenario: MockScenario;
  private readonly queue: MockScenario[] = [];
  private readonly txns = new Map<string, MockTxn>();
  private voidRunning = false;

  /** Every call received, for tests to look at. */
  readonly calls = { sale: [] as PaytmSaleRequest[], status: [] as PaytmStatusRequest[], void: [] as PaytmVoidRequest[] };

  constructor(opts: MockOptions = {}) {
    this.mid = opts.mid ?? 'MOCKMID00000000000001';
    this.tid = opts.tid ?? 'MOCKTID1';
    this.now = opts.now ?? (() => new Date());
    this.defaultScenario = opts.defaultScenario ?? { kind: 'SUCCESS' };
  }

  /** The scenario for the next Sale (then it goes back to the default). */
  enqueue(...scenarios: MockScenario[]) {
    this.queue.push(...scenarios);
  }

  /** The scenario for every Sale that has none queued. */
  setDefault(s: MockScenario) {
    this.defaultScenario = s;
  }

  get scenario(): MockScenario {
    return this.defaultScenario;
  }

  /** How many payments are open on the pretend terminal right now. */
  get openCount(): number {
    return [...this.txns.values()].filter((t) => t.exists && t.delivered === null).length;
  }

  /** Test helper: the customer finishes on the device (what the next status check will say). */
  finishOnDevice(merchantTransactionId: string, result: 'SUCCESS' | 'FAIL') {
    const t = this.txns.get(merchantTransactionId);
    if (!t) throw new Error(`mock: unknown transaction ${merchantTransactionId}`);
    t.scenario = result === 'SUCCESS' ? { kind: 'SUCCESS', afterPolls: 0 } : { kind: 'BANK_REJECT', afterPolls: 0 };
    t.exists = true;
  }

  async sale(request: PaytmSaleRequest): Promise<PaytmSaleResult> {
    this.calls.sale.push(request);
    const scenario = this.queue.shift() ?? this.defaultScenario;

    if (!TXN_ID.test(request.merchantTransactionId)) return { kind: 'REJECTED', resultCodeId: CODE.BAD_PARAMS, resultMsg: 'Request Parameters are not valid' };
    if (this.txns.has(request.merchantTransactionId) && scenario.kind !== 'DUPLICATE_ID') {
      return { kind: 'REJECTED', resultCodeId: CODE.DUPLICATE, resultMsg: 'Duplicate Order Id' };
    }

    const remember = (exists: boolean, sc: MockScenario = scenario) =>
      this.txns.set(request.merchantTransactionId, { request, scenario: sc, exists, polls: 0, delivered: null, voided: false, saleDay: dayKey(this.now()) });

    switch (scenario.kind) {
      case 'TERMINAL_OFFLINE':
        return { kind: 'REJECTED', resultCodeId: CODE.TERMINAL_INACTIVE, resultMsg: 'Terminal is not in active state' };
      case 'INVALID_CHECKSUM':
        return { kind: 'REJECTED', resultCodeId: CODE.BAD_CHECKSUM, resultMsg: 'Invalid checksum' };
      case 'TERMINAL_BUSY':
        return { kind: 'REJECTED', resultCodeId: CODE.BUSY, resultMsg: 'Multiple payment request not allowed for same terminal' };
      case 'DUPLICATE_ID':
        // As if an earlier request with this id (which we never saw an answer to) already exists on the terminal.
        remember(scenario.existing !== 'NOT_FOUND', { kind: 'SUCCESS', afterPolls: 1 });
        return { kind: 'REJECTED', resultCodeId: CODE.DUPLICATE, resultMsg: 'Duplicate Order Id' };
      case 'SALE_TIMEOUT':
        if (scenario.thenCompletes) {
          // the terminal DID get the request even though we never heard back
          if (this.openCount > 0) return { kind: 'REJECTED', resultCodeId: CODE.BUSY, resultMsg: 'Multiple payment request not allowed for same terminal' };
          remember(true, scenario.thenCompletes === 'SUCCESS' ? { kind: 'SUCCESS', afterPolls: scenario.afterPolls } : { kind: 'ACCEPTED_NO_RESULT' });
        }
        throw new PaytmTransportError('The request to the terminal service timed out');
      default:
        break;
    }

    // The real terminal service allows one payment at a time per terminal.
    if (this.openCount > 0) return { kind: 'REJECTED', resultCodeId: CODE.BUSY, resultMsg: 'Multiple payment request not allowed for same terminal' };
    remember(true);
    return { kind: 'ACCEPTED' };
  }

  async status(request: PaytmStatusRequest): Promise<PaytmStatusResult> {
    this.calls.status.push(request);
    const t = this.txns.get(request.merchantTransactionId);
    if (!t || !t.exists) return { kind: 'NOT_FOUND' };

    if (request.event === 'VOID') {
      if (!t.voided) return { kind: 'RESPONSE', resultStatus: 'F', resultCodeId: CODE.VOID_NOT_FOUND, resultMsg: 'VOID transaction not found' };
      return { kind: 'RESPONSE', resultStatus: 'S', resultCodeId: CODE.SUCCESS, resultMsg: 'SUCCESS', ...this.echo(t) };
    }

    // a (possibly nested) scenario that first fails a few status checks
    let sc = t.scenario;
    while (sc.kind === 'STATUS_ERRORS') {
      if (t.polls < sc.errors) {
        t.polls++;
        return { kind: 'ERROR', resultCodeId: CODE.SYSTEM_ERROR, resultMsg: 'Internal Server Error. Please retry' };
      }
      sc = sc.then;
    }
    t.polls++;
    const need = 'afterPolls' in sc && sc.afterPolls !== undefined ? sc.afterPolls : 2;
    const pending: PaytmStatusResult = { kind: 'RESPONSE', resultStatus: 'U', resultCodeId: CODE.PENDING_A, resultMsg: 'Please check status on machine', ...this.echo(t) };

    switch (sc.kind) {
      case 'ACCEPTED_NO_RESULT':
        return pending;
      case 'SUCCESS':
      case 'MISMATCH': {
        if (t.polls < need) return pending;
        t.delivered = 'S';
        const ok: PaytmStatusResult = { kind: 'RESPONSE', resultStatus: 'S', resultCodeId: CODE.SUCCESS, resultMsg: 'SUCCESS', ...this.echo(t), acquirementId: `ACQ${t.request.merchantTransactionId}`, rrn: `RRN${t.request.merchantTransactionId.slice(-8)}`, payMethod: 'UPI' };
        if (sc.kind === 'MISMATCH' && ok.kind === 'RESPONSE') {
          if (sc.field === 'amount') ok.amountPaise = t.request.amountPaise + 100;
          if (sc.field === 'mid') ok.mid = 'SOMEOTHERMERCHANT0001';
          if (sc.field === 'tid') ok.tid = 'OTHERTID';
          if (sc.field === 'transactionId') ok.merchantTransactionId = 'DIFFERENT0000TXNID';
        }
        return ok;
      }
      case 'CUSTOMER_CANCEL':
      case 'BANK_REJECT':
        if (t.polls < need) return pending;
        t.delivered = 'F';
        return { kind: 'RESPONSE', resultStatus: 'F', resultCodeId: CODE.SALE_FAILED, resultMsg: sc.kind === 'CUSTOMER_CANCEL' ? 'The sale txn has failed (cancelled on terminal)' : 'The sale txn has failed (declined by bank)', ...this.echo(t) };
      default:
        return pending;
    }
  }

  async void(request: PaytmVoidRequest): Promise<PaytmVoidResult> {
    this.calls.void.push(request);
    const t = this.txns.get(request.merchantTransactionId);
    if (!t || t.delivered !== 'S') return { kind: 'REJECTED', resultCodeId: CODE.VOID_NOT_FOUND, resultMsg: 'VOID transaction not found' };
    if (this.voidRunning) return { kind: 'REJECTED', resultCodeId: CODE.VOID_BUSY, resultMsg: 'Multiple Void request not allowed for same terminal' };
    // a void is only possible on the day of the sale
    if (t.saleDay !== dayKey(this.now())) return { kind: 'REJECTED', resultCodeId: CODE.VOID_NOT_FOUND, resultMsg: 'A void is only possible on the day of the sale' };
    t.voided = true;
    return { kind: 'ACCEPTED' };
  }

  private echo(t: MockTxn) {
    return { mid: this.mid, tid: this.tid, merchantTransactionId: t.request.merchantTransactionId, amountPaise: t.request.amountPaise };
  }
}
