/**
 * Harvest API v2 client
 * 
 * Features:
 * - Request caching with LRU eviction
 * - Rate limiting to prevent 429 errors
 * - Auto-pagination for list endpoints
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
  private apiCallsThisRequest: number = 0;

  constructor(
    accessToken: string,
    accountId: string,
    options: HarvestClientOptions = {}
  ) {
    this.accessToken = accessToken;
    this.accountId = accountId;
    this.userAgent = options.userAgent ?? 'HarvestMCP';
    
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
      ? getRateLimiter(options.rateLimitConfig)
      : new HarvestRateLimiter(options.rateLimitConfig);
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
   * Auto-paginate through a list endpoint, collecting all results
   */
  async autoPaginate<T, R extends PaginatedResponse<T>>(
    endpoint: (params: ListParams) => Promise<WithMeta<R>>,
    params: ListParams = {},
    options: AutoPaginateOptions = {}
  ): Promise<WithMeta<{ items: T[]; total_entries: number; pages_fetched: number }>> {
    const { maxPages = 10, perPage = 100, onPage } = options;
    const allItems: T[] = [];
    let page = 1;
    let totalEntries = 0;
    let totalPages = 1;
    
    this.resetApiCallCount();
    
    while (page <= maxPages && page <= totalPages) {
      const response = await endpoint({ ...params, page, per_page: perPage });
      
      // Extract items from the response (handles different response shapes)
      const responseObj = response as unknown as Record<string, unknown>;
      const itemsKey = Object.keys(responseObj).find(key => 
        Array.isArray(responseObj[key]) && key !== '_meta'
      );
      if (itemsKey) {
        allItems.push(...(responseObj[itemsKey] as T[]));
      }
      
      totalEntries = response.total_entries;
      totalPages = response.total_pages;
      
      if (onPage) {
        onPage(page, totalPages);
      }
      
      if (response.next_page === null) {
        break;
      }
      
      page++;
    }
    
    return {
      items: allItems,
      total_entries: totalEntries,
      pages_fetched: page,
      _meta: this.buildMeta(false),
    };
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
    
    // Check cache for GET requests
    if (isGetRequest && this.cache && !skipCache) {
      const cacheKey = HarvestCache.generateKey(path, params as Record<string, unknown>);
      const cached = this.cache.get<T>(cacheKey);
      if (cached) {
        const cacheAge = this.cache.getAge(cacheKey);
        return { data: cached.data, cached: true, cacheAge };
      }
    }

    // Build URL
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      });
    }

    // Request headers
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Harvest-Account-Id': this.accountId,
      'User-Agent': this.userAgent,
      'Accept': 'application/json',
    };

    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    if (body) {
      headers['Content-Type'] = 'application/json';
      fetchOptions.body = JSON.stringify(body);
    }

    // Execute with rate limiting and retry logic
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Acquire rate limit permit
      const waitMs = await this.rateLimiter.acquirePermit();
      if (waitMs > 0) {
        await this.delay(waitMs);
      }

      try {
        this.rateLimiter.recordRequest();
        this.apiCallsThisRequest++;
        
        const response = await fetch(url.toString(), fetchOptions);

        // Handle rate limiting
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('Retry-After') || '15', 10);
          this.rateLimiter.handleRateLimit(retryAfter);
          lastError = new HarvestApiError(
            `Rate limited, retry after ${retryAfter}s`,
            429
          );
          await this.delay(retryAfter * 1000);
          continue;
        }

        if (!response.ok) {
          const errorBody = await response.text();
          throw new HarvestApiError(
            `Harvest API error: ${response.status} ${response.statusText}`,
            response.status,
            errorBody
          );
        }

        // Handle 204 No Content
        if (response.status === 204) {
          return { data: undefined as T, cached: false };
        }

        const data = await response.json() as T;

        // Cache GET responses
        if (isGetRequest && this.cache && !skipCache) {
          const cacheKey = HarvestCache.generateKey(path, params as Record<string, unknown>);
          this.cache.set(cacheKey, data);
        }

        // Invalidate cache on write operations
        if (!isGetRequest && this.cache) {
          // Extract resource type from path (e.g., /time_entries -> time_entries)
          const resourceType = path.split('/')[1];
          if (resourceType) {
            this.cache.invalidate(new RegExp(`^/${resourceType}`));
          }
        }

        return { data, cached: false };
      } catch (error) {
        if (error instanceof HarvestApiError && !error.isRateLimited) {
          throw error;
        }
        lastError = error as Error;
      }
    }

    throw lastError || new Error('Request failed after retries');
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

  // ============================================
  // Expenses
  // ============================================
  
  async listExpenses(params?: ExpenseFilterParams): Promise<WithMeta<ExpensesResponse>> {
    return this.get<ExpensesResponse>('/expenses', params);
  }

  async getExpense(id: number): Promise<WithMeta<Expense>> {
    return this.get<Expense>(`/expenses/${id}`);
  }
}
