/**
 * Billing Cycle Runner
 *
 * Ties together invoice calculation and Stripe integration.
 * Calculates usage-based invoices and produces the Stripe API payloads
 * that would be executed to bill the customer.
 *
 * In production, this would run as a scheduled job (e.g., AWS Lambda + EventBridge)
 * at the end of each billing period:
 *
 *   EventBridge (cron: 1st of month) → Lambda → calculateInvoice() → Stripe API
 *
 * The current implementation runs as a dry-run: it builds the payloads
 * but does not call Stripe. Swap buildStripeOperations() for real Stripe
 * SDK calls to go live.
 */

import { calculateInvoice } from './invoice';
import { buildStripeOperations } from './stripe';
import { BillingRunParams, BillingRunResult } from '../types/billing';

/**
 * Run a billing cycle for a customer
 *
 * 1. Calculate the MeterFlow invoice (usage → pricing → line items)
 * 2. Build Stripe API payloads (dry-run)
 * 3. Return both for inspection
 *
 * Idempotency: The idempotency key is derived from customer_id + billing period,
 * so running the same billing cycle twice produces the same key. Stripe uses this
 * to prevent duplicate charges.
 */
export async function runBillingCycle(params: BillingRunParams): Promise<BillingRunResult> {
  const { customer_id, start, end } = params;

  // Step 1: Calculate invoice using existing MeterFlow logic
  const invoice = await calculateInvoice({ customer_id, start, end });

  // Step 2: Build Stripe operations (dry-run)
  const operations = buildStripeOperations(invoice);

  // Step 3: Build idempotency key from billing period
  // This prevents duplicate billing if the job runs twice for the same period
  const periodKey = `${customer_id}_${start}_${end}`;
  const idempotencyKey = `meterflow_${invoice.invoice_id}_${periodKey}`;

  // Total in cents for Stripe
  const totalCents = Math.round(invoice.subtotal * 100);

  return {
    invoice,
    stripe_operations: {
      mode: 'dry_run',
      operations,
      summary: {
        total_amount_cents: totalCents,
        currency: invoice.currency.toLowerCase(),
        line_items: invoice.lines.length,
        idempotency_key: idempotencyKey,
      },
    },
  };
}
