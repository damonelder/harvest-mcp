/**
 * KV persistence for the MCP-facing OAuth authorization server.
 *
 * Token-like values (authorization codes, access tokens, refresh tokens) are
 * stored only as SHA-256 hashes, so a KV read does not yield usable
 * credentials.
 *
 * Note on single use: Cloudflare KV is eventually consistent across regions,
 * so a delete is not globally instantaneous. Codes are therefore also short
 * lived (60 s) and bound to the client, redirect URI and PKCE verifier.
 *
 * Refresh tokens rotate. To tolerate a client retrying a refresh whose
 * response was lost (or two near-simultaneous refreshes), a used refresh
 * token returns the same replacement pair for 60 seconds, then stops working.
 */

import { decryptString, encryptString, randomToken, sha256Hex } from './security.js';

const CLIENT_PREFIX = 'client:';
const AUTH_REQUEST_PREFIX = 'authreq:';
const CODE_PREFIX = 'code:';
const ACCESS_PREFIX = 'at:';
const REFRESH_PREFIX = 'rt:';

/** KV's minimum expirationTtl is 60 seconds. */
const MIN_TTL = 60;

export interface RegisteredClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: string;
}

export interface PendingAuthRequest {
  clientId: string;
  redirectUri: string;
  clientState?: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  createdAt: string;
}

export interface AuthorizationCodeRecord {
  sessionId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

export interface TokenRecord {
  sessionId: string;
  clientId: string;
}

interface RefreshRecord extends TokenRecord {
  /** Set once rotated: the encrypted replacement pair, kept for the 60 s grace window. */
  replacement?: string;
}

export interface IssuedTokens {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

export interface OAuthStoreOptions {
  secret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  clientTtlSeconds: number;
}

export class OAuthStore {
  constructor(private kv: KVNamespace, private opts: OAuthStoreOptions) {}

  // --- Clients (RFC 7591) ---------------------------------------------------

  async registerClient(clientName: string, redirectUris: string[]): Promise<RegisteredClient> {
    const client: RegisteredClient = {
      client_id: `mcp-client-${crypto.randomUUID()}`,
      client_name: clientName,
      redirect_uris: redirectUris,
      created_at: new Date().toISOString(),
    };
    await this.kv.put(CLIENT_PREFIX + client.client_id, JSON.stringify(client), {
      expirationTtl: this.opts.clientTtlSeconds,
    });
    return client;
  }

  async getClient(clientId: string): Promise<RegisteredClient | null> {
    return this.kv.get<RegisteredClient>(CLIENT_PREFIX + clientId, 'json');
  }

  // --- Pending authorization requests (keyed by a random nonce) ------------

  async savePendingAuth(req: PendingAuthRequest): Promise<string> {
    const nonce = randomToken(24);
    await this.kv.put(AUTH_REQUEST_PREFIX + nonce, JSON.stringify(req), { expirationTtl: 600 });
    return nonce;
  }

  /** Fetches and deletes the pending request (single use). */
  async consumePendingAuth(nonce: string): Promise<PendingAuthRequest | null> {
    const key = AUTH_REQUEST_PREFIX + nonce;
    const req = await this.kv.get<PendingAuthRequest>(key, 'json');
    if (req) await this.kv.delete(key);
    return req;
  }

  // --- Authorization codes ---------------------------------------------------

  async issueCode(record: AuthorizationCodeRecord): Promise<string> {
    const code = randomToken(32);
    await this.kv.put(CODE_PREFIX + (await sha256Hex(code)), JSON.stringify(record), {
      expirationTtl: MIN_TTL,
    });
    return code;
  }

  /** Fetches and deletes the code record (single use). */
  async consumeCode(code: string): Promise<AuthorizationCodeRecord | null> {
    const key = CODE_PREFIX + (await sha256Hex(code));
    const record = await this.kv.get<AuthorizationCodeRecord>(key, 'json');
    if (record) await this.kv.delete(key);
    return record;
  }

  // --- Access and refresh tokens ---------------------------------------------

  async issueTokens(sessionId: string, clientId: string): Promise<IssuedTokens> {
    const accessToken = randomToken(32);
    const refreshToken = randomToken(32);
    const record: TokenRecord = { sessionId, clientId };
    await this.kv.put(ACCESS_PREFIX + (await sha256Hex(accessToken)), JSON.stringify(record), {
      expirationTtl: Math.max(MIN_TTL, this.opts.accessTokenTtlSeconds),
    });
    await this.kv.put(REFRESH_PREFIX + (await sha256Hex(refreshToken)), JSON.stringify(record), {
      expirationTtl: Math.max(MIN_TTL, this.opts.refreshTokenTtlSeconds),
    });
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: this.opts.accessTokenTtlSeconds,
    };
  }

  async resolveAccessToken(accessToken: string): Promise<TokenRecord | null> {
    if (!accessToken) return null;
    return this.kv.get<TokenRecord>(ACCESS_PREFIX + (await sha256Hex(accessToken)), 'json');
  }

  /**
   * Rotate a refresh token. `issue` mints the replacement pair; it runs at
   * most once per refresh token. A repeat within the grace window gets the
   * same pair back instead of an error.
   */
  async rotateRefreshToken(
    refreshToken: string,
    issue: (record: TokenRecord) => Promise<IssuedTokens | null>
  ): Promise<{ record: TokenRecord; tokens: IssuedTokens } | null> {
    if (!refreshToken) return null;
    const hash = await sha256Hex(refreshToken);
    const key = REFRESH_PREFIX + hash;
    const record = await this.kv.get<RefreshRecord>(key, 'json');
    if (!record) return null;
    const base: TokenRecord = { sessionId: record.sessionId, clientId: record.clientId };

    if (record.replacement) {
      try {
        const tokens = JSON.parse(await decryptString(this.opts.secret, record.replacement, hash)) as IssuedTokens;
        return { record: base, tokens };
      } catch {
        return null;
      }
    }

    const tokens = await issue(base);
    if (!tokens) return null;
    const replacement = await encryptString(this.opts.secret, JSON.stringify(tokens), hash);
    await this.kv.put(key, JSON.stringify({ ...base, replacement }), { expirationTtl: MIN_TTL });
    return { record: base, tokens };
  }

  /** RFC 7009 revocation: removes the token whether it is an access or refresh token. */
  async revoke(token: string): Promise<TokenRecord | null> {
    if (!token) return null;
    const hash = await sha256Hex(token);
    const access = await this.kv.get<TokenRecord>(ACCESS_PREFIX + hash, 'json');
    const refresh = await this.kv.get<TokenRecord>(REFRESH_PREFIX + hash, 'json');
    await this.kv.delete(ACCESS_PREFIX + hash);
    await this.kv.delete(REFRESH_PREFIX + hash);
    const rec = access ?? refresh;
    return rec ? { sessionId: rec.sessionId, clientId: rec.clientId } : null;
  }
}
