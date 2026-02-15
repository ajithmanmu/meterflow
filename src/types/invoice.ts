/**
 * Invoice Types
 */

export interface TierBreakdown {
  /** Tier range description (e.g., "0-1000", "1001-10000") */
  tier: string;
  /** Quantity consumed in this tier */
  quantity: number;
  /** Unit price for this tier */
  unit_price: number;
  /** Amount for this tier (quantity * unit_price) */
  amount: number;
}

export interface InvoiceLine {
  /** Metric code from METRICS_CATALOG */
  metric_code: string;
  /** Human-readable metric name */
  metric_name: string;
  /** Total quantity consumed */
  quantity: number;
  /** Unit of measurement */
  unit: string;
  /** Display string for unit price ("Tiered" or "$0.001") */
  unit_price_display: string;
  /** Line subtotal */
  subtotal: number;
  /** For tiered pricing: breakdown by tier */
  tier_breakdown?: TierBreakdown[];
}

export interface Invoice {
  /** Unique invoice identifier */
  invoice_id: string;
  /** Customer identifier */
  customer_id: string;
  /** Billing period */
  period: {
    start: number;
    end: number;
  };
  /** Line items */
  lines: InvoiceLine[];
  /** Sum of all line subtotals */
  subtotal: number;
  /** Currency code */
  currency: string;
  /** When invoice was generated (Unix ms) */
  generated_at: number;
  /** Invoice status */
  status: 'draft' | 'finalized';
}

export interface InvoiceCalculationParams {
  customer_id: string;
  start: number;
  end: number;
}
