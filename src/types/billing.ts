/**
 * Billing Cycle Types
 *
 * Types for the billing cycle runner and Stripe integration layer.
 */

import { Invoice } from './invoice';

/** Parameters for running a billing cycle */
export interface BillingRunParams {
  customer_id: string;
  /** Billing period start (Unix ms) */
  start: number;
  /** Billing period end (Unix ms) */
  end: number;
}

/** A single Stripe API operation that would be executed */
export interface StripeOperation {
  /** Execution order */
  step: number;
  /** Stripe SDK method (e.g., "stripe.invoices.create") */
  action: string;
  /** The payload that would be sent to Stripe */
  payload: Record<string, unknown>;
}

/** Summary of all Stripe operations */
export interface StripeOperationsSummary {
  /** Total amount in cents (Stripe uses smallest currency unit) */
  total_amount_cents: number;
  /** Currency code (lowercase for Stripe) */
  currency: string;
  /** Number of line items */
  line_items: number;
  /** Idempotency key to prevent duplicate billing */
  idempotency_key: string;
}

/** The full set of Stripe operations for a billing run */
export interface StripeOperations {
  /** Always "dry_run" — Stripe is not actually called */
  mode: 'dry_run';
  /** Ordered list of API calls that would be made */
  operations: StripeOperation[];
  /** Billing summary */
  summary: StripeOperationsSummary;
}

/** Result of a billing cycle run */
export interface BillingRunResult {
  /** The calculated MeterFlow invoice */
  invoice: Invoice;
  /** The Stripe API calls that would be executed */
  stripe_operations: StripeOperations;
}
