import { BillableMetric } from '../types/metrics';

/**
 * Billable Metrics Catalog
 *
 * Defines how raw events are aggregated into billable quantities.
 * In production, this could be stored in a database and configured via API.
 * For MeterFlow demo, we use a static catalog.
 */
export const METRICS_CATALOG: BillableMetric[] = [
  {
    code: 'api_calls',
    name: 'API Calls',
    event_type: 'api_request',
    aggregation: 'COUNT',
    unit: 'calls',
    description: 'Total number of API requests made',
  },
  {
    code: 'bandwidth',
    name: 'Bandwidth',
    event_type: 'api_request',
    aggregation: 'SUM',
    property: 'bytes',
    unit: 'bytes',
    description: 'Total bytes transferred via API requests',
  },
  {
    code: 'storage_peak',
    name: 'Peak Storage',
    event_type: 'storage',
    aggregation: 'MAX',
    property: 'gb_stored',
    unit: 'GB',
    description: 'Maximum storage used during the period',
  },
  {
    code: 'compute_time',
    name: 'Compute Time',
    event_type: 'compute',
    aggregation: 'SUM',
    property: 'cpu_ms',
    unit: 'ms',
    description: 'Total CPU time consumed',
  },
];

/**
 * Get a metric by its code
 */
export function getMetric(code: string): BillableMetric | undefined {
  return METRICS_CATALOG.find((m) => m.code === code);
}

/**
 * Get all available metric codes
 */
export function getMetricCodes(): string[] {
  return METRICS_CATALOG.map((m) => m.code);
}
