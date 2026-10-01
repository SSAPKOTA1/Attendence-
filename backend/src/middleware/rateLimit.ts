import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors/AppError';

/** Fixed-window in-memory limiter (one process). Keys are caller-specific strings. */
export class RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly max: number, private readonly windowMs: number) {}

  /** Returns false when the limit is exceeded. */
  hit(key: string): boolean {
    const t = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= t) {
      b = { count: 0, resetAt: t + this.windowMs };
      this.buckets.set(key, b);
    }
    b.count += 1;
    if (this.buckets.size > 50_000) this.sweep(t);
    return b.count <= this.max;
  }

  reset(key?: string): void {
    if (key) this.buckets.delete(key);
    else this.buckets.clear();
  }

  private sweep(t: number): void {
    for (const [k, v] of this.buckets) if (v.resetAt <= t) this.buckets.delete(k);
  }
}

export function limitBy(limiter: RateLimiter, keyFn: (req: Request) => string | null) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const key = keyFn(req);
    if (key && !limiter.hit(key)) return next(new AppError('RATE_LIMITED'));
    next();
  };
}
