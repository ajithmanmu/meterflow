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

// TypeScript types derived from schemas
export type UsageEvent = Static<typeof UsageEventSchema>;
export type BatchEventRequest = Static<typeof BatchEventRequestSchema>;
export type EventIngestionResponse = Static<typeof EventIngestionResponseSchema>;
