/**
 * Time Aggregation Calculator
 *
 * Simple convenience tool for aggregating time entries
 * by various dimensions (client, project, user, task, date, etc.)
 */

import type { HarvestClient } from '../harvest/client.js';
import type { TimeEntry, TimeEntryFilterParams } from '../harvest/types.js';
import type {
  TimeAggregationParams,
  TimeAggregationResponse,
  TimeAggregationMetrics,
  TimeAggregationResult,
  GroupBy,
} from './types.js';
import { ANALYTICS_PAGINATION, collectTruncation } from './pagination.js';

export class TimeAggregationCalculator {
  private client: HarvestClient;

  constructor(client: HarvestClient) {
    this.client = client;
  }

  /**
   * Aggregate time entries by specified dimensions
   */
  async aggregate(params: TimeAggregationParams): Promise<TimeAggregationResponse> {
    const {
      date_range,
      group_by,
      client_id,
      project_id,
      user_id,
      task_id,
      billable_only = false,
    } = params;

    // Build filter params with proper typing
    const filterParams: TimeEntryFilterParams = {
      from: date_range.from,
      to: date_range.to,
      client_id,
      project_id,
      user_id,
      task_id,
    };

    // Fetch time entries with auto-pagination
    const entriesResult = await this.client.autoPaginate(
      (p) => this.client.listTimeEntries({
        ...filterParams,
        ...p,
      }),
      {},
      ANALYTICS_PAGINATION
    );
    const truncation = collectTruncation(entriesResult);
    let entries = entriesResult.items as TimeEntry[];

    // Filter billable only if requested
    if (billable_only) {
      entries = entries.filter(e => e.billable);
    }

    // Calculate totals
    const totals = this.calculateMetrics(entries);

    // Group results
    const grouped_results = this.groupResults(entries, group_by);

    return {
      date_range,
      filters: { client_id, project_id, user_id, task_id, billable_only },
      group_by,
      totals,
      grouped_results,
      _meta: {
        entries_analyzed: entries.length,
        ...truncation,
      },
    };
  }

  /**
   * Calculate aggregation metrics from entries
   */
  private calculateMetrics(entries: TimeEntry[]): TimeAggregationMetrics {
    let hours = 0;
    let roundedHours = 0;
    let billableHours = 0;
    let nonBillableHours = 0;
    let billableAmount = 0;

    for (const entry of entries) {
      hours += entry.hours;
      roundedHours += entry.rounded_hours;

      if (entry.billable) {
        billableHours += entry.hours;
        const rate = entry.billable_rate ?? 0;
        billableAmount += entry.hours * rate;
      } else {
        nonBillableHours += entry.hours;
      }
    }

    return {
      hours: this.round(hours),
      rounded_hours: this.round(roundedHours),
      billable_hours: this.round(billableHours),
      non_billable_hours: this.round(nonBillableHours),
      entry_count: entries.length,
      billable_amount: this.round(billableAmount),
    };
  }

  /**
   * Group results by specified dimensions
   */
  private groupResults(entries: TimeEntry[], groupBy: GroupBy[]): TimeAggregationResult[] {
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

    const results: TimeAggregationResult[] = [];

    for (const [, groupData] of groups) {
      const metrics = this.calculateMetrics(groupData.entries);

      const result: TimeAggregationResult = {
        grouping: {
          id: groupData.id,
          name: groupData.name,
          type: primaryGroup,
        },
        metrics,
      };

      // Recursively group by remaining dimensions
      if (remainingGroups.length > 0) {
        result.children = this.groupResults(groupData.entries, remainingGroups);
      }

      results.push(result);
    }

    // Sort by hours descending
    results.sort((a, b) => b.metrics.hours - a.metrics.hours);

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
