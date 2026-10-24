/**
 * KV-based Session Store for Cloudflare Workers
 *
 * Sessions hold the user's Harvest OAuth tokens. They are keyed by an
 * internal session ID that is never handed to clients: clients receive
 * separate, opaque access/refresh tokens (see oauth-store.ts).
 *
 * Security properties:
 *  - Harvest access and refresh tokens are AES-GCM encrypted at rest using a
 *    key derived from SESSION_SECRET.
 *  - Sessions have a hard maximum lifetime (maxLifetimeDays) measured from
 *    creation; they do not slide forever.
 *  - Reads do not write: there is no per-request "touch", so normal MCP
 *    traffic causes no KV writes.
 */

import type { Session, SessionStore } from '../session/types.js';
import type { KVSessionData } from './types.js';
import { decryptString, encryptString, isEncrypted } from './security.js';

const SESSION_PREFIX = 'session:';
const MCP_INIT_PREFIX = 'mcp_init:';

export interface KVSessionStoreOptions {
  /** Encryption secret (SESSION_SECRET). Required. */
  secret: string;
  /** KV TTL for a session record, in seconds (renewed when the session is written). */
  ttlSeconds: number;
  /** Hard cap on session age from creation, in days. */
  maxLifetimeDays: number;
}

export class KVSessionStore implements SessionStore {
  private kv: KVNamespace;
  private opts: KVSessionStoreOptions;

  constructor(kv: KVNamespace, opts: KVSessionStoreOptions) {
    this.kv = kv;
    this.opts = opts;
  }

  /** Get session by internal ID. Returns null if missing, undecryptable or past its max lifetime. */
  async get(sessionId: string): Promise<Session | null> {
    const data = await this.kv.get<KVSessionData>(SESSION_PREFIX + sessionId, 'json');
    if (!data) return null;

    // Legacy (pre-encryption) records are not trusted; force re-authorization.
    if (data.harvestAccessToken && !isEncrypted(data.harvestAccessToken)) return null;

    let session: Session;
    try {
      if (data.id !== sessionId) return null;
      session = await this.deserializeSession(data, sessionId);
    } catch {
      return null;
    }

    const maxAgeMs = this.opts.maxLifetimeDays * 24 * 60 * 60 * 1000;
    if (Date.now() - session.createdAt.getTime() > maxAgeMs) {
      await this.delete(sessionId);
      return null;
    }
    return session;
  }

  /** Create or update session (renews the KV TTL, never past the max lifetime). */
  async set(sessionId: string, session: Session): Promise<void> {
    const data = await this.serializeSession(session);
    const maxAgeMs = this.opts.maxLifetimeDays * 24 * 60 * 60 * 1000;
    const remainingSec = Math.floor((session.createdAt.getTime() + maxAgeMs - Date.now()) / 1000);
    const ttl = Math.max(60, Math.min(this.opts.ttlSeconds, remainingSec));
    await this.kv.put(SESSION_PREFIX + sessionId, JSON.stringify(data), { expirationTtl: ttl });
  }

  async delete(sessionId: string): Promise<void> {
    await this.kv.delete(SESSION_PREFIX + sessionId);
    await this.kv.delete(MCP_INIT_PREFIX + sessionId);
  }

  /** Intentionally a no-op: sessions no longer slide on every request. */
  async touch(_sessionId: string): Promise<void> {
    return;
  }

  /** Legacy interface members (unused by the Workers runtime). */
  async setPendingAuth(_sessionId: string, _state: string): Promise<void> {
    throw new Error('setPendingAuth is not supported by the Workers session store');
  }

  async getByOAuthState(_state: string): Promise<Session | null> {
    return null;
  }

  async setMcpInitialized(sessionId: string, initialized: boolean): Promise<void> {
    const key = MCP_INIT_PREFIX + sessionId;
    if (initialized) {
      await this.kv.put(key, 'true', { expirationTtl: this.opts.ttlSeconds });
    } else {
      await this.kv.delete(key);
    }
  }

  async isMcpInitialized(sessionId: string): Promise<boolean> {
    return (await this.kv.get(MCP_INIT_PREFIX + sessionId)) === 'true';
  }

  private async serializeSession(session: Session): Promise<KVSessionData> {
    const secret = this.opts.secret;
    return {
      id: session.id,
      harvestAccessToken: session.harvestAccessToken ? await encryptString(secret, session.harvestAccessToken, `${session.id}:access`) : '',
      harvestRefreshToken: session.harvestRefreshToken ? await encryptString(secret, session.harvestRefreshToken, `${session.id}:refresh`) : '',
      harvestAccountId: session.harvestAccountId,
      tokenExpiresAt: session.tokenExpiresAt.toISOString(),
      userId: session.userId,
      userEmail: session.userEmail,
      createdAt: session.createdAt.toISOString(),
      lastAccessedAt: session.lastAccessedAt.toISOString(),
    };
  }

  private async deserializeSession(data: KVSessionData, sessionId: string): Promise<Session> {
    const secret = this.opts.secret;
    return {
      id: data.id,
      harvestAccessToken: data.harvestAccessToken ? await decryptString(secret, data.harvestAccessToken, `${sessionId}:access`) : '',
      harvestRefreshToken: data.harvestRefreshToken ? await decryptString(secret, data.harvestRefreshToken, `${sessionId}:refresh`) : '',
      harvestAccountId: data.harvestAccountId,
      tokenExpiresAt: new Date(data.tokenExpiresAt),
      userId: data.userId,
      userEmail: data.userEmail,
      createdAt: new Date(data.createdAt),
      lastAccessedAt: new Date(data.lastAccessedAt),
    };
  }
}
