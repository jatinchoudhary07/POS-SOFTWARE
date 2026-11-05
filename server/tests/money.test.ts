import { describe, expect, it } from 'vitest';
import { lineTotalPaise, subtotalPaise } from '../src/lib/money';
import { formatOrderNumber, parseSequence } from '../src/lib/orderNumber';

describe('money', () => {
  it('multiplies unit price by quantity in integer paise', () => {
    expect(lineTotalPaise(24000, 3)).toBe(72000);
  });

  it('avoids floating-point errors (₹0.10 + ₹0.20 = ₹0.30 exactly)', () => {
    expect(subtotalPaise([
      { unitPricePaise: 10, quantity: 1 },
      { unitPricePaise: 20, quantity: 1 },
    ])).toBe(30);
  });

  it('rejects invalid quantities and prices', () => {
    expect(() => lineTotalPaise(100, 0)).toThrow();
    expect(() => lineTotalPaise(100, 1.5)).toThrow();
    expect(() => lineTotalPaise(-1, 1)).toThrow();
  });
});

describe('order numbers', () => {
  it('formats as YYMMDD-NNN using the local date', () => {
    expect(formatOrderNumber(new Date(2026, 9, 21, 12), 7)).toBe('261021-007');
    expect(formatOrderNumber(new Date(2026, 0, 5, 9), 123)).toBe('260105-123');
  });

  it('parses the daily sequence back', () => {
    expect(parseSequence('261021-007')).toBe(7);
    expect(parseSequence('261021-1000')).toBe(1000);
  });
});
