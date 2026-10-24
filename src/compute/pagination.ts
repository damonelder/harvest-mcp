/**
 * Shared pagination settings for analytics.
 *
 * Harvest allows up to 2,000 records per page. 25 pages caps a single
 * analysis at 50,000 records (previously 1,000 with no warning). When the cap
 * is hit, results are flagged as truncated so partial totals are never
 * presented as complete.
 */

export const ANALYTICS_PAGINATION = { maxPages: 25, perPage: 2000 } as const;

export interface TruncationInfo {
  truncated: boolean;
  truncation_warnings: string[];
}

export function collectTruncation(
  ...results: Array<{ truncated?: boolean; truncation_warning?: string } | undefined>
): TruncationInfo {
  const truncation_warnings = results
    .filter((r): r is { truncated?: boolean; truncation_warning?: string } => !!r && !!r.truncated)
    .map((r) => r.truncation_warning || 'Results truncated by the pagination cap.');
  return { truncated: truncation_warnings.length > 0, truncation_warnings };
}
