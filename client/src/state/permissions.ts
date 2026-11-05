import type { Role } from '../api/types';
import type { View } from '../components/Header';

/**
 * Which screens each login may open. This only decides what the UI shows — the server
 * enforces the real permissions on every API request and socket connection.
 */
export const VIEWS_BY_ROLE: Record<Role, readonly View[]> = {
  SUPERADMIN: ['new', 'tables', 'orders', 'checkout', 'kitchen', 'sales', 'settings'],
  RECEPTION: ['new', 'tables', 'orders', 'checkout', 'sales'],
  KITCHEN: ['kitchen'],
};

/** Landing screen after login (and where a disallowed URL redirects to). */
export const LANDING: Record<Role, View> = { SUPERADMIN: 'tables', RECEPTION: 'tables', KITCHEN: 'kitchen' };
export const LANDING_PATH: Record<Role, string> = { SUPERADMIN: '/', RECEPTION: '/', KITCHEN: '/kitchen' };

export const canView = (role: Role, view: View) => VIEWS_BY_ROLE[role].includes(view);

export const ROLE_LABELS: Record<Role, string> = { SUPERADMIN: 'Superadmin', RECEPTION: 'Reception', KITCHEN: 'Kitchen' };

/** UI conveniences that mirror server rules (the server still checks them). */
export const can = {
  manageDiscounts: (role: Role) => role === 'SUPERADMIN',
  refundOrResolve: (role: Role) => role === 'SUPERADMIN',
  viewOtherDays: (role: Role) => role === 'SUPERADMIN',
  markServed: (role: Role) => role !== 'KITCHEN',
};
