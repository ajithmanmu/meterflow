/**
 * Anomaly Detection Types
 */

export interface AnomalyCheckParams {
  customer_id: string;
  metric: string;
  /** Current period to check (Unix ms) */
  current_start: number;
  current_end: number;
  /** How many days of history to use for baseline (default: 30) */
  baseline_days?: number;
  /** Z-score threshold for anomaly (default: 3) */
  threshold?: number;
}

export interface AnomalyCheckResult {
  customer_id: string;
  metric: string;
  period: {
    start: number;
    end: number;
  };
  /** Current period's value */
  current_value: number;
  /** Historical baseline statistics */
  baseline: {
    mean: number;
    stddev: number;
    sample_count: number;
  };
  /** Calculated Z-score */
  z_score: number;
  /** Whether this is considered an anomaly */
  is_anomaly: boolean;
  /** Severity: normal, warning, critical */
  severity: 'normal' | 'warning' | 'critical';
  unit: string;
}

export interface StoredAnomaly {
  id: string;
  customer_id: string;
  metric: string;
  detected_at: number;
  period_start: number;
  period_end: number;
  current_value: number;
  baseline_mean: number;
  baseline_stddev: number;
  z_score: number;
  severity: string;
}
