/**
 * LRU Cache for Harvest API responses
 * 
 * Caches GET request responses with configurable TTL.
 * Cache keys are generated from a caller scope (Harvest account + token
 * fingerprint), the request path and parameters, so one user's cached
 * responses are never served to another user sharing the same isolate.
 */

import { LRUCache } from 'lru-cache';
import { createHash } from 'node:crypto';

export interface CacheConfig {
  maxSize: number;      // Maximum number of entries (default: 500)
  ttlMs: number;        // Time to live in milliseconds (default: 60000)
}

export interface CachedResponse<T> {
  data: T;
  timestamp: number;
  cacheKey: string;
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}

const DEFAULT_CONFIG: CacheConfig = {
  maxSize: 500,
  ttlMs: 15000, // 15 seconds: other isolates may not see a write's invalidation
};

export class HarvestCache {
  private cache: LRUCache<string, CachedResponse<unknown>>;
  private config: CacheConfig;
  private stats: CacheStats = { hits: 0, misses: 0, size: 0 };

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    this.cache = new LRUCache({
      max: this.config.maxSize,
      ttl: this.config.ttlMs,
      updateAgeOnGet: false,
      updateAgeOnHas: false,
    });
  }

  /**
   * Generate a cache key: "<scope>|<path>:<hash of path+params>".
   * The scope must identify the caller (see HarvestClient), never be empty.
   */
  static generateKey(scope: string, path: string, params?: Record<string, unknown>): string {
    if (!scope) throw new Error('Cache scope is required');
    const normalizedParams = params
      ? JSON.stringify(
          Object.entries(params)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
        )
      : '';

    const hash = createHash('sha256')
      .update(path + normalizedParams)
      .digest('hex')
      .substring(0, 16);

    return `${scope}|${path}:${hash}`;
  }

  /** Fingerprint used as a cache scope: account ID + truncated token hash. */
  static scopeFor(accountId: string, accessToken: string): string {
    const fp = createHash('sha256').update(accessToken).digest('hex').substring(0, 16);
    return `${accountId}:${fp}`;
  }

  /**
   * Get a cached response
   */
  get<T>(key: string): CachedResponse<T> | undefined {
    const entry = this.cache.get(key) as CachedResponse<T> | undefined;
    
    if (entry) {
      this.stats.hits++;
      return entry;
    }
    
    this.stats.misses++;
    return undefined;
  }

  /**
   * Store a response in cache
   */
  set<T>(key: string, data: T): void {
    const entry: CachedResponse<T> = {
      data,
      timestamp: Date.now(),
      cacheKey: key,
    };
    
    this.cache.set(key, entry);
    this.stats.size = this.cache.size;
  }

  /**
   * Check if a key exists and is still valid
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * Get the age of a cached entry in seconds
   */
  getAge(key: string): number | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    
    return Math.floor((Date.now() - entry.timestamp) / 1000);
  }

  /**
   * Invalidate cache entries matching a pattern
   * Used when write operations are performed
   */
  invalidate(pattern: string | RegExp): number {
    let count = 0;
    const keys = Array.from(this.cache.keys());
    
    for (const key of keys) {
      const matches = typeof pattern === 'string' 
        ? key.includes(pattern)
        : pattern.test(key);
      
      if (matches) {
        this.cache.delete(key);
        count++;
      }
    }
    
    this.stats.size = this.cache.size;
    return count;
  }

  /**
   * Clear all cached entries
   */
  clear(): void {
    this.cache.clear();
    this.stats.size = 0;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats, size: this.cache.size };
  }

  /**
   * Get the configured TTL in milliseconds
   */
  getTtlMs(): number {
    return this.config.ttlMs;
  }
}

// Singleton instance for the application
let _instance: HarvestCache | null = null;

export function getCache(config?: Partial<CacheConfig>): HarvestCache {
  if (!_instance) {
    _instance = new HarvestCache(config);
  }
  return _instance;
}

export function resetCache(): void {
  if (_instance) {
    _instance.clear();
  }
  _instance = null;
}
