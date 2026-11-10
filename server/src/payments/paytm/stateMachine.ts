import type { PaytmAttemptState } from '../../db/schema';
import { CODE, describeFailure } from './codes';
import type { PaytmStatusResult } from './types';

/**
 * The decision made after one Status Enquiry. Pure (no database, no clock of its own), so every rule is unit-tested.
 *
 *   KEEP     keep waiting (pending on the device, or a status call that could not tell us yet)
 *   SUCCEED  the customer paid: ONLY from a status of S/0000 whose amount and ids all match ours
 *   FAIL     definitely no money taken
 *   UNKNOWN  cannot be sure: hand it to a person (and flag it for review if the answer contradicted us)
 */
export type Decision =
  | { type: 'KEEP'; transientError?: boolean }
  | { type: 'SUCCEED'; acquirementId: string | null; rrn: string | null; payMethod: string | null }
  | { type: 'FAIL'; reason: string }
  | { type: 'UNKNOWN'; reason: string; review: boolean };

export interface AttemptFacts {
  state: PaytmAttemptState;
  merchantTransactionId: string;
  mid: string;
  tid: string;
  amountPaise: number;
  saleSentAt: Date | null;
  deadlineAt: Date;
}

export interface DecideOptions {
  now: Date;
  /** After a Sale that was never acknowledged, "no such transaction" is only believed after this long. */
  notFoundGraceMs: number;
}

export function decideFromStatus(a: AttemptFacts, result: PaytmStatusResult, o: DecideOptions): Decision {
  const pastDeadline = o.now.getTime() >= a.deadlineAt.getTime();
  const timedOut: Decision = { type: 'UNKNOWN', reason: 'No final result from the terminal in time. Check the terminal and your Paytm records.', review: false };

  if (result.kind === 'ERROR') return pastDeadline ? timedOut : { type: 'KEEP', transientError: true };

  if (result.kind === 'NOT_FOUND') {
    // Never sent (crash before the request): nothing exists, so nothing was charged.
    if (a.saleSentAt === null) return { type: 'FAIL', reason: 'The payment was never sent to the terminal.' };
    const waited = o.now.getTime() - a.saleSentAt.getTime();
    if (a.state === 'ACCEPTED') {
      // The terminal service accepted it, and now denies knowing it: contradictory. A person must look.
      return { type: 'UNKNOWN', reason: 'The terminal service accepted this payment but now cannot find it. Check the terminal and your Paytm records.', review: true };
    }
    if (waited < o.notFoundGraceMs && !pastDeadline) return { type: 'KEEP' };
    return { type: 'UNKNOWN', reason: 'The request to the terminal got no answer and the service has no record of it. Check the terminal before trying again.', review: false };
  }

  // A real answer. It must be about OUR transaction on OUR terminal before any of it is believed.
  const idMismatch = result.merchantTransactionId !== undefined && result.merchantTransactionId !== a.merchantTransactionId;
  const midMismatch = result.mid !== undefined && result.mid !== a.mid;
  const tidMismatch = result.tid !== undefined && result.tid !== a.tid;
  const amountMismatch = result.amountPaise !== undefined && result.amountPaise !== a.amountPaise;
  if (idMismatch || midMismatch || tidMismatch || amountMismatch) {
    const what = [idMismatch && 'transaction id', midMismatch && 'merchant id', tidMismatch && 'terminal id', amountMismatch && 'amount'].filter(Boolean).join(', ');
    return { type: 'UNKNOWN', reason: `The terminal service's answer does not match this payment (${what}). It was NOT recorded as paid. Check the terminal and your Paytm records.`, review: true };
  }

  switch (result.resultStatus) {
    case 'S': {
      // Success must come with everything we check; missing fields are not enough to take money on trust.
      if (result.resultCodeId !== CODE.SUCCESS || result.merchantTransactionId === undefined || result.amountPaise === undefined || result.mid === undefined || result.tid === undefined) {
        return { type: 'UNKNOWN', reason: 'The terminal service reported success without the details needed to confirm it. It was NOT recorded as paid. Check your Paytm records.', review: true };
      }
      return { type: 'SUCCEED', acquirementId: result.acquirementId ?? null, rrn: result.rrn ?? null, payMethod: result.payMethod ?? null };
    }
    case 'F':
      return { type: 'FAIL', reason: describeFailure(result.resultCodeId, result.resultMsg) };
    case 'A':
    case 'U':
    default:
      // "Accepted" (0009) and "pending" (0010 / 0030) both mean: the customer has not finished. Never a payment.
      return pastDeadline ? timedOut : { type: 'KEEP' };
  }
}

/** Delay before the next status check: quick at first, then slower. */
export function nextPollDelayMs(pollCount: number, fastMs: number, slowMs: number): number {
  return pollCount < 8 ? fastMs : slowMs;
}
