/**
 * Rate limiter for Harvest API requests
 * 
 * Harvest has a limit of 100 requests per 15 seconds.
 * This module tracks requests in a sliding window and provides
 * throttling to avoid hitting rate limits.
 */

export interface RateLimitConfig {
  maxRequests: number;      // Max requests in window (default: 100)
  windowMs: number;         // Window size in milliseconds (default: 15000)
  warningThreshold: number; // Start throttling at this % of limit (default: 0.8)
}

export interface RateLimitStatus {
  remaining: number;
  total: number;
  resetMs: number;
  isThrottled: boolean;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  maxRequests: 100,
  windowMs: 15000,      // 15 seconds
  warningThreshold: 0.8, // Start throttling at 80%
};

export class HarvestRateLimiter {
  private config: RateLimitConfig;
  private requestTimestamps: number[] = [];
  private retryAfterMs: number = 0;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Clean up old timestamps outside the sliding window
   */
  private cleanOldTimestamps(): void {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;
    this.requestTimestamps = this.requestTimestamps.filter(ts => ts > cutoff);
  }

  /**
   * Get current rate limit status
   */
  getStatus(): RateLimitStatus {
    this.cleanOldTimestamps();
    
    const now = Date.now();
    const count = this.requestTimestamps.length;
    const remaining = Math.max(0, this.config.maxRequests - count);
    
    // Calculate reset time (when oldest request falls out of window)
    let resetMs = 0;
    if (this.requestTimestamps.length > 0) {
      const oldestTimestamp = Math.min(...this.requestTimestamps);
      resetMs = Math.max(0, (oldestTimestamp + this.config.windowMs) - now);
    }
    
    // Check if we're in a retry-after period
    const isThrottled = this.retryAfterMs > now || 
      count >= this.config.maxRequests * this.config.warningThreshold;

    return {
      remaining,
      total: this.config.maxRequests,
      resetMs,
      isThrottled,
    };
  }

  /**
   * Record a request and check if we should proceed
   * Returns the number of milliseconds to wait before making the request (0 = proceed immediately)
   */
  async acquirePermit(): Promise<number> {
    this.cleanOldTimestamps();
    
    const now = Date.now();
    
    // Check retry-after period
    if (this.retryAfterMs > now) {
      return this.retryAfterMs - now;
    }
    
    const count = this.requestTimestamps.length;
    
    // If at limit, calculate wait time
    if (count >= this.config.maxRequests) {
      const oldestTimestamp = Math.min(...this.requestTimestamps);
      const waitMs = (oldestTimestamp + this.config.windowMs) - now;
      return Math.max(0, waitMs);
    }
    
    // If approaching limit, add small delay to spread requests
    if (count >= this.config.maxRequests * this.config.warningThreshold) {
      // Spread remaining requests across remaining window time
      const remaining = this.config.maxRequests - count;
      const delayMs = Math.floor(this.config.windowMs / remaining / 2);
      return Math.min(delayMs, 500); // Cap at 500ms
    }
    
    return 0;
  }

  /**
   * Record that a request was made
   */
  recordRequest(): void {
    this.requestTimestamps.push(Date.now());
  }

  /**
   * Handle a 429 response from the API
   * @param retryAfterSeconds - The Retry-After header value in seconds
   */
  handleRateLimit(retryAfterSeconds: number): void {
    this.retryAfterMs = Date.now() + (retryAfterSeconds * 1000);
  }

  /**
   * Reset the rate limiter (for testing)
   */
  reset(): void {
    this.requestTimestamps = [];
    this.retryAfterMs = 0;
  }
}

// One limiter per Harvest account: Harvest enforces its limit per account/token,
// so users of different accounts must not throttle each other.
const _instances = new Map<string, HarvestRateLimiter>();

export function getRateLimiter(config?: Partial<RateLimitConfig>, key = 'default'): HarvestRateLimiter {
  let limiter = _instances.get(key);
  if (!limiter) {
    limiter = new HarvestRateLimiter(config);
    _instances.set(key, limiter);
  }
  return limiter;
}

export function resetRateLimiter(): void {
  _instances.clear();
}
