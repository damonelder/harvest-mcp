/** Minimal in-memory stand-in for a Cloudflare KV namespace. */
export class MemoryKV {
  store = new Map<string, string>();

  async get(key: string, type?: 'json' | 'text'): Promise<any> {
    const v = this.store.get(key);
    if (v === undefined) return null;
    return type === 'json' ? JSON.parse(v) : v;
  }

  async put(key: string, value: string, _opts?: { expirationTtl?: number }): Promise<void> {
    if (_opts?.expirationTtl !== undefined && _opts.expirationTtl < 60) {
      throw new Error(`KV expirationTtl must be >= 60 (got ${_opts.expirationTtl})`);
    }
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}
