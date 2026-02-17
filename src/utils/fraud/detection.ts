/**
 * Fraud Detection
 *
 * Compares current usage patterns against baselines to detect fraud.
 */

import { generateHourlyVector, cosineSimilarity, getWeekday } from './vectors';
import { getBaseline } from './baseline';
import { FraudCheckResult, DashboardData } from '../../types/fraud';
import { clickhouse } from '../../config/clickhouse';
import { getMetric } from '../../config/metrics';

const SIMILARITY_THRESHOLD = 0.9;
const VOLUME_CHANGE_THRESHOLD = 50; // percent

/**
 * Check if a specific date's usage pattern is fraudulent
 */
export async function checkFraud(params: {
  customer_id: string;
  metric: string;
  date: string;
}): Promise<FraudCheckResult> {
  const { customer_id, metric, date } = params;
  const weekday = getWeekday(date);

  // Generate today's hourly vector
  const currentVector = await generateHourlyVector({
    customer_id,
    metric,
    date,
  });

  // Get baseline for this weekday
  const baseline = await getBaseline({
    customer_id,
    metric,
    weekday,
  });

  // If no baseline exists, can't detect fraud
  if (!baseline) {
    return {
      customer_id,
      metric,
      date,
      similarity: 1.0,
      volume_change_percent: 0,
      is_fraud: false,
      current_vector: currentVector.vector,
      baseline_vector: new Array(24).fill(0),
      baseline_volume: 0,
    };
  }

  // Calculate cosine similarity
  const similarity = cosineSimilarity(currentVector.vector, baseline.vector);

  // Calculate volume change
  const volumeChange = baseline.avg_volume > 0
    ? ((currentVector.total_count - baseline.avg_volume) / baseline.avg_volume) * 100
    : 0;

  // Determine if fraud
  // Pattern fraud: similarity < 0.9 (different shape)
  // Volume fraud: volume change > 50% (handled by V1 Z-score)
  // We flag pattern fraud when shape is different but volume is similar
  const isPatternAnomaly = similarity < SIMILARITY_THRESHOLD;
  const isVolumeNormal = Math.abs(volumeChange) < VOLUME_CHANGE_THRESHOLD;

  // Fraud = pattern is different but volume looks normal (attacker trying to blend in)
  const isFraud = isPatternAnomaly && isVolumeNormal;

  let fraudType: 'pattern' | 'volume' | 'both' | undefined;
  if (isPatternAnomaly && !isVolumeNormal) {
    fraudType = 'both';
  } else if (isPatternAnomaly) {
    fraudType = 'pattern';
  } else if (!isVolumeNormal) {
    fraudType = 'volume';
  }

  return {
    customer_id,
    metric,
    date,
    similarity: Math.round(similarity * 1000) / 1000,
    volume_change_percent: Math.round(volumeChange * 10) / 10,
    is_fraud: isFraud,
    fraud_type: isFraud ? fraudType : undefined,
    current_vector: currentVector.vector,
    baseline_vector: baseline.vector,
    baseline_volume: baseline.avg_volume,
  };
}

/**
 * Get dashboard data for visualization
 */
export async function getDashboardData(params: {
  customer_id: string;
  metric: string;
  days: number;
}): Promise<DashboardData> {
  const { customer_id, metric, days } = params;

  const metricDef = getMetric(metric);
  if (!metricDef) {
    throw new Error(`Unknown metric: ${metric}`);
  }

  // Get daily usage history
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const startStr = startDate.toISOString().split('T')[0];
  const endStr = endDate.toISOString().split('T')[0];

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

  // Query daily totals
  const dailyQuery = `
    SELECT
      toDate(timestamp) as date,
      ${aggregationExpr} as total
    FROM events
    WHERE customer_id = '${customer_id}'
      AND event_type = '${metricDef.event_type}'
      AND toDate(timestamp) >= '${startStr}'
      AND toDate(timestamp) <= '${endStr}'
    GROUP BY toDate(timestamp)
    ORDER BY date
  `;

  const dailyResult = await clickhouse.query({
    query: dailyQuery,
    format: 'JSONEachRow',
  });

  const dailyRows = await dailyResult.json<{ date: string; total: number }>();

  // Check each day for anomalies
  const usageHistory: DashboardData['usage_history'] = [];

  for (const row of dailyRows) {
    const dateStr = row.date.split('T')[0];
    const fraudCheck = await checkFraud({
      customer_id,
      metric,
      date: dateStr,
    });

    usageHistory.push({
      date: dateStr,
      total: row.total,
      is_anomaly: fraudCheck.is_fraud || fraudCheck.similarity < SIMILARITY_THRESHOLD,
      anomaly_type: fraudCheck.fraud_type,
    });
  }

  // Get today's pattern and baseline
  const today = new Date().toISOString().split('T')[0];
  const todayWeekday = getWeekday(today);

  const currentVector = await generateHourlyVector({
    customer_id,
    metric,
    date: today,
  });

  const baseline = await getBaseline({
    customer_id,
    metric,
    weekday: todayWeekday,
  });

  const latestCheck = await checkFraud({
    customer_id,
    metric,
    date: today,
  });

  return {
    customer_id,
    metric,
    usage_history: usageHistory,
    current_pattern: currentVector.vector.map((v) => v * currentVector.total_count), // De-normalize for display
    baseline_pattern: baseline ? baseline.vector.map((v) => v * baseline.avg_volume) : new Array(24).fill(0),
    latest_check: latestCheck,
  };
}
