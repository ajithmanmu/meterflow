/**
 * Pricing Catalog
 *
 * Defines pricing rules for each billable metric.
 * Static catalog for demo - in production, this would be stored in a database.
 */

import { PricingRule } from '../types/pricing';

export const PRICING_CATALOG: PricingRule[] = [
  {
    metric_code: 'api_calls',
    model: 'tiered',
    currency: 'USD',
    tiers: [
      { up_to: 1000, unit_price: 0 },        // Free tier: first 1000 calls
      { up_to: 10000, unit_price: 0.001 },   // $0.001/call for 1001-10000
      { up_to: null, unit_price: 0.0005 },   // $0.0005/call for 10001+ (volume discount)
    ],
  },
  {
    metric_code: 'bandwidth',
    model: 'flat',
    currency: 'USD',
    unit_price: 0.00001,  // $0.00001 per byte = $10.00 per GB
  },
  {
    metric_code: 'storage_peak',
    model: 'flat',
    currency: 'USD',
    unit_price: 0.10,  // $0.10 per GB
  },
  {
    metric_code: 'compute_time',
    model: 'flat',
    currency: 'USD',
    unit_price: 0.00001,  // $0.00001 per ms = $36.00 per hour
  },
];

/**
 * Get pricing rule for a metric
 */
export function getPricingRule(metricCode: string): PricingRule | undefined {
  return PRICING_CATALOG.find((rule) => rule.metric_code === metricCode);
}

/**
 * Get all pricing rules
 */
export function getAllPricingRules(): PricingRule[] {
  return PRICING_CATALOG;
}
