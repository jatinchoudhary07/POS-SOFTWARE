/**
 * What a result code from the terminal service means for us. Codes are those listed in Paytm's published
 * Sale / Status Enquiry / Void API pages. The one rule that matters: only a verified Status Enquiry success
 * ever pays a bill; every other code either keeps waiting, fails the attempt, or hands it to a person.
 */
export const CODE = {
  ACCEPTED: '0009',
  SUCCESS: '0000',
  PENDING_A: '0010',
  PENDING_B: '0030',
  SALE_FAILED: '0011',
  SYSTEM_ERROR: '0012',
  TERMINAL_INACTIVE: '0007',
  BUSY: '0333',
  DUPLICATE: '0233',
  BAD_CHECKSUM: '0330',
  BAD_PARAMS: '0002',
  NOT_FOUND: '0404',
  VOID_NOT_FOUND: '0180',
  VOID_BUSY: '0182',
} as const;

/** What to do after a Sale was rejected. */
export type SaleRejection =
  /** Nothing was created on the terminal: the attempt failed, the customer can try again. */
  | { action: 'FAIL'; message: string }
  /** We cannot tell whether something was created (duplicate id, internal error): ask the status instead of failing. */
  | { action: 'CHECK_STATUS'; message: string };

export function classifySaleRejection(codeId: string, resultMsg: string): SaleRejection {
  switch (codeId) {
    case CODE.DUPLICATE:
      return { action: 'CHECK_STATUS', message: 'The terminal service says this transaction already exists' };
    case CODE.SYSTEM_ERROR:
      return { action: 'CHECK_STATUS', message: 'The terminal service had an internal error' };
    case CODE.TERMINAL_INACTIVE:
      return { action: 'FAIL', message: 'The Paytm terminal is offline or not active. Check it and try again.' };
    case CODE.BUSY:
      return { action: 'FAIL', message: 'Another payment is already waiting on the terminal. Finish or cancel it there first.' };
    case CODE.BAD_CHECKSUM:
      return { action: 'FAIL', message: 'The terminal service rejected the request signature. This is a setup problem: ask the owner.' };
    case CODE.BAD_PARAMS:
      return { action: 'FAIL', message: 'The terminal service did not accept the request details. Ask the owner.' };
    default:
      return { action: 'FAIL', message: `The terminal service did not accept the payment (${codeId}${resultMsg ? `: ${resultMsg}` : ''})` };
  }
}

/** A hint for the cashier from a failed status result. */
export function describeFailure(codeId: string, resultMsg: string): string {
  if (codeId === CODE.SALE_FAILED) return 'The payment failed or was cancelled on the terminal. The customer was not charged.';
  return `The payment did not go through (${codeId}${resultMsg ? `: ${resultMsg}` : ''})`;
}
