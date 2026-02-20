/**
 * Stripe Integration Layer (Mock)
 *
 * Builds real Stripe API payloads without calling Stripe.
 * In production, these functions would use the Stripe SDK:
 *   import Stripe from 'stripe';
 *   const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
 *
 * The payloads match Stripe's actual API structure so this layer
 * can be swapped to real calls with minimal changes.
 */

import { Invoice, InvoiceLine } from '../types/invoice';
import { StripeOperation } from '../types/billing';

/**
 * Build Stripe invoice creation payload
 *
 * In production:
 *   await stripe.invoices.create(payload)
 *
 * Creates a draft invoice on the customer's Stripe account.
 * auto_advance: false keeps it as a draft until we explicitly finalize.
 */
export function buildInvoiceCreate(invoice: Invoice): StripeOperation {
  return {
    step: 1,
    action: 'stripe.invoices.create',
    payload: {
      customer: `cus_${invoice.customer_id}`,
      collection_method: 'send_invoice',
      days_until_due: 30,
      auto_advance: false,
      description: `MeterFlow usage invoice for ${new Date(invoice.period.start).toISOString().split('T')[0]} to ${new Date(invoice.period.end).toISOString().split('T')[0]}`,
      metadata: {
        meterflow_invoice_id: invoice.invoice_id,
        billing_period_start: new Date(invoice.period.start).toISOString(),
        billing_period_end: new Date(invoice.period.end).toISOString(),
        source: 'meterflow',
      },
    },
  };
}

/**
 * Build Stripe invoice item creation payload for a single line
 *
 * In production:
 *   await stripe.invoiceItems.create(payload)
 *
 * Stripe amounts are in cents (smallest currency unit).
 * $10.04 → 1004 cents
 */
export function buildInvoiceItemCreate(
  invoice: Invoice,
  line: InvoiceLine,
  step: number
): StripeOperation {
  // Stripe uses smallest currency unit (cents for USD)
  const amountCents = Math.round(line.subtotal * 100);

  // Build a human-readable description
  let description = `${line.metric_name}: ${line.quantity.toLocaleString()} ${line.unit}`;
  if (line.tier_breakdown && line.tier_breakdown.length > 0) {
    description += ' (Tiered pricing)';
  } else {
    description += ` @ ${line.unit_price_display}/${line.unit}`;
  }

  return {
    step,
    action: 'stripe.invoiceItems.create',
    payload: {
      customer: `cus_${invoice.customer_id}`,
      invoice: `in_${invoice.invoice_id}`,
      amount: amountCents,
      currency: invoice.currency.toLowerCase(),
      description,
      metadata: {
        metric_code: line.metric_code,
        quantity: String(line.quantity),
        meterflow_invoice_id: invoice.invoice_id,
      },
    },
  };
}

/**
 * Build Stripe invoice finalize payload
 *
 * In production:
 *   await stripe.invoices.finalizeInvoice(invoiceId)
 *
 * Finalizing locks the invoice — no more items can be added.
 * This transitions the invoice from 'draft' to 'open'.
 */
export function buildInvoiceFinalize(invoice: Invoice, step: number): StripeOperation {
  return {
    step,
    action: 'stripe.invoices.finalizeInvoice',
    payload: {
      invoice_id: `in_${invoice.invoice_id}`,
    },
  };
}

/**
 * Build Stripe invoice send payload
 *
 * In production:
 *   await stripe.invoices.sendInvoice(invoiceId)
 *
 * Sends the finalized invoice to the customer via email.
 * The customer receives a Stripe-hosted payment page link.
 */
export function buildInvoiceSend(invoice: Invoice, step: number): StripeOperation {
  return {
    step,
    action: 'stripe.invoices.sendInvoice',
    payload: {
      invoice_id: `in_${invoice.invoice_id}`,
    },
  };
}

/**
 * Build all Stripe operations for an invoice
 *
 * Full Stripe billing flow:
 * 1. Create draft invoice
 * 2. Add line items (one per metric)
 * 3. Finalize invoice (locks it)
 * 4. Send to customer (triggers email)
 */
export function buildStripeOperations(invoice: Invoice): StripeOperation[] {
  const operations: StripeOperation[] = [];

  // Step 1: Create draft invoice
  operations.push(buildInvoiceCreate(invoice));

  // Steps 2..N: Add line items
  let step = 2;
  for (const line of invoice.lines) {
    operations.push(buildInvoiceItemCreate(invoice, line, step));
    step++;
  }

  // Step N+1: Finalize invoice
  operations.push(buildInvoiceFinalize(invoice, step));
  step++;

  // Step N+2: Send invoice to customer
  operations.push(buildInvoiceSend(invoice, step));

  return operations;
}
