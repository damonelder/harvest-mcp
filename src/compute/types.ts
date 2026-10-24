/**
 * Types for compute tools (profitability, utilization, aggregation)
 */

export type ProfitabilityMode = 'time_based' | 'invoice_based' | 'hybrid';
export type GroupBy = 'client' | 'project' | 'user' | 'task' | 'date' | 'month' | 'week';

export interface DateRange {
  from: string;  // YYYY-MM-DD
  to: string;    // YYYY-MM-DD
}

// ============================================
// PROFITABILITY TYPES
// ============================================

export interface ProfitabilityParams {
  mode: ProfitabilityMode;
  date_range: DateRange;
  client_id?: number;
  project_id?: number;
  user_id?: number;
  group_by?: GroupBy[];
  include_non_billable?: boolean;  // Include non-billable time in cost calculations
}

export interface ProfitabilityMetrics {
  hours: number;
  billable_hours: number;
  non_billable_hours: number;
  billable_amount: number;
  cost: number;
  profit: number;
  margin_percent: number;  // profit / billable_amount * 100
  effective_rate: number;  // billable_amount / billable_hours
  cost_rate_avg: number;   // cost / hours
}

export interface ProfitabilityGrouping {
  id: number | string;
  name: string;
  type: GroupBy;
}

export interface ProfitabilityResult {
  grouping?: ProfitabilityGrouping;
  metrics: ProfitabilityMetrics;
  children?: ProfitabilityResult[];  // Nested groupings
}

export interface ProfitabilityResponse {
  mode: ProfitabilityMode;
  date_range: DateRange;
  filters: {
    client_id?: number;
    project_id?: number;
    user_id?: number;
  };
  totals: ProfitabilityMetrics;
  grouped_results?: ProfitabilityResult[];
  warnings: string[];
  _meta: {
    truncated?: boolean;
    truncation_warnings?: string[];
    entries_analyzed: number;
    invoices_analyzed: number;
    calculation_details: string;
  };
}

// ============================================
// UTILIZATION TYPES
// ============================================

export interface UtilizationParams {
  date_range: DateRange;
  user_id?: number;
  project_id?: number;
  client_id?: number;
  group_by?: GroupBy[];
  capacity_hours_per_day?: number;  // Default: 8
  exclude_weekends?: boolean;       // Default: true
}

export interface UtilizationMetrics {
  total_hours: number;
  billable_hours: number;
  non_billable_hours: number;
  capacity_hours: number;
  utilization_percent: number;       // total_hours / capacity_hours * 100
  billable_utilization_percent: number;  // billable_hours / capacity_hours * 100
  billable_ratio_percent: number;    // billable_hours / total_hours * 100
  working_days: number;
}

export interface UtilizationGrouping {
  id: number | string;
  name: string;
  type: GroupBy;
}

export interface UtilizationResult {
  grouping?: UtilizationGrouping;
  metrics: UtilizationMetrics;
  children?: UtilizationResult[];
}

export interface UtilizationResponse {
  date_range: DateRange;
  filters: {
    user_id?: number;
    project_id?: number;
    client_id?: number;
  };
  settings: {
    capacity_hours_per_day: number;
    exclude_weekends: boolean;
  };
  totals: UtilizationMetrics;
  grouped_results?: UtilizationResult[];
  _meta: {
    truncated?: boolean;
    truncation_warnings?: string[];
    entries_analyzed: number;
    users_included: number;
  };
}

// ============================================
// TIME AGGREGATION TYPES
// ============================================

export interface TimeAggregationParams {
  date_range: DateRange;
  group_by: GroupBy[];
  client_id?: number;
  project_id?: number;
  user_id?: number;
  task_id?: number;
  billable_only?: boolean;
}

export interface TimeAggregationMetrics {
  hours: number;
  rounded_hours: number;
  billable_hours: number;
  non_billable_hours: number;
  entry_count: number;
  billable_amount: number;
}

export interface TimeAggregationGrouping {
  id: number | string;
  name: string;
  type: GroupBy;
}

export interface TimeAggregationResult {
  grouping: TimeAggregationGrouping;
  metrics: TimeAggregationMetrics;
  children?: TimeAggregationResult[];
}

export interface TimeAggregationResponse {
  date_range: DateRange;
  filters: {
    client_id?: number;
    project_id?: number;
    user_id?: number;
    task_id?: number;
    billable_only?: boolean;
  };
  group_by: GroupBy[];
  totals: TimeAggregationMetrics;
  grouped_results: TimeAggregationResult[];
  _meta: {
    truncated?: boolean;
    truncation_warnings?: string[];
    entries_analyzed: number;
  };
}

// ============================================
// BUDGET PERFORMANCE TYPES
// ============================================

export type PerformanceRating = 'under_budget' | 'on_budget' | 'over_budget';
export type BudgetPerformanceSortBy = 'variance_hours' | 'variance_percent' | 'actual_hours' | 'user_name';
export type SortOrder = 'asc' | 'desc';

export interface BudgetPerformanceParams {
  date_range: DateRange;
  client_id?: number;
  project_id?: number;
  user_id?: number;
  /** Only include projects with budget_by = 'person' (per-user budgets) */
  require_person_budget?: boolean;
  /** Tolerance percentage for "on budget" rating (default: 5) */
  on_budget_tolerance_percent?: number;
  /** Sort results by this field */
  sort_by?: BudgetPerformanceSortBy;
  /** Sort order (default: asc for variance, desc for hours) */
  sort_order?: SortOrder;
}

/** Metrics for a single user-project combination */
export interface BudgetPerformanceProjectMetrics {
  project_id: number;
  project_name: string;
  client_id: number;
  client_name: string;
  budget_hours: number | null;  // null if no budget set
  actual_hours: number;
  variance_hours: number;        // actual - budget (positive = over, negative = under)
  variance_percent: number | null;  // null if no budget
  rating: PerformanceRating;
  entry_count: number;
}

/** Summary metrics across all projects for a user */
export interface BudgetPerformanceUserMetrics {
  total_budget_hours: number;
  total_actual_hours: number;
  total_variance_hours: number;
  total_variance_percent: number | null;
  projects_over_budget: number;
  projects_under_budget: number;
  projects_on_budget: number;
  projects_without_budget: number;
  overall_rating: PerformanceRating;
}

/** Complete performance data for a single user */
export interface BudgetPerformanceUserResult {
  user_id: number;
  user_name: string;
  metrics: BudgetPerformanceUserMetrics;
  projects: BudgetPerformanceProjectMetrics[];
}

/** Totals across all users */
export interface BudgetPerformanceTotals {
  total_users: number;
  users_over_budget: number;
  users_under_budget: number;
  users_on_budget: number;
  total_budget_hours: number;
  total_actual_hours: number;
  total_variance_hours: number;
  total_variance_percent: number | null;
}

export interface BudgetPerformanceResponse {
  date_range: DateRange;
  filters: {
    client_id?: number;
    project_id?: number;
    user_id?: number;
  };
  settings: {
    on_budget_tolerance_percent: number;
    require_person_budget: boolean;
  };
  totals: BudgetPerformanceTotals;
  /** Users sorted by performance (worst performers first by default) */
  users: BudgetPerformanceUserResult[];
  /** Top performers (under budget) */
  top_performers: Array<{ user_id: number; user_name: string; variance_percent: number }>;
  /** Users consistently over budget */
  over_budget_repeat_offenders: Array<{ user_id: number; user_name: string; projects_over: number; total_variance_hours: number }>;
  warnings: string[];
  _meta: {
    truncated?: boolean;
    truncation_warnings?: string[];
    entries_analyzed: number;
    projects_analyzed: number;
    calculation_details: string;
  };
}
