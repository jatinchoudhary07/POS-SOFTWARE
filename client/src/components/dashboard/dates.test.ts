import { describe, expect, it } from 'vitest';
import { hourWindow } from './dates';

describe('hourWindow (which hours the sales-by-hour chart shows)', () => {
  it('always shows the full trading day, 11am to 11pm, however the day went', () => {
    expect(hourWindow([])).toEqual({ lo: 11, hi: 23 }); // a day with no sales yet
    expect(hourWindow([11, 12, 13, 19])).toEqual({ lo: 11, hi: 23 }); // opened at 11
    expect(hourWindow([14, 15])).toEqual({ lo: 11, hi: 23 }); // first sale only at 2pm: the axis does not move
    expect(hourWindow([11])).toEqual({ lo: 11, hi: 23 }); // today, right after the first sale
  });

  it('stretches to include any sale outside those hours, so nothing is ever hidden', () => {
    expect(hourWindow([8, 11, 15])).toEqual({ lo: 8, hi: 23 }); // opened early at 8am
    expect(hourWindow([12, 18, 0])).toEqual({ lo: 0, hi: 23 }); // a sale just after midnight
    expect(hourWindow([9, 23])).toEqual({ lo: 9, hi: 23 });
  });

  it('puts every hour that has a sale inside the window, for any day', () => {
    for (let h = 0; h < 24; h++) {
      const { lo, hi } = hourWindow([h]);
      expect(lo).toBeLessThanOrEqual(h);
      expect(hi).toBeGreaterThanOrEqual(h);
    }
  });
});
