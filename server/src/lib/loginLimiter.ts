/**
 * Slows down password guessing. Failures are counted per client IP and per username; after
 * MAX_FAILURES within WINDOW_MS that key is blocked for LOCK_MS. A successful login clears the
 * username's counter. Kept in memory: a server restart clears it (documented). Unknown usernames
 * are counted exactly like real ones.
 */
export interface LimiterOptions {
  maxFailures?: number;
  windowMs?: number;
  lockMs?: number;
  now?: () => number;
}

interface Entry {
  failures: number[];
  lockedUntil: number;
}

export class LoginLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly lockMs: number;
  private readonly now: () => number;

  constructor(opts: LimiterOptions = {}) {
    this.maxFailures = opts.maxFailures ?? 5;
    this.windowMs = opts.windowMs ?? 15 * 60_000;
    this.lockMs = opts.lockMs ?? 15 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** Milliseconds until any of the keys may try again (0 = allowed). */
  retryAfterMs(keys: string[]): number {
    const t = this.now();
    return Math.max(0, ...keys.map((k) => (this.entries.get(k)?.lockedUntil ?? 0) - t));
  }

  recordFailure(keys: string[]): void {
    const t = this.now();
    for (const k of keys) {
      const e = this.entries.get(k) ?? { failures: [], lockedUntil: 0 };
      e.failures = e.failures.filter((f) => t - f < this.windowMs);
      e.failures.push(t);
      if (e.failures.length >= this.maxFailures) {
        e.lockedUntil = t + this.lockMs;
        e.failures = [];
      }
      this.entries.set(k, e);
    }
    if (this.entries.size > 10_000) this.prune();
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  private prune() {
    const t = this.now();
    for (const [k, e] of this.entries) {
      if (e.lockedUntil < t && e.failures.every((f) => t - f >= this.windowMs)) this.entries.delete(k);
    }
  }
}
