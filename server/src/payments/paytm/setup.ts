import { MockPaytmClient, type MockScenario } from './mock';
import type { PaytmOptions } from './service';

/** The practice-terminal behaviours that can be chosen by name (environment variable or the Superadmin's picker). */
export const MOCK_SCENARIO_KINDS = [
  'SUCCESS',
  'CUSTOMER_CANCEL',
  'BANK_REJECT',
  'TERMINAL_OFFLINE',
  'SALE_TIMEOUT',
  'ACCEPTED_NO_RESULT',
  'DUPLICATE_ID',
  'TERMINAL_BUSY',
  'INVALID_CHECKSUM',
  'MISMATCH_AMOUNT',
  'MISMATCH_MID',
  'MISMATCH_TID',
] as const;
export type MockScenarioName = (typeof MOCK_SCENARIO_KINDS)[number];

export function scenarioFromName(name: MockScenarioName, afterPolls = 2): MockScenario {
  switch (name) {
    case 'SUCCESS':
    case 'CUSTOMER_CANCEL':
    case 'BANK_REJECT':
      return { kind: name, afterPolls };
    case 'SALE_TIMEOUT':
      return { kind: 'SALE_TIMEOUT', thenCompletes: 'SUCCESS', afterPolls };
    case 'DUPLICATE_ID':
      return { kind: 'DUPLICATE_ID', existing: 'SUCCESS' };
    case 'MISMATCH_AMOUNT':
      return { kind: 'MISMATCH', field: 'amount', afterPolls };
    case 'MISMATCH_MID':
      return { kind: 'MISMATCH', field: 'mid', afterPolls };
    case 'MISMATCH_TID':
      return { kind: 'MISMATCH', field: 'tid', afterPolls };
    default:
      return { kind: name };
  }
}

export interface PaytmEnvConfig {
  enabled: boolean;
  mode: 'mock' | 'live';
  mockScenario: MockScenarioName;
  pollFastMs: number;
  pollSlowMs: number;
  maxWaitMinutes: number;
  saleTimeoutMs: number;
}

/**
 * Decides, at startup, whether terminal payments exist at all.
 *
 *  - Off (the default): nothing is built; the checkout screens never show a terminal option.
 *  - PAYTM_MODE=mock: the built-in practice terminal. Refused in production, so pretend money can never be taken for real.
 *  - PAYTM_MODE=live: NOT AVAILABLE in Stage 1. There is no real client, so this refuses to start instead of pretending.
 */
export function buildPaytmOptions(cfg: PaytmEnvConfig, nodeEnv: string): PaytmOptions | undefined {
  if (!cfg.enabled) return undefined;
  if (cfg.mode === 'live') {
    throw new Error('PAYTM_MODE=live is not available yet: the real Paytm connection has not been built or approved. Use PAYTM_MODE=mock to practise, or set PAYTM_ENABLED=false.');
  }
  if (nodeEnv === 'production') {
    throw new Error('PAYTM_MODE=mock is a practice terminal and cannot run in production. Set PAYTM_ENABLED=false.');
  }
  return {
    client: new MockPaytmClient({ defaultScenario: scenarioFromName(cfg.mockScenario) }),
    providerId: 'PAYTM_MOCK',
    txnPrefix: 'MOCK',
    mode: 'mock',
    pollFastMs: cfg.pollFastMs,
    pollSlowMs: cfg.pollSlowMs,
    maxWaitMs: cfg.maxWaitMinutes * 60_000,
    saleTimeoutMs: cfg.saleTimeoutMs,
  };
}
