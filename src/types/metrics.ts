/**
 * Billable Metrics Schema
 *
 * A billable metric defines HOW to aggregate raw events into a billable quantity.
 * This decouples event ingestion from billing logic — the same event_type can
 * power multiple metrics (e.g., api_request → both "api_calls" COUNT and "bandwidth" SUM).
 */

export type AggregationType = 'COUNT' | 'SUM' | 'MAX';

export interface BillableMetric {
  /** Unique identifier for this metric (e.g., "api_calls") */
  code: string;

  /** Human-readable name (e.g., "API Calls") */
  name: string;

  /** Which event_type to aggregate (e.g., "api_request") */
  event_type: string;

  /** Aggregation function to apply */
  aggregation: AggregationType;

  /**
   * Property to aggregate (required for SUM, MAX)
   * References a key in event.properties (e.g., "bytes", "gb_stored")
   */
  property?: string;

  /** Unit for display (e.g., "calls", "GB", "seconds") */
  unit: string;

  /** Optional description for documentation */
  description?: string;
}

/**
 * Usage Query Request
 */
export interface UsageQueryParams {
  /** Customer to query usage for */
  customer_id: string;

  /** Metric code to calculate */
  metric: string;

  /** Start of period (Unix ms) */
  start: number;

  /** End of period (Unix ms) */
  end: number;

  /** Optional: group results by a property (e.g., "endpoint", "region") */
  group_by?: string;
}

/**
 * Usage Query Response
 */
export interface UsageQueryResponse {
  customer_id: string;
  metric: string;
  period: {
    start: number;
    end: number;
  };
  /** Aggregated value (total) */
  value: number;
  unit: string;
  /** If group_by was specified, breakdown by that dimension */
  breakdown?: Record<string, number>;
}
