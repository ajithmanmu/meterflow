/**
 * Usage event schema for MeterFlow
 *
 * Each event represents a single billable occurrence (API call, storage operation, etc.)
 * Properties capture resource consumption for that specific occurrence.
 */

export interface UsageEvent {
  /** Unique identifier for idempotency - prevents duplicate processing */
  transaction_id: string;

  /** Customer identifier - who this usage belongs to */
  customer_id: string;

  /** Event type - maps to a billable metric (e.g., "api_request", "storage", "compute") */
  event_type: string;

  /** Unix epoch milliseconds - when the event occurred (client-provided) */
  timestamp: number;

  /** Flexible key-value properties - resource consumption data */
  properties: Record<string, string | number | boolean>;
}

/** Batch request wrapper for ingesting multiple events */
export interface BatchEventRequest {
  events: UsageEvent[];
}

/** Response for event ingestion */
export interface EventIngestionResponse {
  /** Number of events successfully accepted */
  accepted: number;

  /** Number of duplicate events (already processed, skipped) */
  duplicates: number;

  /** Failed events with reasons */
  failed: Array<{
    transaction_id: string;
    reason: string;
  }>;
}
