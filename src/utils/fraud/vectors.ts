/**
 * Vector Utilities for Fraud Detection
 *
 * Generates 24-dimensional hourly usage vectors and calculates similarity.
 */

import { clickhouse } from '../../config/clickhouse';
import { getMetric } from '../../config/metrics';
import { HourlyVector } from '../../types/fraud';

/**
 * Get weekday name from date
 */
export function getWeekday(date: string): string {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const d = new Date(date);
  return days[d.getUTCDay()];
}

/**
 * Normalize a vector so all elements sum to 1.0
 * Returns zero vector if sum is 0
 */
export function normalizeVector(counts: number[]): number[] {
  const sum = counts.reduce((a, b) => a + b, 0);
  if (sum === 0) {
    return counts.map(() => 0);
  }
  return counts.map((c) => c / sum);
}

/**
 * Calculate cosine similarity between two vectors
 *
 * Returns 1.0 for identical vectors, 0.0 for orthogonal, -1.0 for opposite
 * For normalized usage vectors, typical fraud threshold is < 0.9
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);

  if (denominator === 0) {
    return 0; // Handle zero vectors
  }

  return dotProduct / denominator;
}

/**
 * Generate hourly usage vector for a specific date
 *
 * Queries ClickHouse for hourly aggregates and returns normalized 24-dim vector
 */
export async function generateHourlyVector(params: {
  customer_id: string;
  metric: string;
  date: string; // YYYY-MM-DD
}): Promise<HourlyVector> {
  const { customer_id, metric, date } = params;

  const metricDef = getMetric(metric);
  if (!metricDef) {
    throw new Error(`Unknown metric: ${metric}`);
  }

  // Build aggregation expression based on metric type
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

  // Query for hourly counts on the given date
  const query = `
    SELECT
      toHour(timestamp) as hour,
      ${aggregationExpr} as value
    FROM events
    WHERE customer_id = '${customer_id}'
      AND event_type = '${metricDef.event_type}'
      AND toDate(timestamp) = '${date}'
    GROUP BY toHour(timestamp)
    ORDER BY hour
  `;

  const result = await clickhouse.query({
    query,
    format: 'JSONEachRow',
  });

  const rows = await result.json<{ hour: number; value: number }>();

  // Build 24-element array (one per hour)
  const hourlyCounts = new Array(24).fill(0);
  for (const row of rows) {
    hourlyCounts[row.hour] = row.value;
  }

  const totalCount = hourlyCounts.reduce((a, b) => a + b, 0);
  const normalizedVector = normalizeVector(hourlyCounts);

  return {
    customer_id,
    metric,
    date,
    weekday: getWeekday(date),
    vector: normalizedVector,
    total_count: totalCount,
  };
}

/**
 * Generate vectors for multiple dates
 */
export async function generateVectorsForDateRange(params: {
  customer_id: string;
  metric: string;
  start_date: string;
  end_date: string;
}): Promise<HourlyVector[]> {
  const { customer_id, metric, start_date, end_date } = params;

  const vectors: HourlyVector[] = [];
  const start = new Date(start_date);
  const end = new Date(end_date);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    const vector = await generateHourlyVector({
      customer_id,
      metric,
      date: dateStr,
    });
    vectors.push(vector);
  }

  return vectors;
}

/**
 * Average multiple vectors element-wise
 */
export function averageVectors(vectors: number[][]): number[] {
  if (vectors.length === 0) {
    return new Array(24).fill(0);
  }

  const sum = new Array(24).fill(0);
  for (const vec of vectors) {
    for (let i = 0; i < 24; i++) {
      sum[i] += vec[i];
    }
  }

  return sum.map((s) => s / vectors.length);
}
