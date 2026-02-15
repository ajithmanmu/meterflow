import { Type, Static } from '@sinclair/typebox';

/**
 * Single usage event schema with validation
 */
export const UsageEventSchema = Type.Object({
  transaction_id: Type.String({ minLength: 1, maxLength: 255 }),
  customer_id: Type.String({ minLength: 1, maxLength: 255 }),
  event_type: Type.String({ minLength: 1, maxLength: 100 }),
  timestamp: Type.Number({ minimum: 0 }),
  properties: Type.Record(
    Type.String(),
    Type.Union([Type.String(), Type.Number(), Type.Boolean()])
  ),
});

/**
 * Batch request schema - array of events
 */
export const BatchEventRequestSchema = Type.Object({
  events: Type.Array(UsageEventSchema, { minItems: 1, maxItems: 1000 }),
});

/**
 * Response schema for event ingestion
 */
export const EventIngestionResponseSchema = Type.Object({
  accepted: Type.Number(),
  duplicates: Type.Number(),
  failed: Type.Array(
    Type.Object({
      transaction_id: Type.String(),
      reason: Type.String(),
    })
  ),
});

/**
 * Usage Query request schema (query params)
 */
export const UsageQuerySchema = Type.Object({
  customer_id: Type.String({ minLength: 1 }),
  metric: Type.String({ minLength: 1 }),
  start: Type.Number({ minimum: 0 }),
  end: Type.Number({ minimum: 0 }),
  group_by: Type.Optional(Type.String()),
});

/**
 * Usage Query response schema
 */
export const UsageQueryResponseSchema = Type.Object({
  customer_id: Type.String(),
  metric: Type.String(),
  period: Type.Object({
    start: Type.Number(),
    end: Type.Number(),
  }),
  value: Type.Number(),
  unit: Type.String(),
  breakdown: Type.Optional(Type.Record(Type.String(), Type.Number())),
});

/**
 * Anomaly Check request schema (query params)
 */
export const AnomalyCheckSchema = Type.Object({
  customer_id: Type.String({ minLength: 1 }),
  metric: Type.String({ minLength: 1 }),
  current_start: Type.Number({ minimum: 0 }),
  current_end: Type.Number({ minimum: 0 }),
  baseline_days: Type.Optional(Type.Number({ minimum: 1, maximum: 365 })),
  threshold: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
});

/**
 * Anomaly Check response schema
 */
export const AnomalyCheckResponseSchema = Type.Object({
  customer_id: Type.String(),
  metric: Type.String(),
  period: Type.Object({
    start: Type.Number(),
    end: Type.Number(),
  }),
  current_value: Type.Number(),
  baseline: Type.Object({
    mean: Type.Number(),
    stddev: Type.Number(),
    sample_count: Type.Number(),
  }),
  z_score: Type.Number(),
  is_anomaly: Type.Boolean(),
  severity: Type.Union([
    Type.Literal('normal'),
    Type.Literal('warning'),
    Type.Literal('critical'),
  ]),
  unit: Type.String(),
});

/**
 * Pricing tier schema
 */
export const PricingTierSchema = Type.Object({
  up_to: Type.Union([Type.Number(), Type.Null()]),
  unit_price: Type.Number(),
});

/**
 * Pricing rule schema
 */
export const PricingRuleSchema = Type.Object({
  metric_code: Type.String(),
  model: Type.Union([Type.Literal('flat'), Type.Literal('tiered')]),
  currency: Type.String(),
  unit_price: Type.Optional(Type.Number()),
  tiers: Type.Optional(Type.Array(PricingTierSchema)),
});

/**
 * Pricing list response schema
 */
export const PricingListResponseSchema = Type.Object({
  pricing: Type.Array(PricingRuleSchema),
});

/**
 * Error response schema
 */
export const ErrorResponseSchema = Type.Object({
  error: Type.String(),
});

/**
 * Invoice calculation request schema (body)
 */
export const InvoiceCalculateRequestSchema = Type.Object({
  customer_id: Type.String({ minLength: 1 }),
  start: Type.Number({ minimum: 0 }),
  end: Type.Number({ minimum: 0 }),
});

/**
 * Invoice tier breakdown schema
 */
export const TierBreakdownSchema = Type.Object({
  tier: Type.String(),
  quantity: Type.Number(),
  unit_price: Type.Number(),
  amount: Type.Number(),
});

/**
 * Invoice line schema
 */
export const InvoiceLineSchema = Type.Object({
  metric_code: Type.String(),
  metric_name: Type.String(),
  quantity: Type.Number(),
  unit: Type.String(),
  unit_price_display: Type.String(),
  subtotal: Type.Number(),
  tier_breakdown: Type.Optional(Type.Array(TierBreakdownSchema)),
});

/**
 * Invoice response schema
 */
export const InvoiceResponseSchema = Type.Object({
  invoice_id: Type.String(),
  customer_id: Type.String(),
  period: Type.Object({
    start: Type.Number(),
    end: Type.Number(),
  }),
  lines: Type.Array(InvoiceLineSchema),
  subtotal: Type.Number(),
  currency: Type.String(),
  generated_at: Type.Number(),
  status: Type.Union([Type.Literal('draft'), Type.Literal('finalized')]),
});

// TypeScript types derived from schemas
export type UsageEvent = Static<typeof UsageEventSchema>;
export type BatchEventRequest = Static<typeof BatchEventRequestSchema>;
export type EventIngestionResponse = Static<typeof EventIngestionResponseSchema>;
export type UsageQuery = Static<typeof UsageQuerySchema>;
export type UsageQueryResponse = Static<typeof UsageQueryResponseSchema>;
export type AnomalyCheck = Static<typeof AnomalyCheckSchema>;
export type AnomalyCheckResponse = Static<typeof AnomalyCheckResponseSchema>;
export type PricingRule = Static<typeof PricingRuleSchema>;
export type InvoiceCalculateRequest = Static<typeof InvoiceCalculateRequestSchema>;
export type InvoiceResponse = Static<typeof InvoiceResponseSchema>;
