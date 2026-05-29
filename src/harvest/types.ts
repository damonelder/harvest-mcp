/**
 * Harvest API v2 type definitions
 */

// API metadata for tracking requests
export interface ApiMeta {
  api_calls_made: number;
  cached: boolean;
  cache_age_seconds?: number;
  rate_limit_remaining?: number;
}


/**
 * Wrapper type that adds _meta to any response
 */
export type WithMeta<T> = T & { _meta: ApiMeta };

/**
 * Options for paginated requests with auto-pagination
 */
export interface AutoPaginateOptions {
  /** Maximum number of pages to fetch (default: 10) */
  maxPages?: number;
  /** Results per page (default: 100, max: 2000) */
  perPage?: number;
  /** Callback for progress updates */
  onPage?: (pageNum: number, totalPages: number) => void;
}

// Base pagination response
export interface PaginatedResponse<T> {
  per_page: number;
  total_pages: number;
  total_entries: number;
  next_page: number | null;
  previous_page: number | null;
  page: number;
  links: {
    first: string;
    next: string | null;
    previous: string | null;
    last: string;
  };
}

// Company
export interface Company {
  base_uri: string;
  full_domain: string;
  name: string;
  is_active: boolean;
  week_start_day: string;
  wants_timestamp_timers: boolean;
  time_format: string;
  date_format: string;
  plan_type: string;
  expense_feature: boolean;
  invoice_feature: boolean;
  estimate_feature: boolean;
  approval_feature: boolean;
  clock: string;
  currency_code_display: string;
  currency_symbol_display: string;
  decimal_symbol: string;
  thousands_separator: string;
  color_scheme: string;
  weekly_capacity: number;
}

// User
export interface User {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  telephone: string;
  timezone: string;
  has_access_to_all_future_projects: boolean;
  is_contractor: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  weekly_capacity: number;
  default_hourly_rate: number | null;
  cost_rate: number | null;
  roles: string[];
  access_roles: string[];
  avatar_url: string;
}


export interface UsersResponse extends PaginatedResponse<User> {
  users: User[];
}

export interface UserFilterParams extends ListParams {
  is_active?: boolean;
  updated_since?: string;
}

// Client
export interface Client {
  id: number;
  name: string;
  is_active: boolean;
  address: string | null;
  statement_key: string;
  currency: string;
  created_at: string;
  updated_at: string;
}

export interface ClientsResponse extends PaginatedResponse<Client> {
  clients: Client[];
}

// Client Contact (contacts associated with clients)
export interface Contact {
  id: number;
  title: string | null;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone_office: string | null;
  phone_mobile: string | null;
  fax: string | null;
  created_at: string;
  updated_at: string;
  client: { id: number; name: string };
}

export interface ContactsResponse extends PaginatedResponse<Contact> {
  contacts: Contact[];
}

export interface ContactFilterParams extends ListParams {
  client_id?: number;
}

// Project
export interface Project {
  id: number;
  name: string;
  code: string | null;
  is_active: boolean;
  is_billable: boolean;
  is_fixed_fee: boolean;
  bill_by: string;
  hourly_rate: number | null;
  budget: number | null;
  budget_by: string;
  budget_is_monthly: boolean;
  notify_when_over_budget: boolean;
  over_budget_notification_percentage: number;
  show_budget_to_all: boolean;
  created_at: string;
  updated_at: string;
  starts_on: string | null;
  ends_on: string | null;
  over_budget_notification_date: string | null;
  notes: string | null;
  cost_budget: number | null;
  cost_budget_include_expenses: boolean;
  fee: number | null;
  client: { id: number; name: string; currency: string };
}

export interface ProjectsResponse extends PaginatedResponse<Project> {
  projects: Project[];
}

// Time Entry
export interface TimeEntry {
  id: number;
  spent_date: string;
  hours: number;
  hours_without_timer: number;
  rounded_hours: number;
  notes: string | null;
  is_locked: boolean;
  locked_reason: string | null;
  is_closed: boolean;
  is_billed: boolean;
  timer_started_at: string | null;
  started_time: string | null;
  ended_time: string | null;
  is_running: boolean;
  billable: boolean;
  budgeted: boolean;
  billable_rate: number | null;
  cost_rate: number | null;
  created_at: string;
  updated_at: string;
  user: { id: number; name: string };
  client: { id: number; name: string };
  project: { id: number; name: string; code: string | null };
  task: { id: number; name: string };
  user_assignment: {
    id: number;
    is_project_manager: boolean;
    is_active: boolean;
    budget: number | null;
    created_at: string;
    updated_at: string;
    hourly_rate: number | null;
  };
  task_assignment: {
    id: number;
    billable: boolean;
    is_active: boolean;
    created_at: string;
    updated_at: string;
    hourly_rate: number | null;
    budget: number | null;
  };
  invoice: { id: number; number: string } | null;
  external_reference: { id: string; group_id: string; permalink: string; service: string; service_icon_url: string } | null;
}

export interface TimeEntriesResponse extends PaginatedResponse<TimeEntry> {
  time_entries: TimeEntry[];
}

export interface CreateTimeEntryParams {
  project_id: number;
  task_id: number;
  spent_date: string;
  user_id?: number;
  hours?: number;
  notes?: string;
  started_time?: string;
  ended_time?: string;
  external_reference?: {
    id: string;
    group_id: string;
    permalink: string;
  };
  [key: string]: unknown;
}

export interface UpdateTimeEntryParams {
  project_id?: number;
  task_id?: number;
  spent_date?: string;
  started_time?: string;
  ended_time?: string;
  hours?: number;
  notes?: string;
  external_reference?: {
    id: string;
    group_id: string;
    permalink: string;
  } | null;
  [key: string]: unknown;
}

// Invoice
export interface InvoiceLineItem {
  id: number;
  kind: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  taxed: boolean;
  taxed2: boolean;
  project: { id: number; name: string; code: string | null } | null;
}

export interface Invoice {
  id: number;
  client_key: string;
  number: string;
  purchase_order: string | null;
  amount: number;
  due_amount: number;
  tax: number | null;
  tax_amount: number;
  tax2: number | null;
  tax2_amount: number;
  discount: number | null;
  discount_amount: number;
  subject: string | null;
  notes: string | null;
  state: 'draft' | 'open' | 'paid' | 'closed';
  period_start: string | null;
  period_end: string | null;
  issue_date: string;
  due_date: string;
  payment_term: string;
  sent_at: string | null;
  paid_at: string | null;
  paid_date: string | null;
  closed_at: string | null;
  recurring_invoice_id: number | null;
  created_at: string;
  updated_at: string;
  currency: string;
  payment_options: string[];
  client: { id: number; name: string };
  estimate: { id: number } | null;
  retainer: { id: number } | null;
  creator: { id: number; name: string };
  line_items: InvoiceLineItem[];
}

export interface InvoicesResponse extends PaginatedResponse<Invoice> {
  invoices: Invoice[];
}

export interface CreateInvoiceLineItem {
  kind: string;
  description: string;
  unit_price: number;
  project_id?: number;
  quantity?: number;
  taxed?: boolean;
  taxed2?: boolean;
}

export interface LineItemsImport {
  project_ids: number[];
  time?: {
    summary_type: 'project' | 'task' | 'people' | 'detailed';
    from?: string;
    to?: string;
  };
  expenses?: {
    summary_type: 'project' | 'category' | 'people' | 'detailed';
    from?: string;
    to?: string;
    attach_receipt?: boolean;
  };
}

export interface CreateInvoiceParams {
  client_id: number;
  retainer_id?: number;
  estimate_id?: number;
  number?: string;
  purchase_order?: string;
  tax?: number;
  tax2?: number;
  discount?: number;
  subject?: string;
  notes?: string;
  currency?: string;
  issue_date?: string;
  due_date?: string;
  payment_term?: string;
  line_items?: CreateInvoiceLineItem[];
  line_items_import?: LineItemsImport;
  [key: string]: unknown;
}

export interface UpdateInvoiceLineItem {
  id?: number;
  kind?: string;
  description?: string;
  unit_price?: number;
  project_id?: number;
  quantity?: number;
  taxed?: boolean;
  taxed2?: boolean;
  _destroy?: boolean;
}

// Expense
export interface Expense {
  id: number;
  notes: string | null;
  total_cost: number;
  units: number;
  is_closed: boolean;
  is_locked: boolean;
  is_billed: boolean;
  locked_reason: string | null;
  spent_date: string;
  created_at: string;
  updated_at: string;
  billable: boolean;
  receipt: {
    url: string;
    file_name: string;
    file_size: number;
    content_type: string;
  } | null;
  user: { id: number; name: string };
  user_assignment: {
    id: number;
    is_project_manager: boolean;
    is_active: boolean;
    budget: number | null;
    created_at: string;
    updated_at: string;
    hourly_rate: number | null;
  };
  project: { id: number; name: string; code: string | null };
  expense_category: {
    id: number;
    name: string;
    unit_price: number | null;
    unit_name: string | null;
  };
  client: { id: number; name: string; currency: string };
  invoice: { id: number; number: string } | null;
}

export interface ExpensesResponse extends PaginatedResponse<Expense> {
  expenses: Expense[];
}

// Task
export interface Task {
  id: number;
  name: string;
  billable_by_default: boolean;
  default_hourly_rate: number | null;
  is_default: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface TasksResponse extends PaginatedResponse<Task> {
  tasks: Task[];
}

// Common filter params
export interface ListParams {
  page?: number;
  per_page?: number;
  updated_since?: string;
  [key: string]: string | number | boolean | undefined;
}

export interface TimeEntryFilterParams extends ListParams {
  user_id?: number;
  client_id?: number;
  project_id?: number;
  task_id?: number;
  is_billed?: boolean;
  is_running?: boolean;
  from?: string;
  to?: string;
}

export interface InvoiceFilterParams extends ListParams {
  client_id?: number;
  project_id?: number;
  state?: 'draft' | 'open' | 'paid' | 'closed';
  from?: string;
  to?: string;
}

export interface ExpenseFilterParams extends ListParams {
  user_id?: number;
  client_id?: number;
  project_id?: number;
  is_billed?: boolean;
  from?: string;
  to?: string;
}
