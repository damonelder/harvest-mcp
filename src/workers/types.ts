/**
 * Cloudflare Workers Environment Types
 */

export interface Env {
  // KV Namespaces
  SESSIONS: KVNamespace;
  RATES_CONFIG: KVNamespace;

  // Environment variables
  ENVIRONMENT: string;
  LOG_LEVEL: string;
  /** Lifetime of an MCP access token, in hours (default 1). */
  SESSION_TTL_HOURS: string;
  /** Lifetime of an MCP refresh token, in days (default 30). */
  REFRESH_TOKEN_TTL_DAYS?: string;
  /** Hard cap on a Harvest session's age before re-authorization, in days (default 90). */
  SESSION_MAX_DAYS?: string;
  ALLOWED_ORIGINS: string;
  /** Comma-separated exact OAuth redirect URIs (loopback is always allowed). */
  ALLOWED_REDIRECT_URIS?: string;
  /** Comma-separated Harvest account IDs allowed to connect (empty = any). */
  ALLOWED_HARVEST_ACCOUNT_IDS?: string;
  /** Accept client_ids registered before v0.2.0 (never persisted). Default true. */
  ALLOW_UNREGISTERED_CLIENTS?: string;

  // Secrets (set via wrangler secret put)
  HARVEST_CLIENT_ID: string;
  HARVEST_CLIENT_SECRET: string;
  SESSION_SECRET: string;
}

/**
 * Session data stored in KV (JSON serializable).
 * harvestAccessToken / harvestRefreshToken are AES-GCM ciphertext ("enc:v1:...").
 * MCP initialization state is stored separately.
 */
export interface KVSessionData {
  id: string;
  harvestAccessToken: string;
  harvestRefreshToken: string;
  harvestAccountId: string;
  tokenExpiresAt: string; // ISO date string
  userId: number;
  userEmail: string;
  createdAt: string; // ISO date string
  lastAccessedAt: string; // ISO date string
}
