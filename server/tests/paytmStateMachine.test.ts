import { describe, expect, it } from 'vitest';
import { classifySaleRejection } from '../src/payments/paytm/codes';
import { MockPaytmClient } from '../src/payments/paytm/mock';
import { buildPaytmOptions, type PaytmEnvConfig } from '../src/payments/paytm/setup';
import { decideFromStatus, nextPollDelayMs, type AttemptFacts } from '../src/payments/paytm/stateMachine';
import type { PaytmStatusResult } from '../src/payments/paytm/types';

const t0 = new Date('2026-11-10T10:00:00Z');
const at = (ms: number) => new Date(t0.getTime() + ms);
const facts = (over: Partial<AttemptFacts> = {}): AttemptFacts => ({
  state: 'ACCEPTED',
  merchantTransactionId: 'MOCK00000001ABCDEF',
  mid: 'MID1',
  tid: 'TID1',
  amountPaise: 63000,
  saleSentAt: t0,
  deadlineAt: at(600_000),
  ...over,
});
const answer = (over: Partial<Extract<PaytmStatusResult, { kind: 'RESPONSE' }>> = {}): PaytmStatusResult => ({
  kind: 'RESPONSE',
  resultStatus: 'S',
  resultCodeId: '0000',
  resultMsg: 'SUCCESS',
  mid: 'MID1',
  tid: 'TID1',
  merchantTransactionId: 'MOCK00000001ABCDEF',
  amountPaise: 63000,
  acquirementId: 'ACQ1',
  rrn: 'RRN1',
  payMethod: 'UPI',
  ...over,
});
const o = (ms = 1000) => ({ now: at(ms), notFoundGraceMs: 60_000 });

describe('deciding what a status answer means', () => {
  it('pays ONLY for a success whose amount and ids all match', () => {
    expect(decideFromStatus(facts(), answer(), o())).toEqual({ type: 'SUCCEED', acquirementId: 'ACQ1', rrn: 'RRN1', payMethod: 'UPI' });
  });

  it('never pays on "accepted" or "pending" (the customer has not finished)', () => {
    expect(decideFromStatus(facts(), answer({ resultStatus: 'A', resultCodeId: '0009', resultMsg: 'ACCEPTED_SUCCESS' }), o())).toEqual({ type: 'KEEP' });
    expect(decideFromStatus(facts(), answer({ resultStatus: 'U', resultCodeId: '0010', resultMsg: 'Please check status on machine' }), o())).toEqual({ type: 'KEEP' });
    expect(decideFromStatus(facts(), answer({ resultStatus: 'U', resultCodeId: '0030' }), o())).toEqual({ type: 'KEEP' });
  });

  it('keeps waiting while pending, but past the deadline it becomes unknown (never "failed")', () => {
    const pending = answer({ resultStatus: 'U', resultCodeId: '0010' });
    expect(decideFromStatus(facts(), pending, { now: at(599_999), notFoundGraceMs: 60_000 })).toEqual({ type: 'KEEP' });
    expect(decideFromStatus(facts(), pending, { now: at(600_000), notFoundGraceMs: 60_000 })).toMatchObject({ type: 'UNKNOWN', review: false });
  });

  it('fails only on a definite failure answer', () => {
    expect(decideFromStatus(facts(), answer({ resultStatus: 'F', resultCodeId: '0011', resultMsg: 'The sale txn has failed' }), o())).toMatchObject({ type: 'FAIL', reason: expect.stringContaining('not charged') });
  });

  it.each([
    ['amount', { amountPaise: 63100 }],
    ['merchant id', { mid: 'OTHER' }],
    ['terminal id', { tid: 'OTHER' }],
    ['transaction id', { merchantTransactionId: 'SOMEONEELSE00001' }],
  ])('refuses to believe a success whose %s differs, and flags it for review', (_n, over) => {
    expect(decideFromStatus(facts(), answer(over), o())).toMatchObject({ type: 'UNKNOWN', review: true });
    // even a "failed" answer about someone else's transaction is not applied to ours
    expect(decideFromStatus(facts(), answer({ ...over, resultStatus: 'F', resultCodeId: '0011' }), o())).toMatchObject({ type: 'UNKNOWN', review: true });
  });

  it('does not take a success on trust when the confirming details are missing', () => {
    for (const missing of ['merchantTransactionId', 'amountPaise', 'mid', 'tid'] as const) {
      expect(decideFromStatus(facts(), answer({ [missing]: undefined }), o())).toMatchObject({ type: 'UNKNOWN', review: true });
    }
    expect(decideFromStatus(facts(), answer({ resultCodeId: '0010' }), o())).toMatchObject({ type: 'UNKNOWN', review: true }); // "S" with the wrong code
  });

  it('treats a status call that could not tell us as "ask again", until the deadline', () => {
    const err: PaytmStatusResult = { kind: 'ERROR', resultCodeId: '0012', resultMsg: 'Internal Server Error. Please retry' };
    expect(decideFromStatus(facts(), err, o())).toEqual({ type: 'KEEP', transientError: true });
    expect(decideFromStatus(facts(), err, { now: at(700_000), notFoundGraceMs: 60_000 })).toMatchObject({ type: 'UNKNOWN' });
  });

  it('handles "no such transaction" carefully', () => {
    const nf: PaytmStatusResult = { kind: 'NOT_FOUND' };
    // it never reached the terminal service: nothing exists, nothing was charged
    expect(decideFromStatus(facts({ state: 'SENDING', saleSentAt: null }), nf, o())).toMatchObject({ type: 'FAIL' });
    // sent, no answer yet: it may still appear, so wait out the grace period, then hand over to a person
    expect(decideFromStatus(facts({ state: 'SENDING' }), nf, o(30_000))).toEqual({ type: 'KEEP' });
    expect(decideFromStatus(facts({ state: 'SENDING' }), nf, o(61_000))).toMatchObject({ type: 'UNKNOWN', review: false });
    // the service accepted it and now denies it: contradictory, so a person must look
    expect(decideFromStatus(facts({ state: 'ACCEPTED' }), nf, o())).toMatchObject({ type: 'UNKNOWN', review: true });
  });

  it('polls quickly at first, then more slowly', () => {
    expect(nextPollDelayMs(0, 3000, 10000)).toBe(3000);
    expect(nextPollDelayMs(7, 3000, 10000)).toBe(3000);
    expect(nextPollDelayMs(8, 3000, 10000)).toBe(10000);
  });
});

describe('what a refused Sale means', () => {
  it('fails definite refusals, and checks status when it cannot tell whether something exists', () => {
    expect(classifySaleRejection('0007', '').action).toBe('FAIL'); // terminal offline
    expect(classifySaleRejection('0333', '').action).toBe('FAIL'); // another payment on the terminal
    expect(classifySaleRejection('0330', '').action).toBe('FAIL'); // invalid checksum
    expect(classifySaleRejection('0002', '').action).toBe('FAIL');
    expect(classifySaleRejection('0233', '').action).toBe('CHECK_STATUS'); // duplicate id: an earlier request may exist
    expect(classifySaleRejection('0012', '').action).toBe('CHECK_STATUS'); // internal error: unclear
    expect(classifySaleRejection('9999', 'odd').action).toBe('FAIL');
  });
});

describe('the practice terminal (mock) behaves like the published API', () => {
  const sale = (id = 'MOCK00000001ABCDEF', amountPaise = 1000) => ({ merchantTransactionId: id, amountPaise, transactionDateTime: '2026-11-10 10:00:00' });

  it('needs no credentials, uses clearly fake ids, and never touches the network', () => {
    const m = new MockPaytmClient();
    expect(m.mid).toMatch(/^MOCK/);
    expect(m.tid).toMatch(/^MOCK/);
  });

  it('refuses a transaction id that Paytm would refuse', async () => {
    const m = new MockPaytmClient();
    for (const bad of ['short', 'has-dash-in-it-12345', 'x'.repeat(33)]) {
      expect(await m.sale(sale(bad))).toMatchObject({ kind: 'REJECTED', resultCodeId: '0002' });
    }
  });

  it('allows one open payment per terminal, and unique transaction ids', async () => {
    const m = new MockPaytmClient({ defaultScenario: { kind: 'ACCEPTED_NO_RESULT' } });
    expect(await m.sale(sale('MOCK00000001AAAAAA'))).toEqual({ kind: 'ACCEPTED' });
    expect(await m.sale(sale('MOCK00000002BBBBBB'))).toMatchObject({ kind: 'REJECTED', resultCodeId: '0333' });
    expect(await m.sale(sale('MOCK00000001AAAAAA'))).toMatchObject({ kind: 'REJECTED', resultCodeId: '0233' });
  });

  it('answers pending until the scripted number of checks, then the final result', async () => {
    const m = new MockPaytmClient({ defaultScenario: { kind: 'SUCCESS', afterPolls: 3 } });
    await m.sale(sale());
    const q = { merchantTransactionId: 'MOCK00000001ABCDEF', transactionDateTime: '2026-11-10 10:00:00' };
    expect(await m.status(q)).toMatchObject({ kind: 'RESPONSE', resultStatus: 'U' });
    expect(await m.status(q)).toMatchObject({ kind: 'RESPONSE', resultStatus: 'U' });
    expect(await m.status(q)).toMatchObject({ kind: 'RESPONSE', resultStatus: 'S', amountPaise: 1000, mid: m.mid, tid: m.tid });
    expect(await m.status(q)).toMatchObject({ resultStatus: 'S' }); // asking again keeps saying success
  });

  it('only voids a successful sale, on the day of the sale', async () => {
    let clock = new Date('2026-11-10T10:00:00');
    const m = new MockPaytmClient({ defaultScenario: { kind: 'SUCCESS', afterPolls: 1 }, now: () => clock });
    const v = { merchantTransactionId: 'MOCK00000001ABCDEF', transactionDateTime: '2026-11-10 10:00:00' };
    await m.sale(sale());
    expect(await m.void(v)).toMatchObject({ kind: 'REJECTED', resultCodeId: '0180' }); // not paid yet
    await m.status(v);
    clock = new Date('2026-11-11T10:00:00');
    expect(await m.void(v)).toMatchObject({ kind: 'REJECTED' }); // next day
    clock = new Date('2026-11-10T18:00:00');
    expect(await m.void(v)).toEqual({ kind: 'ACCEPTED' });
    expect(await m.status({ ...v, event: 'VOID' })).toMatchObject({ resultStatus: 'S' });
  });
});

describe('startup rules for terminal payments', () => {
  const cfg = (over: Partial<PaytmEnvConfig> = {}): PaytmEnvConfig => ({ enabled: false, mode: 'mock', mockScenario: 'SUCCESS', pollFastMs: 3000, pollSlowMs: 10000, maxWaitMinutes: 10, saleTimeoutMs: 15000, ...over });

  it('is OFF unless switched on', () => {
    expect(buildPaytmOptions(cfg(), 'development')).toBeUndefined();
    expect(buildPaytmOptions(cfg({ mode: 'live' }), 'production')).toBeUndefined(); // off wins, whatever else is set
  });

  it('refuses the live mode, which does not exist yet', () => {
    expect(() => buildPaytmOptions(cfg({ enabled: true, mode: 'live' }), 'development')).toThrow(/not available yet/);
    expect(() => buildPaytmOptions(cfg({ enabled: true, mode: 'live' }), 'production')).toThrow(/not available yet/);
  });

  it('refuses the practice terminal in production, so pretend money can never be taken for real', () => {
    expect(() => buildPaytmOptions(cfg({ enabled: true }), 'production')).toThrow(/cannot run in production/);
  });

  it('builds the practice terminal for development and tests, marked as a mock', () => {
    const built = buildPaytmOptions(cfg({ enabled: true }), 'development')!;
    expect(built).toMatchObject({ providerId: 'PAYTM_MOCK', txnPrefix: 'MOCK', mode: 'mock', maxWaitMs: 600_000 });
    expect(built.client).toBeInstanceOf(MockPaytmClient);
  });
});
