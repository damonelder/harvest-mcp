/**
 * Harvest API v2 client
 * 
 * Features:
 * - Request caching, scoped per account + token, for reference data only
 *   (company, users, clients, contacts, projects, tasks...). Time entries,
 *   invoices, expenses and reports are always read live so a verification
 *   read after a write never sees stale data from another isolate.
 * - Rate limiting per Harvest account (general and Reports API buckets)
 * - Retries: GET and DELETE retry 5xx/network errors with backoff. Writes
 *   that could duplicate data (POST, PATCH adding invoice line items) are
 *   never replayed; 429s on writes are retried only within a short budget.
 * - Auto-pagination for list endpoints, with an explicit truncation flag
 * - _meta tracking for all responses
 */

import type {
  Company,
  User,
  UsersResponse,
  UserFilterParams,
  Client,
  ClientsResponse,
  Contact,
  ContactsResponse,
  ContactFilterParams,
  Project,
  ProjectsResponse,
  TimeEntry,
  TimeEntriesResponse,
  CreateTimeEntryParams,
  UpdateTimeEntryParams,
  Invoice,
  InvoicesResponse,
  CreateInvoiceParams,
  UpdateInvoiceLineItem,
  UpdateInvoiceParams,
  Expense,
  ExpensesResponse,
  Task,
  TasksResponse,
  ListParams,
  TimeEntryFilterParams,
  InvoiceFilterParams,
  ExpenseFilterParams,
  ApiMeta,
  WithMeta,
  AutoPaginateOptions,
  PaginatedResponse,
  Payload,
  TaskAssignment,
  TaskAssignmentsResponse,
  UserAssignment,
  UserAssignmentsResponse,
  ExpenseCategory,
  ExpenseCategoriesResponse,
  ReportParams,
  ReportResponse,
  TimeReportGroup,
  ExpenseReportGroup,
} from './types.js';
import { HarvestRateLimiter, getRateLimiter, type RateLimitConfig } from './rate-limiter.js';
import { HarvestCache, getCache, type CacheConfig } from './cache.js';

/**
 * Configuration options for HarvestClient
 */
export interface HarvestClientOptions {
  /** User-Agent header (default: 'HarvestMCP') */
  userAgent?: string;
  /** Enable response caching (default: true) */
  enableCache?: boolean;
  /** Cache configuration */
  cacheConfig?: Partial<CacheConfig>;
  /** Rate limiter configuration */
  rateLimitConfig?: Partial<RateLimitConfig>;
  /** Use shared singleton instances for cache and rate limiter (default: true) */
  useSharedInstances?: boolean;
}

const REPORTS_RATE_LIMIT = { maxRequests: 100, windowMs: 15 * 60 * 1000, warningThreshold: 0.9 };

/** Only slow-changing reference data is cached. */
const CACHEABLE_PREFIXES = [
  '/company', '/users', '/clients', '/contacts', '/projects', '/tasks',
  '/expense_categories', '/roles',
];

/** Seconds of 429 back-off a write may absorb before failing (MCP clients time out). */
const WRITE_RETRY_BUDGET_SECONDS = 15;

/** Knock-on invalidations: writing the key resource can change cached copies of these. */
const RELATED_RESOURCES: Record<string, string[]> = {
  clients: ['projects', 'contacts'],
  projects: ['users'],
  tasks: ['projects'],
};

export class HarvestApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public errorBody?: string
  ) {
    super(message);
    this.name = 'HarvestApiError';
  }

  get isRateLimited(): boolean {
    return this.statusCode === 429;
  }

  get isUnauthorized(): boolean {
    return this.statusCode === 401;
  }
}

export class HarvestClient {
  private baseUrl = 'https://api.harvestapp.com/v2';
  private accessToken: string;
  private accountId: string;
  private userAgent: string;
  private cache: HarvestCache | null;
  private rateLimiter: HarvestRateLimiter;
  private reportsRateLimiter: HarvestRateLimiter;
  private cacheScope: string;
  private apiCallsThisRequest: number = 0;

  constructor(
    accessToken: string,
    accountId: string,
    options: HarvestClientOptions = {}
  ) {
    this.accessToken = accessToken;
    this.accountId = accountId;
    this.userAgent = options.userAgent ?? 'HarvestMCP';
    this.cacheScope = HarvestCache.scopeFor(accountId, accessToken);
    
    // Initialize cache (can be disabled)
    const enableCache = options.enableCache ?? true;
    if (enableCache) {
      this.cache = options.useSharedInstances !== false
        ? getCache(options.cacheConfig)
        : new HarvestCache(options.cacheConfig);
    } else {
      this.cache = null;
    }
    
    // Initialize rate limiter
    this.rateLimiter = options.useSharedInstances !== false
      ? getRateLimiter(options.rateLimitConfig, accountId || 'default')
      : new HarvestRateLimiter(options.rateLimitConfig);
    // Harvest's Reports API has its own, much lower limit (100 per 15 minutes).
    this.reportsRateLimiter = options.useSharedInstances !== false
      ? getRateLimiter(REPORTS_RATE_LIMIT, `${accountId || 'default'}:reports`)
      : new HarvestRateLimiter(REPORTS_RATE_LIMIT);
  }


  /**
   * Delay execution for given milliseconds
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Build _meta object for response tracking
   */
  private buildMeta(cached: boolean, cacheAge?: number): ApiMeta {
    const status = this.rateLimiter.getStatus();
    const meta: ApiMeta = {
      api_calls_made: this.apiCallsThisRequest,
      cached,
      rate_limit_remaining: status.remaining,
    };
    if (cacheAge !== undefined) {
      meta.cache_age_seconds = cacheAge;
    }
    return meta;
  }

  /**
   * Reset API call counter (call at start of each tool invocation)
   */
  resetApiCallCount(): void {
    this.apiCallsThisRequest = 0;
  }

  /**
   * Get current rate limit status
   */
  getRateLimitStatus() {
    return this.rateLimiter.getStatus();
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return this.cache?.getStats() ?? null;
  }


  /**
   * Make a GET request and return response with _meta
   */
  private async get<T>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>
  ): Promise<WithMeta<T>> {
    const result = await this.request<T>('GET', path, undefined, params);
    return {
      ...result.data,
      _meta: this.buildMeta(result.cached, result.cacheAge),
    } as WithMeta<T>;
  }

  /**
   * Make a POST request and return response with _meta
   */
  private async post<T>(
    path: string,
    body?: Record<string, unknown>
  ): Promise<WithMeta<T>> {
    const result = await this.request<T>('POST', path, body);
    return {
      ...result.data,
      _meta: this.buildMeta(result.cached),
    } as WithMeta<T>;
  }

  /**
   * Make a PATCH request and return response with _meta
   */
  private async patch<T>(
    path: string,
    body?: Record<string, unknown>
  ): Promise<WithMeta<T>> {
    const result = await this.request<T>('PATCH', path, body);
    return {
      ...result.data,
      _meta: this.buildMeta(result.cached),
    } as WithMeta<T>;
  }

  /**
   * Make a DELETE request
   */
  private async delete(path: string): Promise<void> {
    await this.request<void>('DELETE', path);
  }

  /**
   * Auto-paginate through a list endpoint, collecting all results.
   *
   * `truncated` is true when the page cap stopped collection before the last
   * page; callers must surface that rather than present partial totals as
   * complete.
   */
  async autoPaginate<T, R extends PaginatedResponse<T>>(
    endpoint: (params: ListParams) => Promise<WithMeta<R>>,
    params: ListParams = {},
    options: AutoPaginateOptions = {}
  ): Promise<WithMeta<{
    items: T[];
    total_entries: number;
    total_pages: number;
    pages_fetched: number;
    truncated: boolean;
    truncation_warning?: string;
  }>> {
    const { maxPages = 10, perPage = 100, onPage, itemsKey } = options;
    const allItems: T[] = [];
    let pagesFetched = 0;
    let totalEntries: number | undefined;
    let totalPages = 1;
    let hasMore = false;
    let nextParams: ListParams = { ...params, page: 1, per_page: perPage };

    this.resetApiCallCount();

    while (pagesFetched < maxPages) {
      const response = await endpoint(nextParams);
      pagesFetched++;

      const responseObj = response as unknown as Record<string, unknown>;
      const key = itemsKey ?? Object.keys(responseObj).find((k) =>
        Array.isArray(responseObj[k]) && k !== '_meta'
      );
      if (key && Array.isArray(responseObj[key])) {
        allItems.push(...(responseObj[key] as T[]));
      }

      if (typeof response.total_entries === 'number') totalEntries = response.total_entries;
      if (typeof response.total_pages === 'number') totalPages = response.total_pages;

      if (onPage) onPage(pagesFetched, totalPages);

      // Prefer links.next: Harvest's cursor-paginated endpoints leave
      // next_page null on middle pages but always populate links.next.
      const nextLink = response.links?.next;
      if (nextLink) {
        const linkParams = Object.fromEntries(new URL(nextLink).searchParams.entries());
        nextParams = { ...params, ...linkParams, per_page: perPage };
        hasMore = true;
      } else if (response.next_page) {
        nextParams = { ...params, page: response.next_page, per_page: perPage };
        hasMore = true;
      } else {
        hasMore = false;
      }
      if (!hasMore) break;
    }

    const total = totalEntries ?? allItems.length;
    // Cross-check against total_entries in case pagination metadata is incomplete.
    const truncated = hasMore || allItems.length < total;
    return {
      items: allItems,
      total_entries: total,
      total_pages: totalPages,
      pages_fetched: pagesFetched,
      truncated,
      ...(truncated
        ? {
            truncation_warning:
              `Results truncated: fetched ${allItems.length} of ${total} records ` +
              `(${pagesFetched} of ${totalPages} pages). Narrow the date range or filters.`,
          }
        : {}),
      _meta: this.buildMeta(false),
    };
  }

  /** Exponential backoff with jitter: ~0.5s, 1s, 2s ... */
  private backoffMs(attempt: number): number {
    return 500 * 2 ** attempt + Math.floor(Math.random() * 250);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    params?: Record<string, string | number | boolean | undefined>,
    options: { skipCache?: boolean; maxRetries?: number } = {}
  ): Promise<{ data: T; cached: boolean; cacheAge?: number }> {
    const { skipCache = false, maxRetries = 3 } = options;
    const isGetRequest = method === 'GET';
    const isReport = path.startsWith('/reports');
    const limiter = isReport ? this.reportsRateLimiter : this.rateLimiter;
    // Safe to replay after a 5xx or network error? POST can create a second
    // record, and a PATCH carrying line items without IDs appends them again.
    const addsLineItems = Array.isArray(body?.line_items) &&
      (body!.line_items as Array<Record<string, unknown>>).some((li) => li && li.id === undefined);
    const isIdempotent = method === 'GET' || method === 'DELETE' ||
      (method === 'PATCH' && !addsLineItems);
    const mayDuplicate = !isIdempotent;
    const isCacheable = isGetRequest && CACHEABLE_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`));
    const cacheKey = isCacheable && this.cache && !skipCache
      ? HarvestCache.generateKey(this.cacheScope, path, params as Record<string, unknown>)
      : null;
    let writeBackoffSpent = 0;
    let priorAttemptMayHaveApplied = false;

    if (cacheKey && this.cache) {
      const cached = this.cache.get<T>(cacheKey);
      if (cached) {
        const cacheAge = this.cache.getAge(cacheKey);
        return { data: cached.data, cached: true, cacheAge };
      }
    }

    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      });
    }

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Harvest-Account-Id': this.accountId,
      'User-Agent': this.userAgent,
      'Accept': 'application/json',
    };

    const fetchOptions: RequestInit = { method, headers };
    if (body) {
      headers['Content-Type'] = 'application/json';
      fetchOptions.body = JSON.stringify(body);
    }

    const uncertainWrite = (detail: string) => new HarvestApiError(
      `${detail} during ${method} ${path}. The change may or may not have been applied; ` +
      'check Harvest before retrying.',
      0
    );

    let lastError: Error | null = null;
    try {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const isLastAttempt = attempt === maxRetries - 1;
      const waitMs = await limiter.acquirePermit();
      if (waitMs > 0) {
        if (isReport && waitMs > 5000) {
          throw new HarvestApiError(
            `Harvest Reports API limit reached (100 requests per 15 minutes). Try again in ${Math.ceil(waitMs / 1000)}s.`,
            429
          );
        }
        await this.delay(waitMs);
      }

      limiter.recordRequest();
      this.apiCallsThisRequest++;

      let response: Response;
      try {
        response = await fetch(url.toString(), fetchOptions);
      } catch (networkError) {
        if (mayDuplicate) throw uncertainWrite('Network error');
        lastError = networkError as Error;
        priorAttemptMayHaveApplied = true;
        if (!isLastAttempt) await this.delay(this.backoffMs(attempt));
        continue;
      }

      if (response.status === 429) {
        const parsed = parseInt(response.headers.get('Retry-After') || '', 10);
        const retryAfter = Number.isFinite(parsed) && parsed > 0 ? parsed : 15;
        limiter.handleRateLimit(retryAfter);
        lastError = new HarvestApiError(`Harvest rate limit reached; retry after ${retryAfter}s`, 429);
        // Reports limits reset slowly, and writes must finish before the MCP
        // client gives up and re-sends the call: fail fast in both cases.
        if (isReport) throw lastError;
        if (!isGetRequest) {
          if (writeBackoffSpent + retryAfter > WRITE_RETRY_BUDGET_SECONDS) throw lastError;
          writeBackoffSpent += retryAfter;
        }
        if (!isLastAttempt) await this.delay(Math.min(retryAfter, 60) * 1000);
        continue;
      }

      if (response.status >= 500 && isIdempotent && !isLastAttempt) {
        lastError = new HarvestApiError(
          `Harvest API error: ${response.status} ${response.statusText}`,
          response.status,
          await response.text().catch(() => undefined)
        );
        priorAttemptMayHaveApplied = true;
        await this.delay(this.backoffMs(attempt));
        continue;
      }

      // A retried DELETE that finds nothing means the first attempt succeeded.
      if (response.status === 404 && method === 'DELETE' && priorAttemptMayHaveApplied) {
        return { data: undefined as T, cached: false };
      }

      if (response.status >= 500 && mayDuplicate) {
        throw uncertainWrite(`Harvest returned ${response.status}`);
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => undefined);
        throw new HarvestApiError(
          `Harvest API error: ${response.status} ${response.statusText}`,
          response.status,
          errorBody
        );
      }

      if (response.status === 204) {
        return { data: undefined as T, cached: false };
      }

      const text = await response.text();
      const data = (text ? JSON.parse(text) : undefined) as T;

      if (cacheKey && this.cache) {
        this.cache.set(cacheKey, data);
      }

      return { data, cached: false };
    }

    throw lastError || new Error('Request failed after retries');
    } finally {
      // Invalidate after every write attempt, successful or not: a failed
      // write may still have been applied.
      this.invalidateAfterWrite(method, path);
    }
  }

  /** Drop cached reads that a write could have changed. */
  private invalidateAfterWrite(method: string, path: string): void {
    if (method === 'GET' || !this.cache) return;
    const resourceType = path.split('/')[1];
    if (!resourceType) return;
    for (const r of [resourceType, ...(RELATED_RESOURCES[resourceType] ?? [])]) {
      this.cache.invalidate(`|/${r}`);
    }
  }

  // ============================================
  // Company & Users
  // ============================================
  
  async getCompany(): Promise<WithMeta<Company>> {
    return this.get<Company>('/company');
  }

  async getCurrentUser(): Promise<WithMeta<User>> {
    return this.get<User>('/users/me');
  }

  async listUsers(params?: UserFilterParams): Promise<WithMeta<UsersResponse>> {
    return this.get<UsersResponse>('/users', params);
  }

  async getUser(id: number): Promise<WithMeta<User>> {
    return this.get<User>(`/users/${id}`);
  }

  // ============================================
  // Clients
  // ============================================
  
  async listClients(params?: ListParams): Promise<WithMeta<ClientsResponse>> {
    return this.get<ClientsResponse>('/clients', params);
  }

  async getClient(id: number): Promise<WithMeta<Client>> {
    return this.get<Client>(`/clients/${id}`);
  }

  async createClient(data: { name: string; is_active?: boolean; address?: string; currency?: string }): Promise<WithMeta<Client>> {
    return this.post<Client>('/clients', data);
  }

  async updateClient(id: number, data: Partial<{ name: string; is_active: boolean; address: string; currency: string }>): Promise<WithMeta<Client>> {
    return this.patch<Client>(`/clients/${id}`, data);
  }

  async deleteClient(id: number): Promise<void> {
    return this.delete(`/clients/${id}`);
  }

  // ============================================
  // Client Contacts
  // ============================================

  async listContacts(params?: ContactFilterParams): Promise<WithMeta<ContactsResponse>> {
    return this.get<ContactsResponse>('/contacts', params);
  }

  async getContact(id: number): Promise<WithMeta<Contact>> {
    return this.get<Contact>(`/contacts/${id}`);
  }

  // ============================================
  // Projects
  // ============================================
  
  async listProjects(params?: ListParams & { client_id?: number; is_active?: boolean }): Promise<WithMeta<ProjectsResponse>> {
    return this.get<ProjectsResponse>('/projects', params);
  }

  async getProject(id: number): Promise<WithMeta<Project>> {
    return this.get<Project>(`/projects/${id}`);
  }

  // ============================================
  // Tasks
  // ============================================
  
  async listTasks(params?: ListParams): Promise<WithMeta<TasksResponse>> {
    return this.get<TasksResponse>('/tasks', params);
  }

  async getTask(id: number): Promise<WithMeta<Task>> {
    return this.get<Task>(`/tasks/${id}`);
  }

  // ============================================
  // Time Entries
  // ============================================
  
  async listTimeEntries(params?: TimeEntryFilterParams): Promise<WithMeta<TimeEntriesResponse>> {
    return this.get<TimeEntriesResponse>('/time_entries', params);
  }

  async getTimeEntry(id: number): Promise<WithMeta<TimeEntry>> {
    return this.get<TimeEntry>(`/time_entries/${id}`);
  }

  async createTimeEntry(data: CreateTimeEntryParams): Promise<WithMeta<TimeEntry>> {
    return this.post<TimeEntry>('/time_entries', data);
  }

  async updateTimeEntry(id: number, data: UpdateTimeEntryParams): Promise<WithMeta<TimeEntry>> {
    return this.patch<TimeEntry>(`/time_entries/${id}`, data);
  }

  async deleteTimeEntry(id: number): Promise<void> {
    return this.delete(`/time_entries/${id}`);
  }

  async restartTimeEntry(id: number): Promise<WithMeta<TimeEntry>> {
    return this.patch<TimeEntry>(`/time_entries/${id}/restart`);
  }

  async stopTimeEntry(id: number): Promise<WithMeta<TimeEntry>> {
    return this.patch<TimeEntry>(`/time_entries/${id}/stop`);
  }

  // ============================================
  // Invoices
  // ============================================
  
  async listInvoices(params?: InvoiceFilterParams): Promise<WithMeta<InvoicesResponse>> {
    return this.get<InvoicesResponse>('/invoices', params);
  }

  async getInvoice(id: number): Promise<WithMeta<Invoice>> {
    return this.get<Invoice>(`/invoices/${id}`);
  }

  async createInvoice(data: CreateInvoiceParams): Promise<WithMeta<Invoice>> {
    return this.post<Invoice>('/invoices', data as unknown as Record<string, unknown>);
  }

  async updateInvoiceLineItems(
    id: number,
    lineItems: UpdateInvoiceLineItem[]
  ): Promise<WithMeta<Invoice>> {
    return this.patch<Invoice>(`/invoices/${id}`, { line_items: lineItems });
  }

  async updateInvoice(id: number, data: UpdateInvoiceParams): Promise<WithMeta<Invoice>> {
    return this.patch<Invoice>(`/invoices/${id}`, data as unknown as Record<string, unknown>);
  }

  async deleteInvoice(id: number): Promise<void> {
    return this.delete(`/invoices/${id}`);
  }

  // ============================================
  // Expenses
  // ============================================
  
  async listExpenses(params?: ExpenseFilterParams): Promise<WithMeta<ExpensesResponse>> {
    return this.get<ExpensesResponse>('/expenses', params);
  }

  async getExpense(id: number): Promise<WithMeta<Expense>> {
    return this.get<Expense>(`/expenses/${id}`);
  }

  // ============================================
  // Administrative writes: clients, contacts, projects, tasks
  // ============================================

  async createContact(data: Payload): Promise<WithMeta<Contact>> {
    return this.post<Contact>('/contacts', data);
  }

  async updateContact(id: number, data: Payload): Promise<WithMeta<Contact>> {
    return this.patch<Contact>(`/contacts/${id}`, data);
  }

  async createProject(data: Payload): Promise<WithMeta<Project>> {
    return this.post<Project>('/projects', data);
  }

  async updateProject(id: number, data: Payload): Promise<WithMeta<Project>> {
    return this.patch<Project>(`/projects/${id}`, data);
  }

  async createTask(data: Payload): Promise<WithMeta<Task>> {
    return this.post<Task>('/tasks', data);
  }

  async updateTask(id: number, data: Payload): Promise<WithMeta<Task>> {
    return this.patch<Task>(`/tasks/${id}`, data);
  }

  async listProjectTaskAssignments(projectId: number, params?: ListParams): Promise<WithMeta<TaskAssignmentsResponse>> {
    return this.get<TaskAssignmentsResponse>(`/projects/${projectId}/task_assignments`, params);
  }

  async createProjectTaskAssignment(projectId: number, data: Payload): Promise<WithMeta<TaskAssignment>> {
    return this.post<TaskAssignment>(`/projects/${projectId}/task_assignments`, data);
  }

  async listProjectUserAssignments(projectId: number, params?: ListParams): Promise<WithMeta<UserAssignmentsResponse>> {
    return this.get<UserAssignmentsResponse>(`/projects/${projectId}/user_assignments`, params);
  }

  async createProjectUserAssignment(projectId: number, data: Payload): Promise<WithMeta<UserAssignment>> {
    return this.post<UserAssignment>(`/projects/${projectId}/user_assignments`, data);
  }

  // ============================================
  // Expenses (writes) and expense categories
  // ============================================

  async createExpense(data: Payload): Promise<WithMeta<Expense>> {
    return this.post<Expense>('/expenses', data);
  }

  async updateExpense(id: number, data: Payload): Promise<WithMeta<Expense>> {
    return this.patch<Expense>(`/expenses/${id}`, data);
  }

  async deleteExpense(id: number): Promise<void> {
    return this.delete(`/expenses/${id}`);
  }

  async listExpenseCategories(params?: ListParams): Promise<WithMeta<ExpenseCategoriesResponse>> {
    return this.get<ExpenseCategoriesResponse>('/expense_categories', params);
  }

  async getExpenseCategory(id: number): Promise<WithMeta<ExpenseCategory>> {
    return this.get<ExpenseCategory>(`/expense_categories/${id}`);
  }

  // ============================================
  // Reports API (aggregated server-side by Harvest)
  // ============================================

  /** Harvest report dates use YYYYMMDD. Accepts YYYY-MM-DD or YYYYMMDD. */
  static toReportDate(date: string): string {
    const compact = date.replace(/-/g, '');
    if (!/^\d{8}$/.test(compact)) {
      throw new Error(`Invalid date "${date}"; expected YYYY-MM-DD`);
    }
    return compact;
  }

  private reportParams(params: ReportParams): ListParams {
    return {
      ...params,
      from: HarvestClient.toReportDate(params.from),
      to: HarvestClient.toReportDate(params.to),
    };
  }

  async getTimeReport(group: TimeReportGroup, params: ReportParams): Promise<WithMeta<ReportResponse>> {
    return this.get<ReportResponse>(`/reports/time/${group}`, this.reportParams(params));
  }

  async getExpenseReport(group: ExpenseReportGroup, params: ReportParams): Promise<WithMeta<ReportResponse>> {
    return this.get<ReportResponse>(`/reports/expenses/${group}`, this.reportParams(params));
  }

  async getUninvoicedReport(params: ReportParams): Promise<WithMeta<ReportResponse>> {
    return this.get<ReportResponse>('/reports/uninvoiced', this.reportParams(params));
  }

  async getProjectBudgetReport(params: ListParams & { is_active?: boolean } = {}): Promise<WithMeta<ReportResponse>> {
    return this.get<ReportResponse>('/reports/project_budget', params);
  }
}
