import { z } from 'zod';
import { debugLog } from './debug';

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per millisecond

  constructor(capacity: number, refillRatePerSecond: number) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRatePerSecond / 1000;
    this.lastRefill = Date.now();
  }

  private refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const refillAmount = elapsed * this.refillRate;
    
    this.tokens = Math.min(this.capacity, this.tokens + refillAmount);
    this.lastRefill = now;
  }

  async acquire(tokensRequested = 1): Promise<void> {
    this.refill();

    if (this.tokens < tokensRequested) {
      const needed = tokensRequested - this.tokens;
      const waitTime = Math.ceil(needed / this.refillRate);
      
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      return this.acquire(tokensRequested);
    }

    this.tokens -= tokensRequested;
  }

  /**
   * Processes an array of items with a maximum number of concurrent async operations.
   */
  async mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let index = 0;

    const worker = async () => {
      while (index < items.length) {
        const currentIndex = index++;
        const item = items[currentIndex];
        if (item !== undefined) {
          results[currentIndex] = await fn(item);
        }
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
    await Promise.all(workers);
    return results;
  }
}

export const limiter = new RateLimiter(10, 2); // Example: 10 burst, 2 requests/sec

/**
 * Counting semaphore that caps how many operations run at once; excess
 * callers wait in FIFO order. Unlike RateLimiter (which throttles by tokens
 * over time), this bounds *in-flight* work — e.g. concurrent grab downloads —
 * and hands the freed slot straight to the next waiter.
 */
export class Semaphore {
  readonly capacity: number;
  private available: number;
  private waiters: ((release: () => void) => void)[] = [];

  constructor(max: number) {
    this.capacity = Math.max(1, Math.floor(max));
    this.available = this.capacity;
  }

  get inUse(): number {
    return this.capacity - this.available;
  }

  get queued(): number {
    return this.waiters.length;
  }

  /**
   * Resolves with a release function once a slot is free. If `signal`
   * aborts while waiting, the promise rejects and the caller never
   * consumes a slot.
   */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
    if (this.available > 0) {
      this.available--;
      return Promise.resolve(this.createRelease());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter = (release: () => void) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(release);
      };
      const onAbort = () => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(signal?.reason ?? new Error('Aborted'));
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async runExclusive<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private createRelease(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiters.shift();
      if (next) next(this.createRelease()); // hand the slot straight over
      else this.available++;
    };
  }
}
