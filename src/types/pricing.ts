/**
 * Pricing Types
 */

export type PricingModel = 'flat' | 'tiered';

export interface PricingTier {
  /** Upper limit for this tier (null = unlimited) */
  up_to: number | null;
  /** Price per unit in this tier */
  unit_price: number;
}

export interface PricingRule {
  /** References metric_code from METRICS_CATALOG */
  metric_code: string;
  /** Pricing model type */
  model: PricingModel;
  /** Currency code (e.g., "USD") */
  currency: string;
  /** For flat pricing: price per unit */
  unit_price?: number;
  /** For tiered pricing: array of tiers */
  tiers?: PricingTier[];
}
