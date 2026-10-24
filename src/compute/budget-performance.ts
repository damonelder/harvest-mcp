/**
 * Budget Performance Calculator
 *
 * Analyzes employee performance based on budget adherence per project.
 * Identifies:
 * - Users who consistently go over budget (negative indicator)
 * - Top performers who come under budget (positive indicator)
 * - Budget variance trends per user/project combination
 */

import type { HarvestClient } from '../harvest/client.js';
import type { TimeEntry, Project } from '../harvest/types.js';
import type {
  BudgetPerformanceParams,
  BudgetPerformanceResponse,
  BudgetPerformanceUserResult,
  BudgetPerformanceUserMetrics,
  BudgetPerformanceProjectMetrics,
  BudgetPerformanceTotals,
  PerformanceRating,
} from './types.js';
import { ANALYTICS_PAGINATION, collectTruncation } from './pagination.js';

interface UserProjectData {
  userId: number;
  userName: string;
  projectId: number;
  projectName: string;
  clientId: number;
  clientName: string;
  budgetHours: number | null;
  actualHours: number;
  entryCount: number;
}

export class BudgetPerformanceCalculator {
  private client: HarvestClient;

  constructor(client: HarvestClient) {
    this.client = client;
  }

  /**
   * Calculate budget performance metrics
   */
  async calculate(params: BudgetPerformanceParams): Promise<BudgetPerformanceResponse> {
    const {
      date_range,
      client_id,
      project_id,
      user_id,
      require_person_budget = false,
      on_budget_tolerance_percent = 5,
      sort_by = 'variance_hours',
      sort_order,
    } = params;

    const warnings: string[] = [];

    // Fetch time entries with auto-pagination
    const entriesResult = await this.client.autoPaginate(
      (p) => this.client.listTimeEntries({
        from: date_range.from,
        to: date_range.to,
        client_id,
        project_id,
        user_id,
        ...p,
      }),
      {},
      ANALYTICS_PAGINATION
    );
    const entries = entriesResult.items as TimeEntry[];

    if (entries.length === 0) {
      return this.emptyResponse(date_range, params, on_budget_tolerance_percent, require_person_budget);
    }

    // Fetch projects to get budget_by setting
    const projectsResult = await this.client.autoPaginate(
      (p) => this.client.listProjects({
        client_id,
        is_active: true,
        ...p,
      }),
      {},
      { maxPages: 10, perPage: 2000 }
    );
    const projects = projectsResult.items as Project[];
    const truncation = collectTruncation(entriesResult, projectsResult);
    warnings.push(...truncation.truncation_warnings);
    const projectMap = new Map(projects.map(p => [p.id, p]));

    // Aggregate data by user-project combination
    const userProjectMap = new Map<string, UserProjectData>();

    for (const entry of entries) {
      const project = projectMap.get(entry.project.id);

      // Skip if require_person_budget and project doesn't use per-person budgets
      if (require_person_budget && project?.budget_by !== 'person') {
        continue;
      }

      const key = `${entry.user.id}:${entry.project.id}`;

      if (!userProjectMap.has(key)) {
        // Get budget from user_assignment (this is the per-user budget for this project)
        const budgetHours = entry.user_assignment?.budget ?? null;

        userProjectMap.set(key, {
          userId: entry.user.id,
          userName: entry.user.name,
          projectId: entry.project.id,
          projectName: entry.project.name,
          clientId: entry.client.id,
          clientName: entry.client.name,
          budgetHours,
          actualHours: 0,
          entryCount: 0,
        });
      }

      const data = userProjectMap.get(key)!;
      data.actualHours += entry.hours;
      data.entryCount++;
    }

    if (userProjectMap.size === 0) {
      warnings.push('No matching time entries found with the specified filters');
      return this.emptyResponse(date_range, params, on_budget_tolerance_percent, require_person_budget, warnings);
    }

    // Group by user
    const userMap = new Map<number, { name: string; projects: UserProjectData[] }>();

    for (const data of userProjectMap.values()) {
      if (!userMap.has(data.userId)) {
        userMap.set(data.userId, { name: data.userName, projects: [] });
      }
      userMap.get(data.userId)!.projects.push(data);
    }

    // Calculate metrics for each user
    const userResults: BudgetPerformanceUserResult[] = [];
    const uniqueProjects = new Set<number>();

    for (const [userId, userData] of userMap) {
      const projectMetrics: BudgetPerformanceProjectMetrics[] = [];

      let totalBudgetHours = 0;
      let totalActualHours = 0;
      let projectsOverBudget = 0;
      let projectsUnderBudget = 0;
      let projectsOnBudget = 0;
      let projectsWithoutBudget = 0;

      for (const projData of userData.projects) {
        uniqueProjects.add(projData.projectId);

        const varianceHours = projData.budgetHours !== null
          ? projData.actualHours - projData.budgetHours
          : 0;

        const variancePercent = projData.budgetHours !== null && projData.budgetHours > 0
          ? (varianceHours / projData.budgetHours) * 100
          : null;

        const rating = this.getRating(variancePercent, on_budget_tolerance_percent);

        if (projData.budgetHours !== null) {
          totalBudgetHours += projData.budgetHours;

          if (rating === 'over_budget') projectsOverBudget++;
          else if (rating === 'under_budget') projectsUnderBudget++;
          else projectsOnBudget++;
        } else {
          projectsWithoutBudget++;
        }

        totalActualHours += projData.actualHours;

        projectMetrics.push({
          project_id: projData.projectId,
          project_name: projData.projectName,
          client_id: projData.clientId,
          client_name: projData.clientName,
          budget_hours: projData.budgetHours !== null ? this.round(projData.budgetHours) : null,
          actual_hours: this.round(projData.actualHours),
          variance_hours: this.round(varianceHours),
          variance_percent: variancePercent !== null ? this.round(variancePercent) : null,
          rating,
          entry_count: projData.entryCount,
        });
      }

      // Sort projects by variance (worst first)
      projectMetrics.sort((a, b) => b.variance_hours - a.variance_hours);

      const totalVarianceHours = totalActualHours - totalBudgetHours;
      const totalVariancePercent = totalBudgetHours > 0
        ? (totalVarianceHours / totalBudgetHours) * 100
        : null;
      const overallRating = this.getRating(totalVariancePercent, on_budget_tolerance_percent);

      const userMetrics: BudgetPerformanceUserMetrics = {
        total_budget_hours: this.round(totalBudgetHours),
        total_actual_hours: this.round(totalActualHours),
        total_variance_hours: this.round(totalVarianceHours),
        total_variance_percent: totalVariancePercent !== null ? this.round(totalVariancePercent) : null,
        projects_over_budget: projectsOverBudget,
        projects_under_budget: projectsUnderBudget,
        projects_on_budget: projectsOnBudget,
        projects_without_budget: projectsWithoutBudget,
        overall_rating: overallRating,
      };

      userResults.push({
        user_id: userId,
        user_name: userData.name,
        metrics: userMetrics,
        projects: projectMetrics,
      });
    }

    // Sort users based on sort_by parameter
    this.sortUsers(userResults, sort_by, sort_order);

    // Calculate totals
    const totals = this.calculateTotals(userResults);

    // Identify top performers and repeat offenders
    const topPerformers = this.getTopPerformers(userResults);
    const repeatOffenders = this.getRepeatOffenders(userResults);

    // Add warnings for edge cases
    const usersWithoutBudgets = userResults.filter(u => u.metrics.projects_without_budget === u.projects.length);
    if (usersWithoutBudgets.length > 0) {
      warnings.push(`${usersWithoutBudgets.length} user(s) have no budget allocations on their projects`);
    }

    return {
      date_range,
      filters: { client_id, project_id, user_id },
      settings: {
        on_budget_tolerance_percent,
        require_person_budget,
      },
      totals,
      users: userResults,
      top_performers: topPerformers,
      over_budget_repeat_offenders: repeatOffenders,
      warnings,
      _meta: {
        ...truncation,
        entries_analyzed: entries.length,
        projects_analyzed: uniqueProjects.size,
        calculation_details: 'Compares actual hours logged vs user budget allocations per project',
      },
    };
  }

  /**
   * Determine performance rating based on variance percentage
   */
  private getRating(variancePercent: number | null, tolerance: number): PerformanceRating {
    if (variancePercent === null) {
      return 'on_budget'; // No budget = assume on budget
    }
    if (variancePercent > tolerance) {
      return 'over_budget';
    }
    if (variancePercent < -tolerance) {
      return 'under_budget';
    }
    return 'on_budget';
  }

  /**
   * Sort users based on specified criteria
   */
  private sortUsers(
    users: BudgetPerformanceUserResult[],
    sortBy: string,
    sortOrder?: string
  ): void {
    // Default sort orders: variance_hours/percent = desc (worst first), others = asc
    const defaultDesc = sortBy === 'variance_hours' || sortBy === 'variance_percent';
    const isDesc = sortOrder ? sortOrder === 'desc' : defaultDesc;

    users.sort((a, b) => {
      let comparison = 0;

      switch (sortBy) {
        case 'variance_hours':
          comparison = a.metrics.total_variance_hours - b.metrics.total_variance_hours;
          break;
        case 'variance_percent':
          comparison = (a.metrics.total_variance_percent ?? 0) - (b.metrics.total_variance_percent ?? 0);
          break;
        case 'actual_hours':
          comparison = a.metrics.total_actual_hours - b.metrics.total_actual_hours;
          break;
        case 'user_name':
          comparison = a.user_name.localeCompare(b.user_name);
          break;
        default:
          comparison = a.metrics.total_variance_hours - b.metrics.total_variance_hours;
      }

      return isDesc ? -comparison : comparison;
    });
  }

  /**
   * Calculate aggregate totals across all users
   */
  private calculateTotals(users: BudgetPerformanceUserResult[]): BudgetPerformanceTotals {
    let totalBudgetHours = 0;
    let totalActualHours = 0;
    let usersOverBudget = 0;
    let usersUnderBudget = 0;
    let usersOnBudget = 0;

    for (const user of users) {
      totalBudgetHours += user.metrics.total_budget_hours;
      totalActualHours += user.metrics.total_actual_hours;

      if (user.metrics.overall_rating === 'over_budget') usersOverBudget++;
      else if (user.metrics.overall_rating === 'under_budget') usersUnderBudget++;
      else usersOnBudget++;
    }

    const totalVarianceHours = totalActualHours - totalBudgetHours;
    const totalVariancePercent = totalBudgetHours > 0
      ? (totalVarianceHours / totalBudgetHours) * 100
      : null;

    return {
      total_users: users.length,
      users_over_budget: usersOverBudget,
      users_under_budget: usersUnderBudget,
      users_on_budget: usersOnBudget,
      total_budget_hours: this.round(totalBudgetHours),
      total_actual_hours: this.round(totalActualHours),
      total_variance_hours: this.round(totalVarianceHours),
      total_variance_percent: totalVariancePercent !== null ? this.round(totalVariancePercent) : null,
    };
  }

  /**
   * Identify top performers (most under budget)
   */
  private getTopPerformers(users: BudgetPerformanceUserResult[]): Array<{ user_id: number; user_name: string; variance_percent: number }> {
    return users
      .filter(u => u.metrics.overall_rating === 'under_budget' && u.metrics.total_variance_percent !== null)
      .sort((a, b) => (a.metrics.total_variance_percent ?? 0) - (b.metrics.total_variance_percent ?? 0))
      .slice(0, 5)
      .map(u => ({
        user_id: u.user_id,
        user_name: u.user_name,
        variance_percent: u.metrics.total_variance_percent!,
      }));
  }

  /**
   * Identify users who are over budget on multiple projects
   */
  private getRepeatOffenders(users: BudgetPerformanceUserResult[]): Array<{ user_id: number; user_name: string; projects_over: number; total_variance_hours: number }> {
    return users
      .filter(u => u.metrics.projects_over_budget >= 2) // At least 2 projects over budget
      .sort((a, b) => b.metrics.projects_over_budget - a.metrics.projects_over_budget)
      .slice(0, 5)
      .map(u => ({
        user_id: u.user_id,
        user_name: u.user_name,
        projects_over: u.metrics.projects_over_budget,
        total_variance_hours: u.metrics.total_variance_hours,
      }));
  }

  /**
   * Return empty response structure
   */
  private emptyResponse(
    date_range: BudgetPerformanceParams['date_range'],
    params: BudgetPerformanceParams,
    tolerancePercent: number,
    requirePersonBudget: boolean,
    warnings: string[] = ['No time entries found for the specified date range']
  ): BudgetPerformanceResponse {
    return {
      date_range,
      filters: {
        client_id: params.client_id,
        project_id: params.project_id,
        user_id: params.user_id,
      },
      settings: {
        on_budget_tolerance_percent: tolerancePercent,
        require_person_budget: requirePersonBudget,
      },
      totals: {
        total_users: 0,
        users_over_budget: 0,
        users_under_budget: 0,
        users_on_budget: 0,
        total_budget_hours: 0,
        total_actual_hours: 0,
        total_variance_hours: 0,
        total_variance_percent: null,
      },
      users: [],
      top_performers: [],
      over_budget_repeat_offenders: [],
      warnings,
      _meta: {
        entries_analyzed: 0,
        projects_analyzed: 0,
        calculation_details: 'No data to analyze',
      },
    };
  }

  /**
   * Round to 2 decimal places
   */
  private round(num: number): number {
    return Math.round(num * 100) / 100;
  }
}
