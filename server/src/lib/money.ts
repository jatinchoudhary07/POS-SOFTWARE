/** Money helpers. All amounts are integer paise (₹1 = 100 paise). */

export const MAX_QUANTITY_PER_LINE = 99;

export function lineTotalPaise(unitPricePaise: number, quantity: number): number {
  if (!Number.isSafeInteger(unitPricePaise) || unitPricePaise < 0) {
    throw new RangeError(`Invalid unit price: ${unitPricePaise}`);
  }
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new RangeError(`Invalid quantity: ${quantity}`);
  }
  return unitPricePaise * quantity;
}

export function subtotalPaise(lines: { unitPricePaise: number; quantity: number }[]): number {
  return lines.reduce((sum, l) => sum + lineTotalPaise(l.unitPricePaise, l.quantity), 0);
}
