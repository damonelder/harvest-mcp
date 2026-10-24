import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/workers/app.js';
import { pkceS256Challenge } from '../src/workers/security.js';
import { MemoryKV } from './kv-mock.js';
import { resetCache } from '../src/harvest/cache.js';

const BASE = 'https://spotlight-harvest-mcp.example.workers.dev';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'a'.repeat(20) + 'B'.repeat(20) + '-._~123';
const HARVEST_ACCESS = 'HARVEST-ACCESS-PLAINTEXT-123';
const HARVEST_REFRESH = 'HARVEST-REFRESH-PLAINTEXT-456';

let kv: MemoryKV;
let env: Record<string, unknown>;

function req(path: string, init?: RequestInit) {
  return app.request(`${BASE}${path}`, init, env);
}

function harvestFetchMock() {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('https://id.getharvest.com/api/v2/oauth2/token')) {
      return Response.json({ access_token: HARVEST_ACCESS, refresh_token: HARVEST_REFRESH, token_type: 'bearer', expires_in: 1209600 });
    }
    if (url.startsWith('https://id.getharvest.com/api/v2/accounts')) {
      return Response.json({
        user: { id: 42, first_name: 'Test', last_name: 'User', email: 'test@example.com' },
        accounts: [{ id: 999, name: 'Spotlight', product: 'harvest' }],
      });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
}

async function register(redirectUris: string[] = [REDIRECT]) {
  const res = await req('/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: redirectUris }),
  });
  return { res, body: await res.json() as any };
}

async function authorize(clientId: string, overrides: Record<string, string | undefined> = {}) {
  const params = new URLSearchParams();
  const all: Record<string, string | undefined> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: 'client-state-xyz',
    code_challenge: await pkceS256Challenge(VERIFIER),
    code_challenge_method: 'S256',
    ...overrides,
  };
  for (const [k, v] of Object.entries(all)) if (v !== undefined) params.set(k, v);
  return req(`/authorize?${params}`);
}

/** Full happy path up to an authorization code. */
async function getCode() {
  const { body: client } = await register();
  const authRes = await authorize(client.client_id);
  const harvestUrl = new URL(authRes.headers.get('Location')!);
  const state = harvestUrl.searchParams.get('state')!;
  const cb = await req(`/callback?code=harvest-code&state=${encodeURIComponent(state)}`);
  const back = new URL(cb.headers.get('Location')!);
  return { clientId: client.client_id, code: back.searchParams.get('code')!, back, state };
}

async function exchange(fields: Record<string, string>) {
  return req('/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

async function getTokens() {
  const { clientId, code } = await getCode();
  const res = await exchange({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER });
  return { clientId, tokens: await res.json() as any };
}

function mcp(token: string | undefined, body: unknown) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return req('/mcp', { method: 'POST', headers, body: JSON.stringify(body) });
}

beforeEach(() => {
  resetCache();
  kv = new MemoryKV();
  env = {
    SESSIONS: kv,
    RATES_CONFIG: new MemoryKV(),
    ENVIRONMENT: 'test',
    LOG_LEVEL: 'error',
    SESSION_TTL_HOURS: '24',
    ALLOWED_ORIGINS: 'https://claude.ai',
    HARVEST_CLIENT_ID: 'cid',
    HARVEST_CLIENT_SECRET: 'csecret',
    ALLOWED_HARVEST_ACCOUNT_IDS: '999',
    SESSION_SECRET: 'test-secret-that-is-at-least-32-characters-long',
  };
  vi.stubGlobal('fetch', harvestFetchMock());
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('client registration', () => {
  it('registers clients with allowed redirect URIs', async () => {
    const { res, body } = await register();
    expect(res.status).toBe(201);
    expect(body.client_id).toMatch(/^mcp-client-/);
  });

  it('rejects redirect URIs on other hosts', async () => {
    const { res, body } = await register(['https://attacker.example.com/cb']);
    expect(res.status).toBe(400);
    expect(body.error).toBe('invalid_redirect_uri');
  });
});

describe('/authorize', () => {
  it('requires PKCE S256 and reports the error back to the client', async () => {
    const { body: client } = await register();
    for (const override of [{ code_challenge: undefined }, { code_challenge_method: 'plain' }]) {
      const res = await authorize(client.client_id, override);
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get('Location')!);
      expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
      expect(loc.searchParams.get('error')).toBe('invalid_request');
      expect(loc.searchParams.get('state')).toBe('client-state-xyz');
    }
  });

  it('rejects unknown clients when legacy acceptance is disabled', async () => {
    env.ALLOW_UNREGISTERED_CLIENTS = 'false';
    const res = await authorize('mcp-client-unknown');
    expect(res.status).toBe(400);
  });

  it('accepts unknown (pre-upgrade) clients on an exact allowlisted redirect by default', async () => {
    const res = await authorize('mcp-client-legacy');
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('Location')!).origin).toBe('https://id.getharvest.com');
  });

  it('rejects a redirect_uri that does not match the registered client', async () => {
    const { body: client } = await register();
    const res = await authorize(client.client_id, { redirect_uri: 'https://claude.ai/other' });
    expect(res.status).toBe(400);
  });

  it('never redirects to an unapproved host, even for unknown clients', async () => {
    const res = await authorize('mcp-client-unknown', { redirect_uri: 'https://attacker.example.com/cb' });
    expect(res.status).toBe(400);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('sends the user to Harvest with a signed state', async () => {
    const { body: client } = await register();
    const res = await authorize(client.client_id);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('Location')!);
    expect(loc.origin).toBe('https://id.getharvest.com');
    expect(loc.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});

describe('/callback', () => {
  it('rejects a forged state', async () => {
    const res = await req('/callback?code=x&state=forged.state');
    expect(res.status).toBe(400);
  });

  it('returns a code to the registered redirect URI and preserves client state', async () => {
    const { back, code } = await getCode();
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('client-state-xyz');
    expect(code.length).toBeGreaterThanOrEqual(43);
  });

  it('cannot be replayed with the same state', async () => {
    const { state } = await getCode();
    const res = await req(`/callback?code=harvest-code&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(400);
  });

  it('does not log the authorization code', async () => {
    const logSpy = vi.mocked(console.log);
    const { code } = await getCode();
    const logged = logSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain(code);
  });
});

describe('/token', () => {
  it('rejects a wrong PKCE verifier', async () => {
    const { clientId, code } = await getCode();
    const res = await exchange({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: 'z'.repeat(50) });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe('invalid_grant');
  });

  it('rejects a code presented by a different client', async () => {
    const { code } = await getCode();
    const res = await exchange({ grant_type: 'authorization_code', code, client_id: 'mcp-client-other', code_verifier: VERIFIER });
    expect(res.status).toBe(400);
  });

  it('issues opaque tokens and makes the code single-use', async () => {
    const { clientId, code } = await getCode();
    const fields = { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER };
    const first = await exchange(fields);
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    const tokens = await first.json() as any;
    expect(tokens.access_token).not.toBe(code);
    expect(tokens.refresh_token).not.toBe(tokens.access_token);
    expect(tokens.token_type).toBe('Bearer');

    const second = await exchange(fields);
    expect(second.status).toBe(400);
  });

  it('rotates refresh tokens, with a grace window that returns the same pair', async () => {
    const { clientId, tokens } = await getTokens();
    const r1 = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    expect(r1.status).toBe(200);
    const next = await r1.json() as any;
    expect(next.refresh_token).not.toBe(tokens.refresh_token);

    // A retry inside the grace window gets the identical pair, not a new one.
    const retry = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(next);

    // The new refresh token works and rotates again.
    const r2 = await exchange({ grant_type: 'refresh_token', refresh_token: next.refresh_token, client_id: clientId });
    expect(r2.status).toBe(200);
  });

  it('rejects a refresh token presented by a different client', async () => {
    const { tokens } = await getTokens();
    const res = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: 'mcp-client-other' });
    expect(res.status).toBe(400);
  });

  it('returns invalid_request (not 500) for a non-object JSON body', async () => {
    const res = await req('/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null' });
    expect(res.status).toBe(400);
  });
});

describe('callback errors and account restrictions', () => {
  async function startFlow() {
    const { body: client } = await register();
    const authRes = await authorize(client.client_id);
    return new URL(authRes.headers.get('Location')!).searchParams.get('state')!;
  }

  it('relays a Harvest denial back to the client', async () => {
    const state = await startFlow();
    const res = await req(`/callback?error=access_denied&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('Location')!);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('client-state-xyz');
  });

  it('refuses Harvest accounts outside ALLOWED_HARVEST_ACCOUNT_IDS', async () => {
    env.ALLOWED_HARVEST_ACCOUNT_IDS = '12345';
    const state = await startFlow();
    const res = await req(`/callback?code=harvest-code&state=${encodeURIComponent(state)}`);
    const loc = new URL(res.headers.get('Location')!);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('code')).toBeNull();
  });

  it('accepts a permitted Harvest account', async () => {
    env.ALLOWED_HARVEST_ACCOUNT_IDS = '999';
    const state = await startFlow();
    const res = await req(`/callback?code=harvest-code&state=${encodeURIComponent(state)}`);
    expect(new URL(res.headers.get('Location')!).searchParams.get('code')).toBeTruthy();
  });
});

describe('revocation', () => {
  it('revokes access and refresh tokens', async () => {
    const { clientId, tokens } = await getTokens();
    for (const token of [tokens.access_token, tokens.refresh_token]) {
      const res = await req('/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
      });
      expect(res.status).toBe(200);
    }
    const call = await mcp(tokens.access_token, { jsonrpc: '2.0', method: 'initialize', id: 1, params: {} });
    expect(call.status).toBe(401);
    const refresh = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    expect(refresh.status).toBe(400);
  });
});

describe('metadata', () => {
  it('serves protected resource metadata at the path-suffixed location too', async () => {
    const res = await req('/.well-known/oauth-protected-resource/mcp');
    expect(res.status).toBe(200);
    expect((await res.json() as any).resource).toBe(`${BASE}/mcp`);
  });
});

describe('storage', () => {
  it('never stores Harvest tokens or client tokens in plaintext', async () => {
    const { tokens } = await getTokens();
    const everything = [...kv.store.entries()].map(([k, v]) => `${k}=${v}`).join('\n');
    expect(everything).not.toContain(HARVEST_ACCESS);
    expect(everything).not.toContain(HARVEST_REFRESH);
    expect(everything).not.toContain(tokens.access_token);
    expect(everything).not.toContain(tokens.refresh_token);
  });
});

describe('/mcp', () => {
  it('returns 401 with resource metadata when no token is sent', async () => {
    const res = await mcp(undefined, { jsonrpc: '2.0', method: 'initialize', id: 1, params: {} });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('resource_metadata=');
  });

  it('returns invalid_token for an unknown bearer token', async () => {
    const res = await mcp('garbage', { jsonrpc: '2.0', method: 'initialize', id: 1, params: {} });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('invalid_token');
  });

  it('accepts a lower-case bearer scheme', async () => {
    const { tokens } = await getTokens();
    const res = await req('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `bearer ${tokens.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    });
    expect(res.status).toBe(200);
  });

  it('answers tools/list even without a prior initialize on this server', async () => {
    const { tokens } = await getTokens();
    const res = await mcp(tokens.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(res.status).toBe(200);
  });

  it('ignores legacy session headers', async () => {
    const res = await req('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-harvest-session': 'anything', 'mcp-session-id': 'anything' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('serves the tool list with annotations to an authorized client', async () => {
    const { tokens } = await getTokens();
    const init = await mcp(tokens.access_token, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    expect(init.status).toBe(200);
    expect(init.headers.get('x-harvest-session')).toBeNull();

    const list = await mcp(tokens.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(list.status).toBe(200);
    const body = await list.json() as any;
    const tools = body.result.tools as Array<{ name: string; annotations?: Record<string, boolean> }>;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    for (const name of [
      'harvest_report_time', 'harvest_report_uninvoiced', 'harvest_report_project_budget', 'harvest_report_expenses',
      'harvest_create_project', 'harvest_update_project', 'harvest_create_client', 'harvest_create_contact',
      'harvest_assign_task_to_project', 'harvest_create_expense', 'harvest_delete_expense', 'harvest_get_invoice',
      'harvest_create_time_entry', 'harvest_create_invoice',
    ]) {
      expect(byName[name], name).toBeDefined();
    }
    expect(byName.harvest_delete_time_entry.annotations?.destructiveHint).toBe(true);
    expect(byName.harvest_delete_invoice.annotations?.destructiveHint).toBe(true);
    expect(byName.harvest_list_time_entries.annotations?.readOnlyHint).toBe(true);
    expect(byName.harvest_report_time.annotations?.readOnlyHint).toBe(true);
    expect(byName.harvest_create_time_entry.annotations?.readOnlyHint).toBe(false);
    expect(tools.every((t) => t.annotations !== undefined)).toBe(true);

    const init2 = await mcp(tokens.access_token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'harvest_init', arguments: {} } });
    const initBody = await init2.json() as any;
    const summary = JSON.parse(initBody.result.content[0].text);
    expect(summary.tool_count).toBe(tools.length);
  });
});

describe('configuration', () => {
  it('fails closed when SESSION_SECRET is missing', async () => {
    env.SESSION_SECRET = '';
    const res = await req('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT] }),
    });
    expect(res.status).toBe(500);
  });

  it('does not reflect arbitrary CORS origins', async () => {
    const res = await req('/health', { headers: { Origin: 'https://attacker.example.com' } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const ok = await req('/health', { headers: { Origin: 'https://claude.ai' } });
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('https://claude.ai');
  });
});

describe('tool calls through MCP', () => {
  async function initialized() {
    const { tokens } = await getTokens();
    await mcp(tokens.access_token, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    return tokens.access_token as string;
  }

  it('harvest_report_time calls the Reports API with the decrypted Harvest token', async () => {
    const token = await initialized();
    const calls: Array<{ url: string; auth: string | null; account: string | null }> = [];
    const base = harvestFetchMock();
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      if (input.startsWith('https://api.harvestapp.com/')) {
        const h = new Headers(init?.headers);
        calls.push({ url: input, auth: h.get('Authorization'), account: h.get('Harvest-Account-Id') });
        return Response.json({ results: [{ client_name: 'Concorde', total_hours: 12.5 }], total_pages: 1, total_entries: 1, next_page: null });
      }
      return base(input);
    }));

    const res = await mcp(token, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'harvest_report_time', arguments: { group: 'clients', from: '2026-09-01', to: '2026-09-30' } },
    });
    const body = await res.json() as any;
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.items[0].client_name).toBe('Concorde');
    expect(payload.truncated).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/v2/reports/time/clients');
    expect(calls[0].url).toContain('from=20260901');
    expect(calls[0].auth).toBe(`Bearer ${HARVEST_ACCESS}`);
    expect(calls[0].account).toBe('999');
  });

  it('harvest_update_project sends only the fields provided', async () => {
    const token = await initialized();
    let sent: any;
    const base = harvestFetchMock();
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      if (input.startsWith('https://api.harvestapp.com/')) {
        sent = { url: input, method: init?.method, body: JSON.parse(String(init?.body)) };
        return Response.json({ id: 5, name: 'Renamed' });
      }
      return base(input);
    }));
    await mcp(token, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'harvest_update_project', arguments: { id: 5, name: 'Renamed' } },
    });
    expect(sent.method).toBe('PATCH');
    expect(sent.url).toBe('https://api.harvestapp.com/v2/projects/5');
    expect(sent.body).toEqual({ name: 'Renamed' });
  });
});

describe('Harvest token refresh inside tool calls', () => {
  async function setupExpired() {
    const { tokens } = await getTokens();
    const { KVSessionStore } = await import('../src/workers/kv-session-store.js');
    const store = new KVSessionStore(kv as never, { secret: env.SESSION_SECRET as string, ttlSeconds: 86400, maxLifetimeDays: 90 });
    const sessionKey = [...kv.store.keys()].find((k) => k.startsWith('session:'))!;
    const id = sessionKey.slice('session:'.length);
    const session = (await store.get(id))!;
    session.tokenExpiresAt = new Date(Date.now() - 1000);
    await store.set(id, session);
    return { token: tokens.access_token as string, store, id };
  }

  function stubRefresh(status: number) {
    const base = harvestFetchMock();
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (input.startsWith('https://id.getharvest.com/api/v2/oauth2/token')) {
        return status === 200
          ? Response.json({ access_token: 'NEW-ACCESS', refresh_token: 'NEW-REFRESH', token_type: 'bearer', expires_in: 1209600 })
          : new Response('err', { status });
      }
      if (input.startsWith('https://api.harvestapp.com/')) return Response.json({ name: 'Spotlight' });
      return base(input);
    }));
  }

  const callCompany = (token: string) => mcp(token, {
    jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'harvest_get_company', arguments: {} },
  });

  it('keeps the session on a transient refresh failure', async () => {
    const { token, store, id } = await setupExpired();
    stubRefresh(503);
    const body = await (await callCompany(token)).json() as any;
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/temporary/);
    expect((await store.get(id))!.harvestAccessToken).toBe(HARVEST_ACCESS);
  });

  it('clears the session when Harvest rejects the refresh grant', async () => {
    const { token, store, id } = await setupExpired();
    stubRefresh(400);
    await callCompany(token);
    expect((await store.get(id))!.harvestAccessToken).toBe('');
    expect((await callCompany(token)).status).toBe(401);
  });

  it('stores refreshed Harvest tokens encrypted', async () => {
    const { token, store, id } = await setupExpired();
    stubRefresh(200);
    const body = await (await callCompany(token)).json() as any;
    expect(body.result.isError).toBeFalsy();
    expect((await store.get(id))!.harvestAccessToken).toBe('NEW-ACCESS');
    expect([...kv.store.values()].join('\n')).not.toContain('NEW-ACCESS');
  });
});

describe('account allowlist fails closed', () => {
  it('admits nobody when the allowlist is empty outside development', async () => {
    env.ALLOWED_HARVEST_ACCOUNT_IDS = '';
    const { body: client } = await register();
    const authRes = await authorize(client.client_id);
    const state = new URL(authRes.headers.get('Location')!).searchParams.get('state')!;
    const res = await req(`/callback?code=harvest-code&state=${encodeURIComponent(state)}`);
    expect(new URL(res.headers.get('Location')!).searchParams.get('error')).toBe('access_denied');
  });

  it('revoking a refresh token ends the session (access token stops working too)', async () => {
    const { tokens } = await getTokens();
    await req('/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tokens.refresh_token }).toString(),
    });
    const call = await mcp(tokens.access_token, { jsonrpc: '2.0', method: 'initialize', id: 1, params: {} });
    expect(call.status).toBe(401);
  });
});
