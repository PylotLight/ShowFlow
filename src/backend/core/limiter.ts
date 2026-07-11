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
