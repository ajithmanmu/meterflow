import { clickhouse } from '../config/clickhouse';
import { getMetric } from '../config/metrics';
import { AnomalyCheckParams, AnomalyCheckResult } from '../types/anomaly';

const DEFAULT_BASELINE_DAYS = 30;
const DEFAULT_THRESHOLD = 3;

/**
 * Check if current usage is anomalous compared to historical baseline
 *
 * Uses Z-score: z = (value - mean) / stddev
 * If |z| > threshold, it's an anomaly
 */
export async function checkAnomaly(params: AnomalyCheckParams): Promise<AnomalyCheckResult> {
  const {
    customer_id,
    metric,
    current_start,
    current_end,
    baseline_days = DEFAULT_BASELINE_DAYS,
    threshold = DEFAULT_THRESHOLD,
  } = params;

  // Get metric definition
  const metricDef = getMetric(metric);
  if (!metricDef) {
    throw new Error(`Unknown metric: ${metric}`);
  }

  // Build aggregation expression
  let aggregationExpr: string;
  switch (metricDef.aggregation) {
    case 'COUNT':
      aggregationExpr = 'count()';
      break;
    case 'SUM':
      aggregationExpr = `sum(JSONExtractFloat(properties, '${metricDef.property}'))`;
      break;
    case 'MAX':
      aggregationExpr = `max(JSONExtractFloat(properties, '${metricDef.property}'))`;
      break;
    default:
      throw new Error(`Unsupported aggregation: ${metricDef.aggregation}`);
  }

  // Convert timestamps
  const currentStartDate = new Date(current_start).toISOString().replace('T', ' ').replace('Z', '');
  const currentEndDate = new Date(current_end).toISOString().replace('T', ' ').replace('Z', '');

  // Calculate baseline period (X days before current_start)
  const baselineEnd = current_start;
  const baselineStart = current_start - baseline_days * 24 * 60 * 60 * 1000;
  const baselineStartDate = new Date(baselineStart).toISOString().replace('T', ' ').replace('Z', '');
  const baselineEndDate = new Date(baselineEnd).toISOString().replace('T', ' ').replace('Z', '');

  // Query 1: Get current period value
  const currentQuery = `
    SELECT ${aggregationExpr} as value
    FROM events
    WHERE customer_id = '${customer_id}'
      AND event_type = '${metricDef.event_type}'
      AND timestamp >= '${currentStartDate}'
      AND timestamp <= '${currentEndDate}'
  `;

  const currentResult = await clickhouse.query({
    query: currentQuery,
    format: 'JSONEachRow',
  });
  const currentRows = await currentResult.json<{ value: number }>();
  const currentValue = currentRows[0]?.value ?? 0;

  // Query 2: Get historical baseline (daily aggregates for the baseline period)
  // We aggregate by day to get individual data points for mean/stddev calculation
  const baselineQuery = `
    SELECT ${aggregationExpr} as daily_value
    FROM events
    WHERE customer_id = '${customer_id}'
      AND event_type = '${metricDef.event_type}'
      AND timestamp >= '${baselineStartDate}'
      AND timestamp < '${baselineEndDate}'
    GROUP BY toDate(timestamp)
  `;

  const baselineResult = await clickhouse.query({
    query: baselineQuery,
    format: 'JSONEachRow',
  });
  const baselineRows = await baselineResult.json<{ daily_value: number }>();

  // Calculate mean and stddev from historical daily values
  const values = baselineRows.map((r) => r.daily_value);
  const sampleCount = values.length;

  let mean = 0;
  let stddev = 0;
  let zScore = 0;

  if (sampleCount > 0) {
    mean = values.reduce((a, b) => a + b, 0) / sampleCount;

    if (sampleCount > 1) {
      const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / (sampleCount - 1);
      stddev = Math.sqrt(variance);
    }

    // Calculate Z-score (avoid division by zero)
    if (stddev > 0) {
      zScore = (currentValue - mean) / stddev;
    } else if (currentValue !== mean) {
      // If no variance but value differs from mean, treat as anomaly
      zScore = currentValue > mean ? Infinity : -Infinity;
    }
  }

  // Determine severity
  const absZ = Math.abs(zScore);
  let severity: 'normal' | 'warning' | 'critical';
  let isAnomaly: boolean;

  if (absZ >= threshold) {
    severity = 'critical';
    isAnomaly = true;
  } else if (absZ >= threshold * 0.66) {
    // ~2 stddev
    severity = 'warning';
    isAnomaly = false;
  } else {
    severity = 'normal';
    isAnomaly = false;
  }

  return {
    customer_id,
    metric,
    period: {
      start: current_start,
      end: current_end,
    },
    current_value: currentValue,
    baseline: {
      mean: Math.round(mean * 100) / 100,
      stddev: Math.round(stddev * 100) / 100,
      sample_count: sampleCount,
    },
    z_score: Math.round(zScore * 100) / 100,
    is_anomaly: isAnomaly,
    severity,
    unit: metricDef.unit,
  };
}
