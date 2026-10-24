/**
 * Profitability Calculator
 *
 * Computes profitability metrics from Harvest time entries and invoices.
 * Supports three modes:
 * - time_based: Uses hours * rates from time entries
 * - invoice_based: Uses actual invoice amounts
 * - hybrid: Invoice amounts where available, otherwise time-based
 */

import type { HarvestClient } from '../harvest/client.js';
import type { TimeEntry, Invoice } from '../harvest/types.js';
import type {
  ProfitabilityParams,
  ProfitabilityResponse,
  ProfitabilityMetrics,
  ProfitabilityResult,
  GroupBy,
} from './types.js';
import { RatesService } from '../rates/index.js';
import { ANALYTICS_PAGINATION, collectTruncation } from './pagination.js';

export class ProfitabilityCalculator {
  private client: HarvestClient;
  private ratesService: RatesService;

  constructor(client: HarvestClient) {
    this.client = client;
    this.ratesService = new RatesService(client);
  }

  /**
   * Calculate profitability based on the specified mode
   */
  async calculate(params: ProfitabilityParams): Promise<ProfitabilityResponse> {
    const {
      mode,
      date_range,
      client_id,
      project_id,
      user_id,
      group_by = [],
      include_non_billable = false,
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
    let invoicesTruncation: { truncated?: boolean; truncation_warning?: string } | undefined;

    // Fetch invoices if needed for invoice_based or hybrid mode
    let invoices: Invoice[] = [];
    if (mode === 'invoice_based' || mode === 'hybrid') {
      const invoicesResult = await this.client.autoPaginate(
        (p) => this.client.listInvoices({
          from: date_range.from,
          to: date_range.to,
          client_id,
          project_id,
          ...p,
        }),
        {},
        ANALYTICS_PAGINATION
      );
      invoices = invoicesResult.items as Invoice[];
      invoicesTruncation = invoicesResult;
    }

    // Get rate information for missing rates
    const userIds = [...new Set(entries.map(e => e.user.id))];
    const rateMap = new Map<number, number>(); // user_id -> cost_rate

    if (userIds.length > 0) {
      try {
        const ratesResponse = await this.ratesService.getRates({
          include_all_users: true,
        });
        if (ratesResponse.users) {
          for (const userRate of ratesResponse.users) {
            rateMap.set(userRate.user_id, userRate.cost_rate.rate);
          }
        }
      } catch {
        warnings.push('Could not fetch rate information; using entry rates only');
      }
    }

    // Calculate metrics based on mode
    let totals: ProfitabilityMetrics;
    let calculationDetails: string;

    switch (mode) {
      case 'time_based':
        totals = this.calculateTimeBased(entries, rateMap, include_non_billable, warnings);
        calculationDetails = 'Calculated using hours * rates from time entries';
        break;
      case 'invoice_based':
        totals = this.calculateInvoiceBased(entries, invoices, rateMap, include_non_billable, warnings);
        calculationDetails = 'Calculated using actual invoice amounts vs time entry costs';
        break;
      case 'hybrid':
        totals = this.calculateHybrid(entries, invoices, rateMap, include_non_billable, warnings);
        calculationDetails = 'Hybrid: uses invoice amounts where available, time-based otherwise';
        break;
    }

    // Group results if requested
    let grouped_results: ProfitabilityResult[] | undefined;
    if (group_by.length > 0) {
      grouped_results = this.groupResults(entries, invoices, mode, group_by, rateMap, include_non_billable, warnings);
    }

    const truncation = collectTruncation(entriesResult, invoicesTruncation);
    warnings.push(...truncation.truncation_warnings);

    return {
      mode,
      date_range,
      filters: { client_id, project_id, user_id },
      totals,
      grouped_results,
      warnings,
      _meta: {
        ...truncation,
        entries_analyzed: entries.length,
        invoices_analyzed: invoices.length,
        calculation_details: calculationDetails,
      },
    };
  }

  /**
   * Calculate profitability using time entry hours and rates
   */
  private calculateTimeBased(
    entries: TimeEntry[],
    rateMap: Map<number, number>,
    includeNonBillable: boolean,
    warnings: string[]
  ): ProfitabilityMetrics {
    let hours = 0;
    let billableHours = 0;
    let nonBillableHours = 0;
    let billableAmount = 0;
    let cost = 0;

    for (const entry of entries) {
      const entryHours = entry.hours;
      hours += entryHours;

      if (entry.billable) {
        billableHours += entryHours;
        const billableRate = entry.billable_rate ?? 0;
        billableAmount += entryHours * billableRate;
      } else {
        nonBillableHours += entryHours;
      }

      // Calculate cost (for all hours or billable only)
      if (entry.billable || includeNonBillable) {
        const costRate = entry.cost_rate ?? rateMap.get(entry.user.id) ?? 0;
        if (costRate === 0 && entry.hours > 0) {
          // Only warn once per user
          if (!warnings.some(w => w.includes(`user ${entry.user.name}`))) {
            warnings.push(`No cost rate found for user ${entry.user.name} (ID: ${entry.user.id})`);
          }
        }
        cost += entryHours * costRate;
      }
    }

    return this.buildMetrics(hours, billableHours, nonBillableHours, billableAmount, cost);
  }

  /**
   * Calculate profitability using invoice amounts
   */
  private calculateInvoiceBased(
    entries: TimeEntry[],
    invoices: Invoice[],
    rateMap: Map<number, number>,
    includeNonBillable: boolean,
    warnings: string[]
  ): ProfitabilityMetrics {
    // Sum invoice amounts (excluding drafts)
    const billableAmount = invoices
      .filter(inv => inv.state !== 'draft')
      .reduce((sum, inv) => sum + inv.amount, 0);

    // Calculate hours and costs from entries
    let hours = 0;
    let billableHours = 0;
    let nonBillableHours = 0;
    let cost = 0;

    for (const entry of entries) {
      const entryHours = entry.hours;
      hours += entryHours;

      if (entry.billable) {
        billableHours += entryHours;
      } else {
        nonBillableHours += entryHours;
      }

      if (entry.billable || includeNonBillable) {
        const costRate = entry.cost_rate ?? rateMap.get(entry.user.id) ?? 0;
        cost += entryHours * costRate;
      }
    }

    if (invoices.length === 0) {
      warnings.push('No invoices found for the date range; revenue is $0');
    }

    return this.buildMetrics(hours, billableHours, nonBillableHours, billableAmount, cost);
  }

  /**
   * Calculate hybrid profitability (invoice where available, time-based otherwise)
   */
  private calculateHybrid(
    entries: TimeEntry[],
    invoices: Invoice[],
    rateMap: Map<number, number>,
    includeNonBillable: boolean,
    warnings: string[]
  ): ProfitabilityMetrics {
    // Track which entries are covered by invoices
    const billedEntryIds = new Set<number>();
    let invoicedAmount = 0;

    // For entries that have is_billed=true, use invoice amounts
    for (const inv of invoices) {
      if (inv.state !== 'draft') {
        invoicedAmount += inv.amount;
      }
    }

    // Calculate time-based amount only for non-billed entries
    let hours = 0;
    let billableHours = 0;
    let nonBillableHours = 0;
    let timeBasedAmount = 0;
    let cost = 0;
    let billedHours = 0;
    let unbilledHours = 0;

    for (const entry of entries) {
      const entryHours = entry.hours;
      hours += entryHours;

      if (entry.billable) {
        billableHours += entryHours;

        if (entry.is_billed) {
          billedHours += entryHours;
          billedEntryIds.add(entry.id);
        } else {
          unbilledHours += entryHours;
          // Only add time-based amount for unbilled entries
          const billableRate = entry.billable_rate ?? 0;
          timeBasedAmount += entryHours * billableRate;
        }
      } else {
        nonBillableHours += entryHours;
      }

      if (entry.billable || includeNonBillable) {
        const costRate = entry.cost_rate ?? rateMap.get(entry.user.id) ?? 0;
        cost += entryHours * costRate;
      }
    }

    // Hybrid billable amount = invoiced + time-based for unbilled
    const billableAmount = invoicedAmount + timeBasedAmount;

    if (billedHours > 0 && unbilledHours > 0) {
      warnings.push(`Hybrid calculation: ${billedHours.toFixed(1)}h billed (invoice-based), ${unbilledHours.toFixed(1)}h unbilled (time-based)`);
    }

    return this.buildMetrics(hours, billableHours, nonBillableHours, billableAmount, cost);
  }

  /**
   * Build metrics object from raw values
   */
  private buildMetrics(
    hours: number,
    billableHours: number,
    nonBillableHours: number,
    billableAmount: number,
    cost: number
  ): ProfitabilityMetrics {
    const profit = billableAmount - cost;
    const marginPercent = billableAmount > 0 ? (profit / billableAmount) * 100 : 0;
    const effectiveRate = billableHours > 0 ? billableAmount / billableHours : 0;
    const costRateAvg = hours > 0 ? cost / hours : 0;

    return {
      hours: this.round(hours),
      billable_hours: this.round(billableHours),
      non_billable_hours: this.round(nonBillableHours),
      billable_amount: this.round(billableAmount),
      cost: this.round(cost),
      profit: this.round(profit),
      margin_percent: this.round(marginPercent),
      effective_rate: this.round(effectiveRate),
      cost_rate_avg: this.round(costRateAvg),
    };
  }

  /**
   * Group results by specified dimensions
   */
  private groupResults(
    entries: TimeEntry[],
    invoices: Invoice[],
    mode: ProfitabilityParams['mode'],
    groupBy: GroupBy[],
    rateMap: Map<number, number>,
    includeNonBillable: boolean,
    warnings: string[]
  ): ProfitabilityResult[] {
    if (groupBy.length === 0) return [];

    const primaryGroup = groupBy[0];
    const remainingGroups = groupBy.slice(1);

    // Group entries by the primary dimension
    const groups = new Map<string, { entries: TimeEntry[]; invoices: Invoice[]; name: string; id: number | string }>();

    for (const entry of entries) {
      const { key, name, id } = this.getGroupKey(entry, primaryGroup);
      if (!groups.has(key)) {
        groups.set(key, { entries: [], invoices: [], name, id });
      }
      groups.get(key)!.entries.push(entry);
    }

    // Assign invoices to groups (by client primarily)
    for (const invoice of invoices) {
      if (primaryGroup === 'client') {
        const key = `client:${invoice.client.id}`;
        if (groups.has(key)) {
          groups.get(key)!.invoices.push(invoice);
        }
      }
      // For other groupings, invoices are harder to assign directly
    }

    const results: ProfitabilityResult[] = [];

    for (const [, groupData] of groups) {
      let metrics: ProfitabilityMetrics;

      switch (mode) {
        case 'time_based':
          metrics = this.calculateTimeBased(groupData.entries, rateMap, includeNonBillable, []);
          break;
        case 'invoice_based':
          metrics = this.calculateInvoiceBased(groupData.entries, groupData.invoices, rateMap, includeNonBillable, []);
          break;
        case 'hybrid':
          metrics = this.calculateHybrid(groupData.entries, groupData.invoices, rateMap, includeNonBillable, []);
          break;
      }

      const result: ProfitabilityResult = {
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
          groupData.invoices,
          mode,
          remainingGroups,
          rateMap,
          includeNonBillable,
          warnings
        );
      }

      results.push(result);
    }

    // Sort by billable amount descending
    results.sort((a, b) => b.metrics.billable_amount - a.metrics.billable_amount);

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
