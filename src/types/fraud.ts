/**
 * V2 Fraud Detection Types
 *
 * Vector-based pattern anomaly detection for catching fraudulent usage
 * (e.g., stolen API keys used from different timezones).
 */

export interface HourlyVector {
  /** Customer identifier */
  customer_id: string;
  /** Metric code from METRICS_CATALOG */
  metric: string;
  /** Date in YYYY-MM-DD format */
  date: string;
  /** Day of week (monday, tuesday, etc.) */
  weekday: string;
  /** 24-element normalized vector (sums to 1.0) */
  vector: number[];
  /** Total count for volume comparison */
  total_count: number;
}

export interface FraudCheckResult {
  /** Customer identifier */
  customer_id: string;
  /** Metric code */
  metric: string;
  /** Date checked */
  date: string;
  /** Cosine similarity between current and baseline (0.0 to 1.0) */
  similarity: number;
  /** Volume change from baseline mean (-100 to +∞) */
  volume_change_percent: number;
  /** Whether this is flagged as fraud */
  is_fraud: boolean;
  /** Type of anomaly detected */
  fraud_type?: 'pattern' | 'volume' | 'both';
  /** Current day's hourly distribution */
  current_vector: number[];
  /** Baseline hourly distribution for this weekday */
  baseline_vector: number[];
  /** Baseline average daily volume */
  baseline_volume: number;
}

export interface BuildBaselinesParams {
  customer_id: string;
  metric: string;
  /** Number of days of history to use */
  days: number;
}

export interface BuildBaselinesResult {
  customer_id: string;
  metric: string;
  /** Number of days processed */
  days_processed: number;
  /** Baselines built per weekday */
  weekdays_built: string[];
}

export interface DashboardData {
  customer_id: string;
  metric: string;
  /** Daily usage for the chart */
  usage_history: Array<{
    date: string;
    total: number;
    is_anomaly: boolean;
    anomaly_type?: 'volume' | 'pattern' | 'both';
  }>;
  /** Today's hourly pattern */
  current_pattern: number[];
  /** Baseline hourly pattern for today's weekday */
  baseline_pattern: number[];
  /** Latest fraud check result */
  latest_check?: FraudCheckResult;
}
