import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HarvestClient, HarvestApiError } from '../src/harvest/client.js';
import { resetCache } from '../src/harvest/cache.js';
import { resetRateLimiter } from '../src/harvest/rate-limiter.js';

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function page(n: number, totalPages: number, perPage: number) {
  return {
    time_entries: Array.from({ length: perPage }, (_, i) => ({ id: (n - 1) * perPage + i })),
    per_page: perPage,
    total_pages: totalPages,
    total_entries: totalPages * perPage,
    page: n,
    next_page: n < totalPages ? n + 1 : null,
    previous_page: n > 1 ? n - 1 : null,
    links: {},
  };
}

function makeClient(token = 'tok-a', account = '111') {
  const client = new HarvestClient(token, account);
  // Skip real backoff/Retry-After sleeps in tests.
  (client as unknown as { delay: () => Promise<void> }).delay = async () => {};
  return client;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetCache();
  resetRateLimiter();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('autoPaginate', () => {
  it('flags truncation when the page cap is hit', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const p = Number(new URL(url).searchParams.get('page'));
      return json(page(p, 5, 2));
    });
    const client = makeClient();
    const result = await client.autoPaginate((p) => client.listTimeEntries(p), {}, { maxPages: 3, perPage: 2 });
    expect(result.items).toHaveLength(6);
    expect(result.pages_fetched).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.truncation_warning).toContain('6 of 10');
  });

  it('is not truncated when all pages are read', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const p = Number(new URL(url).searchParams.get('page'));
      return json(page(p, 3, 2));
    });
    const client = makeClient();
    const result = await client.autoPaginate((p) => client.listTimeEntries(p), {}, { maxPages: 3, perPage: 2 });
    expect(result.items).toHaveLength(6);
    expect(result.pages_fetched).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.truncation_warning).toBeUndefined();
  });

  it('passes per_page through to Harvest', async () => {
    fetchMock.mockResolvedValue(json(page(1, 1, 1)));
    const client = makeClient();
    await client.autoPaginate((p) => client.listTimeEntries(p), {}, { perPage: 2000 });
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('per_page')).toBe('2000');
  });
});

describe('cursor pagination', () => {
  it('follows links.next when next_page is null on middle pages', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const cursor = new URL(url).searchParams.get('cursor');
      const n = cursor ? Number(cursor) : 1;
      return json({
        time_entries: [{ id: n }],
        total_entries: 3,
        total_pages: 3,
        next_page: n === 1 ? 2 : null,
        links: { next: n < 3 ? `https://api.harvestapp.com/v2/time_entries?cursor=${n + 1}&per_page=1` : null },
      });
    });
    const client = makeClient();
    const result = await client.autoPaginate((p) => client.listTimeEntries(p), {}, { maxPages: 10, perPage: 1 });
    expect(result.items.map((i: any) => i.id)).toEqual([1, 2, 3]);
    expect(result.truncated).toBe(false);
  });

  it('flags truncation if fewer items arrive than total_entries reports', async () => {
    fetchMock.mockResolvedValue(json({ time_entries: [{ id: 1 }], total_entries: 5, total_pages: 1, next_page: null, links: { next: null } }));
    const client = makeClient();
    const result = await client.autoPaginate((p) => client.listTimeEntries(p), {}, { maxPages: 10 });
    expect(result.truncated).toBe(true);
  });
});

describe('retry policy', () => {
  it('retries a GET after a 503', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(json({ name: 'Spotlight' }));
    const company = await makeClient().getCompany();
    expect(company.name).toBe('Spotlight');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a GET after a network error', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(json({ name: 'Spotlight' }));
    await makeClient().getCompany();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never replays a POST after a 5xx, and warns it may have been applied', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 502 }));
    await expect(
      makeClient().createTimeEntry({ project_id: 1, task_id: 2, spent_date: '2026-10-01', hours: 1 })
    ).rejects.toThrow(/may or may not have been applied/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never replays a PATCH that appends invoice line items', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 502 }));
    await expect(
      makeClient().updateInvoiceLineItems(7, [{ kind: 'Service', unit_price: 100, quantity: 1 } as never])
    ).rejects.toThrow(/may or may not have been applied/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a plain PATCH after a 5xx', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockResolvedValueOnce(json({ id: 3, hours: 2 }));
    await makeClient().updateTimeEntry(3, { hours: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats a 404 on a retried DELETE as success', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('boom', { status: 502 }))
      .mockResolvedValueOnce(new Response('not found', { status: 404 }));
    await expect(makeClient().deleteTimeEntry(3)).resolves.toBeUndefined();
  });

  it('fails a write fast when Harvest asks for a long back-off', async () => {
    fetchMock.mockResolvedValue(new Response('slow', { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(
      makeClient().createTimeEntry({ project_id: 1, task_id: 2, spent_date: '2026-10-01', hours: 1 })
    ).rejects.toThrow(/rate limit/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails a report fast on 429 instead of waiting out the long reports window', async () => {
    fetchMock.mockResolvedValue(new Response('slow', { status: 429, headers: { 'Retry-After': '300' } }));
    await expect(makeClient().getTimeReport('clients', { from: '2026-10-01', to: '2026-10-31' })).rejects.toThrow(/retry after 300s/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never replays a POST after a network error, and says so', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'));
    await expect(
      makeClient().createTimeEntry({ project_id: 1, task_id: 2, spent_date: '2026-10-01', hours: 1 })
    ).rejects.toThrow(/may or may not have been applied/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a POST after a 429 (Harvest rejected it)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(json({ id: 9 }, 201));
    const entry = await makeClient().createTimeEntry({ project_id: 1, task_id: 2, spent_date: '2026-10-01', hours: 1 });
    expect(entry.id).toBe(9);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx and surfaces the error body', async () => {
    fetchMock.mockResolvedValue(new Response('{"message":"bad project"}', { status: 422 }));
    const err = await makeClient().getCompany().catch((e) => e);
    expect(err).toBeInstanceOf(HarvestApiError);
    expect(err.errorBody).toContain('bad project');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('cache scoping', () => {
  it('does not serve one token holder another holder\'s cached response', async () => {
    fetchMock.mockImplementation(async () => json({ name: 'x' }));
    await makeClient('token-user-1', '111').getCompany();
    await makeClient('token-user-2', '111').getCompany();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('always reads time entries live (no cache)', async () => {
    fetchMock.mockImplementation(async () => json({ time_entries: [], total_pages: 1, next_page: null }));
    const client = makeClient();
    await client.listTimeEntries({ from: '2026-10-01' });
    await client.listTimeEntries({ from: '2026-10-01' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serves repeat reads for the same caller from cache', async () => {
    fetchMock.mockImplementation(async () => json({ name: 'x' }));
    await makeClient('token-user-1', '111').getCompany();
    const second = await makeClient('token-user-1', '111').getCompany();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second._meta.cached).toBe(true);
  });

  it('invalidates cached reports after a write', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST' ? json({ id: 1 }, 201) : json({ results: [], total_pages: 1, next_page: null })
    );
    const client = makeClient();
    await client.getTimeReport('clients', { from: '2026-10-01', to: '2026-10-31' });
    await client.createTimeEntry({ project_id: 1, task_id: 2, spent_date: '2026-10-01', hours: 1 });
    await client.getTimeReport('clients', { from: '2026-10-01', to: '2026-10-31' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('reports', () => {
  it('formats report dates as YYYYMMDD', async () => {
    fetchMock.mockResolvedValue(json({ results: [] }));
    await makeClient().getTimeReport('projects', { from: '2026-09-01', to: '2026-09-30' });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/v2/reports/time/projects');
    expect(url.searchParams.get('from')).toBe('20260901');
    expect(url.searchParams.get('to')).toBe('20260930');
  });

  it('rejects malformed dates before calling Harvest', async () => {
    await expect(makeClient().getUninvoicedReport({ from: 'Sept 1', to: '2026-09-30' })).rejects.toThrow(/YYYY-MM-DD/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
