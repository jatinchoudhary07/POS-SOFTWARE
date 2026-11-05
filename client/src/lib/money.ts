const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });

/** 24050 -> "₹240.50". Only for display; all maths stays in integer paise. */
export function formatPaise(paise: number): string {
  return inr.format(paise / 100);
}
