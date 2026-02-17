/**
 * Baseline Management for Fraud Detection
 *
 * Stores and retrieves weekday baseline vectors in Redis.
 * Baselines represent "normal" hourly usage patterns.
 */

import { redis } from '../../config/redis';
import { generateHourlyVector, averageVectors, getWeekday } from './vectors';
import { BuildBaselinesParams, BuildBaselinesResult } from '../../types/fraud';

const BASELINE_PREFIX = 'baseline';
const BASELINE_TTL = 90 * 24 * 60 * 60; // 90 days

/**
 * Build Redis key for baseline
 */
function baselineKey(customer_id: string, metric: string, weekday: string): string {
  return `${BASELINE_PREFIX}:${customer_id}:${metric}:${weekday}`;
}

/**
 * Store baseline vector for a customer/metric/weekday
 */
export async function storeBaseline(params: {
  customer_id: string;
  metric: string;
  weekday: string;
  vector: number[];
  avg_volume: number;
}): Promise<void> {
  const { customer_id, metric, weekday, vector, avg_volume } = params;
  const key = baselineKey(customer_id, metric, weekday);

  const data = JSON.stringify({
    vector,
    avg_volume,
    updated_at: Date.now(),
  });

  await redis.set(key, data, 'EX', BASELINE_TTL);
}

/**
 * Get baseline vector for a customer/metric/weekday
 * Returns null if no baseline exists
 */
export async function getBaseline(params: {
  customer_id: string;
  metric: string;
  weekday: string;
}): Promise<{ vector: number[]; avg_volume: number } | null> {
  const { customer_id, metric, weekday } = params;
  const key = baselineKey(customer_id, metric, weekday);

  const data = await redis.get(key);
  if (!data) {
    return null;
  }

  const parsed = JSON.parse(data);
  return {
    vector: parsed.vector,
    avg_volume: parsed.avg_volume,
  };
}

/**
 * Build baselines from historical data
 *
 * Processes N days of history, groups by weekday, and stores average vectors
 */
export async function buildBaselines(params: BuildBaselinesParams): Promise<BuildBaselinesResult> {
  const { customer_id, metric, days } = params;

  // Calculate date range
  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 1); // Yesterday (don't include today)
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - days + 1);

  // Group vectors by weekday
  const weekdayVectors: Record<string, { vectors: number[][]; volumes: number[] }> = {
    sunday: { vectors: [], volumes: [] },
    monday: { vectors: [], volumes: [] },
    tuesday: { vectors: [], volumes: [] },
    wednesday: { vectors: [], volumes: [] },
    thursday: { vectors: [], volumes: [] },
    friday: { vectors: [], volumes: [] },
    saturday: { vectors: [], volumes: [] },
  };

  // Generate vectors for each day in range
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    const weekday = getWeekday(dateStr);

    try {
      const vector = await generateHourlyVector({
        customer_id,
        metric,
        date: dateStr,
      });

      // Only include days with actual usage
      if (vector.total_count > 0) {
        weekdayVectors[weekday].vectors.push(vector.vector);
        weekdayVectors[weekday].volumes.push(vector.total_count);
      }
    } catch (error) {
      // Skip days with errors (e.g., no data)
      console.warn(`Skipping ${dateStr}: ${error}`);
    }
  }

  // Calculate and store baseline for each weekday
  const weekdaysBuilt: string[] = [];
  let daysProcessed = 0;

  for (const [weekday, data] of Object.entries(weekdayVectors)) {
    if (data.vectors.length > 0) {
      const avgVector = averageVectors(data.vectors);
      const avgVolume = data.volumes.reduce((a, b) => a + b, 0) / data.volumes.length;

      await storeBaseline({
        customer_id,
        metric,
        weekday,
        vector: avgVector,
        avg_volume: avgVolume,
      });

      weekdaysBuilt.push(weekday);
      daysProcessed += data.vectors.length;
    }
  }

  return {
    customer_id,
    metric,
    days_processed: daysProcessed,
    weekdays_built: weekdaysBuilt,
  };
}

/**
 * Check if baselines exist for a customer/metric
 */
export async function hasBaselines(params: {
  customer_id: string;
  metric: string;
}): Promise<boolean> {
  const { customer_id, metric } = params;

  // Check if at least one weekday has a baseline
  const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

  for (const weekday of weekdays) {
    const baseline = await getBaseline({ customer_id, metric, weekday });
    if (baseline) {
      return true;
    }
  }

  return false;
}
