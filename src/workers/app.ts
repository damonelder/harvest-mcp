/**
 * Harvest MCP Server - Cloudflare Workers Entry Point
 *
 * A remote MCP server on Cloudflare Workers that exposes the Harvest API to
 * MCP clients (claude.ai, Claude Desktop, Claude mobile, cloud sessions).
 *
 * Authorization model (MCP Authorization spec / OAuth 2.1):
 *   1. Client discovers metadata (RFC 9728 + RFC 8414) and registers (RFC 7591).
 *      Redirect URIs must exactly match an allowlisted URI (Claude's hosted
 *      callbacks) or be a loopback address (desktop clients).
 *   2. /authorize requires PKCE (S256). The request is stored under a random
 *      nonce and the user is sent to Harvest with an HMAC-signed state.
 *   3. /callback verifies the state, exchanges the Harvest code, stores the
 *      Harvest tokens encrypted in a session, and returns a single-use,
 *      60-second authorization code to the client's registered redirect URI.
 *   4. /token verifies client_id, redirect_uri and the PKCE verifier, then
 *      issues an opaque access token and a rotating refresh token. Neither is
 *      the internal session ID, and both are stored only as SHA-256 hashes.
 *   5. /mcp accepts only `Authorization: Bearer <access token>`.
 *   6. /revoke (RFC 7009) deletes an access or refresh token.
 *
 * Optionally, ALLOWED_HARVEST_ACCOUNT_IDS restricts which Harvest accounts may
 * connect at all.
 *
 * MCP transport is stateless per request (Workers cannot hold connections).
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import type { Env } from './types.js';
import { KVSessionStore } from './kv-session-store.js';
import { OAuthStore } from './oauth-store.js';
import { loadWorkersConfig } from './config.js';
import { HarvestOAuth } from '../auth/oauth.js';
import { registerTools } from '../tools/index.js';
import type { Session } from '../session/types.js';
import {
  MissingSecretError,
  assertSecret,
  isAllowedRedirectUri,
  parseAllowedRedirectUris,
  parseIdList,
  sha256Hex,
  signValue,
  verifyPkce,
  verifySignedValue,
} from './security.js';

export const SERVER_VERSION = '0.2.1';

// ---------------------------------------------------------------------------
// Settings derived from the environment
// ---------------------------------------------------------------------------

interface SecuritySettings {
  secret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  sessionMaxDays: number;
  allowedRedirectUris: string[];
  allowedAccountIds: string[];
  allowUnregisteredClients: boolean;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getSecuritySettings(env: Env): SecuritySettings {
  return {
    secret: assertSecret(env.SESSION_SECRET),
    accessTokenTtlSeconds: positiveInt(env.SESSION_TTL_HOURS, 1) * 3600,
    refreshTokenTtlSeconds: positiveInt(env.REFRESH_TOKEN_TTL_DAYS, 30) * 86400,
    sessionMaxDays: positiveInt(env.SESSION_MAX_DAYS, 90),
    allowedRedirectUris: parseAllowedRedirectUris(env.ALLOWED_REDIRECT_URIS),
    allowedAccountIds: parseIdList(env.ALLOWED_HARVEST_ACCOUNT_IDS),
    allowUnregisteredClients: (env.ALLOW_UNREGISTERED_CLIENTS ?? 'true') !== 'false',
  };
}

function getStores(env: Env, s: SecuritySettings) {
  const sessionStore = new KVSessionStore(env.SESSIONS, {
    secret: s.secret,
    ttlSeconds: s.refreshTokenTtlSeconds,
    maxLifetimeDays: s.sessionMaxDays,
  });
  const oauthStore = new OAuthStore(env.SESSIONS, {
    secret: s.secret,
    accessTokenTtlSeconds: s.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: s.refreshTokenTtlSeconds,
    clientTtlSeconds: 90 * 86400,
  });
  return { sessionStore, oauthStore };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string
  ));
}

function getBaseUrl(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

/** Redirect an OAuth error back to a validated client redirect URI (RFC 6749 §4.1.2.1). */
function redirectError(redirectUri: string, error: string, description: string, state?: string): Response {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}

function oauthError(error: string, description: string, status = 400): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  if (err instanceof MissingSecretError) {
    console.error('Configuration error: SESSION_SECRET is missing or too short');
    return c.json({ error: 'server_error', error_description: 'Server is not configured' }, 500);
  }
  console.error('Unhandled error:', err instanceof Error ? err.message : 'unknown');
  return c.json({ error: 'server_error' }, 500);
});

/**
 * CORS: MCP clients call this server from their backends (no Origin header).
 * Browser origins are limited to ALLOWED_ORIGINS. Credentials (cookies) are
 * never used, so they are not allowed.
 */
app.use('*', cors({
  origin: (origin, c) => {
    if (!origin) return '*';
    const allowed = (c.env.ALLOWED_ORIGINS || 'https://claude.ai,https://app.claude.ai')
      .split(',').map((o: string) => o.trim());
    return allowed.includes(origin) ? origin : null;
  },
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'mcp-session-id', 'Last-Event-ID', 'mcp-protocol-version'],
  exposeHeaders: ['mcp-session-id', 'mcp-protocol-version', 'WWW-Authenticate'],
  credentials: false,
  maxAge: 86400,
}));

/**
 * Landing page - minimal, private connector notice.
 */
app.get('/', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="robots" content="noindex, nofollow">
    <title>Spotlight Harvest MCP</title>
    <link rel="icon" type="image/png" href="/icon.png">
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #171717; background: #fff;
             max-width: 560px; margin: 80px auto; padding: 0 16px; line-height: 1.6; }
      h1 { font-size: 22px; margin-bottom: 8px; }
      p { color: #525252; }
      code { background: #f5f5f5; padding: 2px 6px; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h1>Spotlight Harvest MCP</h1>
    <p>Private Model Context Protocol connector for Spotlight Marketing Communications.</p>
    <p>MCP endpoint: <code>/mcp</code>. Access requires Harvest authorization.</p>
  </body>
</html>`);
});

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    version: SERVER_VERSION,
    runtime: 'cloudflare-workers',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Harvest logo icon - served from same origin for MCP icon requirements
 * Base64-encoded PNG of Harvest's apple-touch-icon (180x180)
 */
const HARVEST_ICON_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAMAAABlApw1AAAAPFBMVEX6XQD/+PH/7uL/5dP+28T+28P+0bX+x6b9vpb9tYf9tIj9qnj8oGn8l1r7l1r8jkv8hDz7ei37cB77Zw+k35VPAAABoUlEQVR42u3cTW4CMQxAYXtChxRnmJDc/65dRPy0REhIiYTV95Ze2PouYCEiIiIiIiIiIiIiIiIi+tiyxVaSezWdYivLu9XYehydr+s2Gdwe9Np6v3fSW+9fLNqSW7botShjM9VnQAk6FBBVZwE27QGiDgWYzgOEHmDXoYCi8wC79gDHsQCbCLAu4DAWsE4ExC5AAQAAAAAAAAAAAAAAAAAAAAAA/AFqOh48A9KiLacAU3UN2NQ5IDgHXNQ5YPcOOAMAAAAAgNeAkrtVH4Bqi/bLLgAlqHoGlKC+AVF9A6o6B+zeAck7wAAAAAAAAAAAAAAAAACg0yLOAdE5IBTfgFDENWAt4gkQ7HfnKuIKsMrfAAAAAADAS8DuHVCcA1ZxDrg4B5i4BiybOAZ8xVTFM6CICAAAAAAAAAAAAAAAAAAAAADgHwIW74BDF2ATAWksIHYBeSKgjAWUHiDIPIDJUMC39AD7PECUoYC19gAmswBLkpGAxUSeASHL4LbYOp3rI6tV5bG9DU1elLvrUmxZ5j0wEREREREREREREREREX1sP/+vQJawQ0UbAAAAAElFTkSuQmCC';

function iconResponse(): Response {
  const iconBuffer = Uint8Array.from(atob(HARVEST_ICON_PNG_BASE64), (ch) => ch.charCodeAt(0));
  return new Response(iconBuffer, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
  });
}

app.get('/icon.png', () => iconResponse());
app.get('/favicon.ico', () => iconResponse());

// ---------------------------------------------------------------------------
// OAuth discovery
// ---------------------------------------------------------------------------

/** OAuth Protected Resource Metadata (RFC 9728), at both the root and path-suffixed locations */
const protectedResourceMetadata = (c: { req: { raw: Request }; json: (v: unknown) => Response }) => {
  const baseUrl = getBaseUrl(c.req.raw);
  return c.json({
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ['header'],
  });
};
app.get('/.well-known/oauth-protected-resource', (c) => protectedResourceMetadata(c));
app.get('/.well-known/oauth-protected-resource/mcp', (c) => protectedResourceMetadata(c));

/** OAuth Authorization Server Metadata (RFC 8414) */
app.get('/.well-known/oauth-authorization-server', (c) => {
  const baseUrl = getBaseUrl(c.req.raw);
  return c.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    revocation_endpoint: `${baseUrl}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
  });
});

// ---------------------------------------------------------------------------
// Dynamic Client Registration (RFC 7591)
// ---------------------------------------------------------------------------

app.post('/register', async (c) => {
  const s = getSecuritySettings(c.env);
  const { oauthStore } = getStores(c.env, s);
  const body = await c.req.json().catch(() => ({})) as { client_name?: unknown; redirect_uris?: unknown };

  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === 'string')
    : [];

  if (redirectUris.length === 0 || redirectUris.length > 10) {
    return oauthError('invalid_redirect_uri', 'Between 1 and 10 redirect_uris are required');
  }
  const rejected = redirectUris.filter((u) => !isAllowedRedirectUri(u, s.allowedRedirectUris));
  if (rejected.length > 0) {
    return oauthError('invalid_redirect_uri', 'One or more redirect_uris are not allowed by this server');
  }

  const clientName = typeof body.client_name === 'string' ? body.client_name.slice(0, 100) : 'MCP Client';
  const client = await oauthStore.registerClient(clientName, redirectUris);

  return c.json({
    client_id: client.client_id,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }, 201);
});

// ---------------------------------------------------------------------------
// Authorization endpoint
// ---------------------------------------------------------------------------

app.get('/authorize', async (c) => {
  const s = getSecuritySettings(c.env);
  const { oauthStore } = getStores(c.env, s);
  const config = loadWorkersConfig(c.env, c.req.raw);

  const {
    client_id,
    redirect_uri,
    response_type,
    state,
    code_challenge,
    code_challenge_method,
  } = c.req.query();

  // Validate the redirect target first: errors before this point must not redirect.
  if (!client_id) return oauthError('invalid_request', 'client_id is required');
  if (!redirect_uri) return oauthError('invalid_request', 'redirect_uri is required');
  if (!isAllowedRedirectUri(redirect_uri, s.allowedRedirectUris)) {
    return oauthError('invalid_request', 'redirect_uri is not allowed by this server');
  }

  const client = await oauthStore.getClient(client_id);
  if (client && !client.redirect_uris.includes(redirect_uri)) {
    return oauthError('invalid_request', 'redirect_uri does not match the registered client');
  }
  if (!client) {
    // Clients registered before v0.2.0 were never persisted. They are accepted
    // (when enabled) only because redirect_uri already matched the exact
    // allowlist above; set ALLOW_UNREGISTERED_CLIENTS=false once all clients
    // have re-registered.
    if (!s.allowUnregisteredClients) return oauthError('invalid_client', 'Unknown client_id; register first');
    console.log('Authorization from an unregistered (pre-v0.2.0) client_id');
  }

  // redirect_uri is trusted from here on, so errors go back to the client.
  if (response_type !== 'code') {
    return redirectError(redirect_uri, 'unsupported_response_type', 'response_type must be "code"', state);
  }
  if (!code_challenge || code_challenge_method !== 'S256' || !/^[A-Za-z0-9\-_]{43}$/.test(code_challenge)) {
    return redirectError(redirect_uri, 'invalid_request', 'PKCE with code_challenge_method=S256 is required', state);
  }

  const nonce = await oauthStore.savePendingAuth({
    clientId: client_id,
    redirectUri: redirect_uri,
    clientState: state,
    codeChallenge: code_challenge,
    codeChallengeMethod: 'S256',
    createdAt: new Date().toISOString(),
  });

  const harvestState = await signValue(s.secret, nonce);
  const oauth = new HarvestOAuth(config.harvest);
  return c.redirect(oauth.getAuthorizationUrl(harvestState));
});

// ---------------------------------------------------------------------------
// Harvest callback
// ---------------------------------------------------------------------------

app.get('/callback', async (c) => {
  const s = getSecuritySettings(c.env);
  const { sessionStore, oauthStore } = getStores(c.env, s);
  const config = loadWorkersConfig(c.env, c.req.raw);
  const oauth = new HarvestOAuth(config.harvest);

  const { code, state, error } = c.req.query();

  if (!state) return c.text('Missing state parameter', 400);
  const nonce = await verifySignedValue(s.secret, state);
  if (!nonce) return c.text('Invalid state parameter', 400);

  const pending = await oauthStore.consumePendingAuth(nonce);
  if (!pending) return c.text('Authorization request expired or already used. Please try connecting again.', 400);

  if (error || !code) {
    // Tell the client so it does not hang waiting for a code.
    return redirectError(
      pending.redirectUri,
      'access_denied',
      error ? `Harvest authorization was not completed (${escapeHtml(error).slice(0, 100)})` : 'Missing code',
      pending.clientState
    );
  }

  try {
    const tokens = await oauth.exchangeCode(code);
    const accounts = await oauth.getAccounts(tokens.access_token);
    // Fail closed: an empty allowlist admits nobody outside development;
    // use "*" to deliberately allow any Harvest account.
    const anyAccount = s.allowedAccountIds.includes('*') ||
      (s.allowedAccountIds.length === 0 && c.env.ENVIRONMENT === 'development');
    const harvestAccount = accounts.accounts.find((a) =>
      a.product === 'harvest' && (anyAccount || s.allowedAccountIds.includes(String(a.id)))
    );
    if (!harvestAccount) {
      console.log('OAuth rejected: no permitted Harvest account');
      return redirectError(
        pending.redirectUri,
        'access_denied',
        'This Harvest account is not permitted to use this connector',
        pending.clientState
      );
    }

    const now = new Date();
    const session: Session = {
      id: crypto.randomUUID(),
      harvestAccessToken: tokens.access_token,
      harvestRefreshToken: tokens.refresh_token,
      harvestAccountId: String(harvestAccount.id),
      tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      userId: accounts.user.id,
      userEmail: accounts.user.email,
      createdAt: now,
      lastAccessedAt: now,
    };
    await sessionStore.set(session.id, session);

    const authCode = await oauthStore.issueCode({
      sessionId: session.id,
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      codeChallengeMethod: pending.codeChallengeMethod,
    });

    console.log('OAuth authorization completed');

    const redirectUrl = new URL(pending.redirectUri);
    redirectUrl.searchParams.set('code', authCode);
    if (pending.clientState) redirectUrl.searchParams.set('state', pending.clientState);
    return c.redirect(redirectUrl.toString());
  } catch (err) {
    console.error('OAuth callback error:', err instanceof Error ? err.message.slice(0, 200) : 'unknown');
    return redirectError(pending.redirectUri, 'server_error', 'Could not complete Harvest authorization', pending.clientState);
  }
});

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

app.post('/token', async (c) => {
  const s = getSecuritySettings(c.env);
  const { sessionStore, oauthStore } = getStores(c.env, s);

  const contentType = c.req.header('content-type') || '';
  let params: Record<string, string> = {};
  if (contentType.includes('application/x-www-form-urlencoded')) {
    params = Object.fromEntries(new URLSearchParams(await c.req.text()));
  } else if (contentType.includes('application/json')) {
    const parsedBody = await c.req.json().catch(() => null);
    if (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
      params = Object.fromEntries(
        Object.entries(parsedBody as Record<string, unknown>).filter(([, v]) => typeof v === 'string')
      ) as Record<string, string>;
    }
  }

  const { grant_type, code, refresh_token, code_verifier, client_id, redirect_uri } = params;

  if (grant_type === 'authorization_code') {
    if (!code) return oauthError('invalid_request', 'code is required');
    if (!client_id) return oauthError('invalid_request', 'client_id is required');

    const record = await oauthStore.consumeCode(code);
    if (!record) return oauthError('invalid_grant', 'Invalid, expired or already used code');
    if (record.clientId !== client_id) return oauthError('invalid_grant', 'Code was not issued to this client');
    if (redirect_uri !== undefined && redirect_uri !== record.redirectUri) {
      return oauthError('invalid_grant', 'redirect_uri does not match the authorization request');
    }
    const pkceOk = await verifyPkce(code_verifier, record.codeChallenge, record.codeChallengeMethod);
    if (!pkceOk) return oauthError('invalid_grant', 'PKCE verification failed');

    const session = await sessionStore.get(record.sessionId);
    if (!session || !session.harvestAccessToken) return oauthError('invalid_grant', 'Authorization session expired');

    const tokens = await oauthStore.issueTokens(session.id, record.clientId);
    return c.json(tokens, 200, { 'Cache-Control': 'no-store' });
  }

  if (grant_type === 'refresh_token') {
    if (!refresh_token) return oauthError('invalid_request', 'refresh_token is required');

    let failure = 'Invalid or expired refresh token';
    const result = await oauthStore.rotateRefreshToken(refresh_token, async (record) => {
      if (client_id && client_id !== record.clientId) {
        failure = 'Refresh token was not issued to this client';
        return null;
      }
      const session = await sessionStore.get(record.sessionId);
      if (!session || !session.harvestAccessToken) {
        failure = 'Session expired; please reconnect';
        return null;
      }
      // Renew the session record's TTL (bounded by the session's max lifetime).
      session.lastAccessedAt = new Date();
      await sessionStore.set(session.id, session);
      return oauthStore.issueTokens(session.id, record.clientId);
    });

    if (!result) return oauthError('invalid_grant', failure);
    if (client_id && client_id !== result.record.clientId) {
      return oauthError('invalid_grant', 'Refresh token was not issued to this client');
    }
    return c.json(result.tokens, 200, { 'Cache-Control': 'no-store' });
  }

  return oauthError('unsupported_grant_type', 'Supported grant types: authorization_code, refresh_token');
});

// ---------------------------------------------------------------------------
// Token revocation (RFC 7009)
// ---------------------------------------------------------------------------

app.post('/revoke', async (c) => {
  const s = getSecuritySettings(c.env);
  const { oauthStore } = getStores(c.env, s);
  const contentType = c.req.header('content-type') || '';
  let token = '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    token = new URLSearchParams(await c.req.text()).get('token') || '';
  } else if (contentType.includes('application/json')) {
    const body = await c.req.json().catch(() => null) as { token?: unknown } | null;
    token = typeof body?.token === 'string' ? body.token : '';
  }
  if (!token) return oauthError('invalid_request', 'token is required');
  const revoked = await oauthStore.revoke(token);
  if (revoked) {
    // Revoke related credentials too (RFC 7009 §2.1): ending the session
    // invalidates every token issued from it.
    const { sessionStore } = getStores(c.env, s);
    await sessionStore.delete(revoked.sessionId);
  }
  // Per RFC 7009, respond 200 whether or not the token existed.
  return c.body(null, 200);
});

// ---------------------------------------------------------------------------
// MCP endpoint
// ---------------------------------------------------------------------------

function createInitializeRequest(mcpSessionId: string): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'mcp-session-id': mcpSessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'harvest-mcp-prewarm', version: '1.0' },
      },
      id: 'prewarm',
    }),
  });
}

async function parseMethod(request: Request): Promise<{ method: string; body: string } | null> {
  try {
    const body = await request.text();
    const parsed = JSON.parse(body);
    return { method: parsed.method || '', body };
  } catch {
    return null;
  }
}

function unauthorized(baseUrl: string, tokenProvided: boolean): Response {
  const resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;
  const challenge = tokenProvided
    ? `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}"`
    : `Bearer resource_metadata="${resourceMetadataUrl}"`;
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Authorization required. Please authenticate with Harvest.' },
    id: null,
  }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': challenge,
      'Access-Control-Expose-Headers': 'WWW-Authenticate',
    },
  });
}

app.all('/mcp', async (c) => {
  const env = c.env;
  const request = c.req.raw;
  const s = getSecuritySettings(env);
  const { sessionStore, oauthStore } = getStores(env, s);
  const config = loadWorkersConfig(env, request);
  const baseUrl = getBaseUrl(request);

  const authHeader = c.req.header('Authorization') || '';
  const match = /^bearer\s+(.+)$/i.exec(authHeader.trim());
  const bearer = match ? match[1].trim() : '';

  let session: Session | null = null;
  if (bearer) {
    const record = await oauthStore.resolveAccessToken(bearer);
    if (record) session = await sessionStore.get(record.sessionId);
  }

  if (!session || !session.harvestAccessToken) {
    return unauthorized(baseUrl, !!bearer);
  }
  const activeSession = session;

  // Non-secret, stable identifier for the stateless MCP transport.
  const mcpSessionId = (await sha256Hex(`mcp:${activeSession.id}`)).slice(0, 32);

  const parsed = await parseMethod(request.clone());
  const isInitRequest = parsed?.method === 'initialize';
  const isBatch = parsed ? parsed.body.trimStart().startsWith('[') : false;

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => mcpSessionId,
    enableJsonResponse: true,
  });

  const server = new McpServer({
    name: 'Harvest',
    version: SERVER_VERSION,
    description: 'Time tracking, invoicing and reporting via the Harvest API',
    icons: [{ src: `${baseUrl}/icon.png`, mimeType: 'image/png', sizes: ['180x180'] }],
  });

  registerTools(server, activeSession, sessionStore, config);
  await server.connect(transport);

  // Stateless transport: every non-initialize request is preceded by a
  // synthetic initialize so the per-request server is ready to answer.
  if (!isInitRequest && !isBatch) {
    await transport.handleRequest(createInitializeRequest(mcpSessionId));
  }

  const actualHeaders = new Headers(request.headers);
  actualHeaders.set('mcp-session-id', mcpSessionId);
  const actualRequest = new Request(request.url, {
    method: request.method,
    headers: actualHeaders,
    body: parsed?.body,
  });

  return transport.handleRequest(actualRequest);
});

