/**
 * Invoice Calculation
 *
 * Calculates invoices by combining usage data with pricing rules.
 */

import { v4 as uuidv4 } from 'uuid';
import { queryUsage } from './usage';
import { getPricingRule } from '../config/pricing';
import { getMetricCodes, getMetric } from '../config/metrics';
import { PricingTier } from '../types/pricing';
import {
  Invoice,
  InvoiceLine,
  InvoiceCalculationParams,
  TierBreakdown,
} from '../types/invoice';

/**
 * Calculate tiered pricing
 *
 * Example: 15,000 API calls with tiers [0-1000: $0, 1001-10000: $0.001, 10001+: $0.0005]
 * - Tier 1: 1,000 calls × $0.00 = $0.00
 * - Tier 2: 9,000 calls × $0.001 = $9.00
 * - Tier 3: 5,000 calls × $0.0005 = $2.50
 * - Total: $11.50
 */
function calculateTieredCost(
  quantity: number,
  tiers: PricingTier[]
): { total: number; breakdown: TierBreakdown[] } {
  const breakdown: TierBreakdown[] = [];
  let remaining = quantity;
  let total = 0;
  let previousLimit = 0;

  for (const tier of tiers) {
    if (remaining <= 0) break;

    const tierLimit = tier.up_to ?? Infinity;
    const tierCapacity = tierLimit - previousLimit;
    const quantityInTier = Math.min(remaining, tierCapacity);
    const amount = quantityInTier * tier.unit_price;

    // Build tier range string
    const tierStart = previousLimit;
    const tierEnd = tier.up_to !== null ? tier.up_to : `${previousLimit}+`;
    const tierLabel = tier.up_to !== null ? `${tierStart}-${tierEnd}` : `${tierStart}+`;

    breakdown.push({
      tier: tierLabel,
      quantity: quantityInTier,
      unit_price: tier.unit_price,
      amount: Math.round(amount * 10000) / 10000,  // Round to 4 decimals
    });

    total += amount;
    remaining -= quantityInTier;
    previousLimit = tierLimit;
  }

  return {
    total: Math.round(total * 100) / 100,  // Round to cents
    breakdown,
  };
}

/**
 * Calculate flat pricing
 */
function calculateFlatCost(quantity: number, unitPrice: number): number {
  return Math.round(quantity * unitPrice * 100) / 100;  // Round to cents
}

/**
 * Calculate invoice for a customer's usage in a period
 */
export async function calculateInvoice(
  params: InvoiceCalculationParams
): Promise<Invoice> {
  const { customer_id, start, end } = params;
  const lines: InvoiceLine[] = [];
  let subtotal = 0;
  let currency = 'USD';

  // Get usage for each metric
  const metricCodes = getMetricCodes();

  for (const metricCode of metricCodes) {
    const metric = getMetric(metricCode);
    if (!metric) continue;

    const pricingRule = getPricingRule(metricCode);
    if (!pricingRule) continue;

    // Query usage for this metric
    const usage = await queryUsage({
      customer_id,
      metric: metricCode,
      start,
      end,
    });

    // Skip if no usage
    if (usage.value === 0) continue;

    currency = pricingRule.currency;
    let lineSubtotal: number;
    let unitPriceDisplay: string;
    let tierBreakdown: TierBreakdown[] | undefined;

    if (pricingRule.model === 'tiered' && pricingRule.tiers) {
      // Tiered pricing
      const result = calculateTieredCost(usage.value, pricingRule.tiers);
      lineSubtotal = result.total;
      tierBreakdown = result.breakdown;
      unitPriceDisplay = 'Tiered';
    } else {
      // Flat pricing
      const unitPrice = pricingRule.unit_price ?? 0;
      lineSubtotal = calculateFlatCost(usage.value, unitPrice);
      unitPriceDisplay = `$${unitPrice}`;
    }

    lines.push({
      metric_code: metricCode,
      metric_name: metric.name,
      quantity: usage.value,
      unit: usage.unit,
      unit_price_display: unitPriceDisplay,
      subtotal: lineSubtotal,
      tier_breakdown: tierBreakdown,
    });

    subtotal += lineSubtotal;
  }

  return {
    invoice_id: `inv_${uuidv4().slice(0, 8)}`,
    customer_id,
    period: { start, end },
    lines,
    subtotal: Math.round(subtotal * 100) / 100,
    currency,
    generated_at: Date.now(),
    status: 'draft',
  };
}
