import { describe, expect, it } from 'vitest';
import { hourWindow } from './dates';

describe('hourWindow (which hours the sales-by-hour chart shows)', () => {
  it('starts at the first hour with a sale, not at a fixed earlier hour', () => {
    expect(hourWindow([11, 12, 13, 19]).lo).toBe(11); // a cafe that opened at 11 shows 11, not 9 or 10
    expect(hourWindow([9, 15]).lo).toBe(9); // and an early one still shows its early hour
  });

  it('ends at the last hour with a sale, and never looks cramped', () => {
    expect(hourWindow([11, 12, 21]).hi).toBe(21);
    expect(hourWindow([11]).hi).toBe(17); // one sale: still a few bars to read
    expect(hourWindow([22, 23])).toEqual({ lo: 22, hi: 23 }); // never past midnight
  });

  it('shows a normal trading day when there were no sales', () => {
    expect(hourWindow([])).toEqual({ lo: 10, hi: 20 });
  });
});
