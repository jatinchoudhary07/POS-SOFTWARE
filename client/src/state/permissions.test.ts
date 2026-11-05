import { describe, expect, it } from 'vitest';
import { can, canView, LANDING, LANDING_PATH, VIEWS_BY_ROLE } from './permissions';

describe('screen permissions', () => {
  it('kitchen can only open the kitchen display', () => {
    expect(VIEWS_BY_ROLE.KITCHEN).toEqual(['kitchen']);
    for (const v of ['new', 'orders', 'checkout', 'sales', 'settings'] as const) expect(canView('KITCHEN', v)).toBe(false);
    expect(LANDING.KITCHEN).toBe('kitchen');
    expect(LANDING_PATH.KITCHEN).toBe('/kitchen');
  });

  it('reception gets the POS, orders, checkout and sales, but not settings or the kitchen screen', () => {
    for (const v of ['new', 'orders', 'checkout', 'sales'] as const) expect(canView('RECEPTION', v)).toBe(true);
    expect(canView('RECEPTION', 'settings')).toBe(false);
    expect(canView('RECEPTION', 'kitchen')).toBe(false);
    expect(LANDING.RECEPTION).toBe('tables');
    expect(can.manageDiscounts('RECEPTION')).toBe(false);
    expect(can.refundOrResolve('RECEPTION')).toBe(false);
  });

  it('superadmin can open everything', () => {
    for (const v of ['new', 'orders', 'checkout', 'kitchen', 'sales', 'settings'] as const) expect(canView('SUPERADMIN', v)).toBe(true);
    expect(can.manageDiscounts('SUPERADMIN') && can.refundOrResolve('SUPERADMIN') && can.viewOtherDays('SUPERADMIN')).toBe(true);
  });
});
