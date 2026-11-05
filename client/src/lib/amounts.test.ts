import { describe, expect, it } from 'vitest';
import { formatBps, paiseToInput, parsePercentToBps, parseRupeesToPaise, quickCashAmounts } from './amounts';

describe('parseRupeesToPaise', () => {
  it.each([
    ['530', 53000],
    ['530.5', 53050],
    ['530.05', 53005],
    ['0.1', 10],
    ['1,200', 120000],
    ['₹ 75', 7500],
    ['  42.  ', 4200],
  ])('%s -> %i paise', (input, expected) => {
    expect(parseRupeesToPaise(input)).toBe(expected);
  });

  it.each(['', 'abc', '1.234', '-5', '1e3', '12.3.4', '99999999'])('rejects %s', (input) => {
    expect(parseRupeesToPaise(input)).toBeNull();
  });
});

describe('percent <-> basis points', () => {
  it('parses without floating point and round-trips', () => {
    expect(parsePercentToBps('2.5')).toBe(250);
    expect(parsePercentToBps('18')).toBe(1800);
    expect(parsePercentToBps('0.25%')).toBe(25);
    expect(parsePercentToBps('100')).toBe(10000);
    expect(parsePercentToBps('100.01')).toBeNull();
    expect(parsePercentToBps('2.555')).toBeNull();
    for (const bps of [0, 5, 25, 250, 500, 1200, 1800, 2800, 10000]) {
      expect(parsePercentToBps(formatBps(bps))).toBe(bps);
    }
    expect(formatBps(250)).toBe('2.5%');
    expect(formatBps(1800)).toBe('18%');
  });
});

describe('cash helpers', () => {
  it('formats paise for inputs', () => {
    expect(paiseToInput(53005)).toBe('530.05');
    expect(paiseToInput(0)).toBe('0.00');
  });

  it('suggests round amounts above the total', () => {
    expect(quickCashAmounts(63000)).toEqual([65000, 70000, 100000]); // ₹630 is already a multiple of ₹10
    expect(quickCashAmounts(66150)).toEqual([67000, 70000, 100000]);
    expect(quickCashAmounts(100000)).toEqual([200000]);
  });
});
