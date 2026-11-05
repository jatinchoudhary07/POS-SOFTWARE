import { EventEmitter } from 'node:events';
import type { OrderDTO } from './services/orderService';

/**
 * A tiny in-process event bus. Services publish "something happened" events here
 * without knowing who listens; src/realtime.ts forwards them to browsers via Socket.IO.
 * Events are only emitted after the database transaction has committed, exactly once
 * per real change (duplicate submissions and repeated status requests emit nothing).
 */
export interface DomainEvents {
  'order.created': [order: OrderDTO];
  /** `kitchen: false` = a billing/payment change the kitchen doesn't need to hear about. */
  'order.updated': [order: OrderDTO, meta?: { kitchen: boolean }];
  /**
   * Sessions were ended (logout, credential change). Realtime disconnects affected sockets:
   * all of the user's sockets except `keepSessionId`, or only `onlySessionId`.
   */
  'auth.revoked': [info: { userId: number; keepSessionId?: string; onlySessionId?: string }];
}

export class EventBus extends EventEmitter<DomainEvents> {}
