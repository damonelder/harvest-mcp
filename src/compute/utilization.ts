/**
 * Utilization Calculator
 *
 * Computes utilization metrics from Harvest time entries.
 * Calculates how much of available capacity is being used.
 */

import type { HarvestClient } from '../harvest/client.js';
import type { TimeEntry, User } from '../harvest/types.js';
import type {
  UtilizationParams,
  UtilizationResponse,
  UtilizationMetrics,
  UtilizationResult,
  GroupBy,
} from './types.js';
import { ANALYTICS_PAGINATION, collectTruncation } from './pagination.js';

export class UtilizationCalculator {
  private client: HarvestClient;

  constructor(client: HarvestClient) {
    this.client = client;
  }

  /**
   * Calculate utilization for the specified parameters
   */
  async calculate(params: UtilizationParams): Promise<UtilizationResponse> {
    const {
      date_range,
      user_id,
      project_id,
      client_id,
      group_by = [],
      capacity_hours_per_day = 8,
      exclude_weekends = true,
    } = params;

    // Fetch time entries with auto-pagination
    const entriesResult = await this.client.autoPaginate(
      (p) => this.client.listTimeEntries({
        from: date_range.from,
        to: date_range.to,
        user_id,
        project_id,
        client_id,
        ...p,
      }),
      {},
      ANALYTICS_PAGINATION
    );
    const entries = entriesResult.items as TimeEntry[];
    let usersTruncation: { truncated?: boolean; truncation_warning?: string } | undefined;

    // Get users for capacity calculation
    let users: User[] = [];
    if (user_id) {
      // Single user
      const userResponse = await this.client.getUser(user_id);
      users = [userResponse];
    } else {
      // All active users
      const usersResult = await this.client.autoPaginate(
        (p) => this.client.listUsers({ is_active: true, ...p }),
        {},
        { maxPages: 5, perPage: 2000 }
      );
      users = usersResult.items as User[];
      usersTruncation = usersResult;
    }

    // Calculate working days in the range
    const workingDays = this.calculateWorkingDays(date_range.from, date_range.to, exclude_weekends);

    // Determine unique users with time entries
    const userIdsWithEntries = new Set(entries.map(e => e.user.id));
    const activeUsersCount = user_id ? 1 : userIdsWithEntries.size;

    // Calculate total capacity
    const totalCapacity = workingDays * capacity_hours_per_day * activeUsersCount;

    // Calculate totals
    const totals = this.calculateMetrics(entries, totalCapacity, workingDays);

    // Group results if requested
    let grouped_results: UtilizationResult[] | undefined;
    if (group_by.length > 0) {
      grouped_results = this.groupResults(entries, group_by, capacity_hours_per_day, workingDays);
    }

    return {
      date_range,
      filters: { user_id, project_id, client_id },
      settings: {
        capacity_hours_per_day,
        exclude_weekends,
      },
      totals,
      grouped_results,
      _meta: {
        ...collectTruncation(entriesResult, usersTruncation),
        entries_analyzed: entries.length,
        users_included: activeUsersCount,
      },
    };
  }

  /**
   * Calculate the number of working days between two dates
   */
  private calculateWorkingDays(fromStr: string, toStr: string, excludeWeekends: boolean): number {
    const from = new Date(fromStr);
    const to = new Date(toStr);
    let count = 0;

    const current = new Date(from);
    while (current <= to) {
      if (excludeWeekends) {
        const day = current.getDay();
        if (day !== 0 && day !== 6) {
          count++;
        }
      } else {
        count++;
      }
      current.setDate(current.getDate() + 1);
    }

    return count;
  }

  /**
   * Calculate utilization metrics from entries
   */
  private calculateMetrics(entries: TimeEntry[], capacityHours: number, workingDays: number): UtilizationMetrics {
    let totalHours = 0;
    let billableHours = 0;
    let nonBillableHours = 0;

    for (const entry of entries) {
      totalHours += entry.hours;
      if (entry.billable) {
        billableHours += entry.hours;
      } else {
        nonBillableHours += entry.hours;
      }
    }

    const utilizationPercent = capacityHours > 0 ? (totalHours / capacityHours) * 100 : 0;
    const billableUtilizationPercent = capacityHours > 0 ? (billableHours / capacityHours) * 100 : 0;
    const billableRatioPercent = totalHours > 0 ? (billableHours / totalHours) * 100 : 0;

    return {
      total_hours: this.round(totalHours),
      billable_hours: this.round(billableHours),
      non_billable_hours: this.round(nonBillableHours),
      capacity_hours: this.round(capacityHours),
      utilization_percent: this.round(utilizationPercent),
      billable_utilization_percent: this.round(billableUtilizationPercent),
      billable_ratio_percent: this.round(billableRatioPercent),
      working_days: workingDays,
    };
  }

  /**
   * Group results by specified dimensions
   */
  private groupResults(
    entries: TimeEntry[],
    groupBy: GroupBy[],
    capacityPerDay: number,
    workingDays: number
  ): UtilizationResult[] {
    if (groupBy.length === 0) return [];

    const primaryGroup = groupBy[0];
    const remainingGroups = groupBy.slice(1);

    // Group entries by the primary dimension
    const groups = new Map<string, { entries: TimeEntry[]; name: string; id: number | string }>();

    for (const entry of entries) {
      const { key, name, id } = this.getGroupKey(entry, primaryGroup);
      if (!groups.has(key)) {
        groups.set(key, { entries: [], name, id });
      }
      groups.get(key)!.entries.push(entry);
    }

    const results: UtilizationResult[] = [];

    for (const [, groupData] of groups) {
      // For user grouping, capacity is for that individual user
      // For other groupings, capacity doesn't directly apply (we use total hours as base)
      let capacityHours: number;

      if (primaryGroup === 'user') {
        capacityHours = workingDays * capacityPerDay;
      } else {
        // For non-user groupings, use the user count within this group
        const uniqueUsers = new Set(groupData.entries.map(e => e.user.id));
        capacityHours = workingDays * capacityPerDay * uniqueUsers.size;
      }

      const metrics = this.calculateMetrics(groupData.entries, capacityHours, workingDays);

      const result: UtilizationResult = {
        grouping: {
          id: groupData.id,
          name: groupData.name,
          type: primaryGroup,
        },
        metrics,
      };

      // Recursively group by remaining dimensions
      if (remainingGroups.length > 0) {
        result.children = this.groupResults(
          groupData.entries,
          remainingGroups,
          capacityPerDay,
          workingDays
        );
      }

      results.push(result);
    }

    // Sort by total hours descending
    results.sort((a, b) => b.metrics.total_hours - a.metrics.total_hours);

    return results;
  }

  /**
   * Get grouping key for an entry
   */
  private getGroupKey(entry: TimeEntry, groupBy: GroupBy): { key: string; name: string; id: number | string } {
    switch (groupBy) {
      case 'client':
        return { key: `client:${entry.client.id}`, name: entry.client.name, id: entry.client.id };
      case 'project':
        return { key: `project:${entry.project.id}`, name: entry.project.name, id: entry.project.id };
      case 'user':
        return { key: `user:${entry.user.id}`, name: entry.user.name, id: entry.user.id };
      case 'task':
        return { key: `task:${entry.task.id}`, name: entry.task.name, id: entry.task.id };
      case 'date':
        return { key: `date:${entry.spent_date}`, name: entry.spent_date, id: entry.spent_date };
      case 'week': {
        const weekStart = this.getWeekStart(entry.spent_date);
        return { key: `week:${weekStart}`, name: `Week of ${weekStart}`, id: weekStart };
      }
      case 'month': {
        const month = entry.spent_date.substring(0, 7);
        return { key: `month:${month}`, name: month, id: month };
      }
    }
  }

  /**
   * Get the Monday of the week for a date
   */
  private getWeekStart(dateStr: string): string {
    const date = new Date(dateStr);
    const day = date.getDay();
    const diff = date.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(date.setDate(diff));
    return monday.toISOString().split('T')[0];
  }

  /**
   * Round to 2 decimal places
   */
  private round(num: number): number {
    return Math.round(num * 100) / 100;
  }
}
