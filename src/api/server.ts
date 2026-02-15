import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  BatchEventRequestSchema,
  EventIngestionResponseSchema,
  UsageQuerySchema,
  UsageQueryResponseSchema,
  AnomalyCheckSchema,
  AnomalyCheckResponseSchema,
  PricingListResponseSchema,
  PricingRuleSchema,
  InvoiceCalculateRequestSchema,
  InvoiceResponseSchema,
  ErrorResponseSchema,
  UsageEvent,
  EventIngestionResponse,
} from './schemas';
import { validateEvent } from './validation';
import { checkAndMarkTransactions } from '../utils/dedup';
import { initRedis } from '../config/redis';
import { initClickHouse } from '../config/clickhouse';
import { initMinio } from '../config/minio';
import { insertEvents } from '../utils/storage';
import { backupEvents } from '../utils/backup';
import { queryUsage } from '../utils/usage';
import { checkAnomaly } from '../utils/anomaly';
import { calculateInvoice } from '../utils/invoice';
import { METRICS_CATALOG } from '../config/metrics';
import { getAllPricingRules, getPricingRule } from '../config/pricing';

const app = Fastify({
  logger: true,
}).withTypeProvider<TypeBoxTypeProvider>();

/**
 * POST /v1/events - Ingest batch of usage events
 *
 * Sync processing:
 * 1. Schema validation (automatic via Fastify)
 * 2. Business validation (timestamp, format checks)
 * 3. Deduplication check (Redis)
 * 4. Store events (ClickHouse)
 * 5. Backup raw batch (MinIO)
 */
app.post(
  '/v1/events',
  {
    schema: {
      body: BatchEventRequestSchema,
      response: {
        200: EventIngestionResponseSchema,
      },
    },
  },
  async (request, reply) => {
    const { events } = request.body;

    const validEvents: UsageEvent[] = [];
    const accepted: UsageEvent[] = [];
    const duplicates: string[] = [];
    const failed: Array<{ transaction_id: string; reason: string }> = [];

    // Step 1: Validate each event
    for (const event of events) {
      const validation = validateEvent(event);

      if (!validation.valid) {
        failed.push({
          transaction_id: event.transaction_id,
          reason: validation.reason!,
        });
        continue;
      }

      validEvents.push(event);
    }

    // Step 2: Check Redis for duplicates (batch operation)
    if (validEvents.length > 0) {
      const transactionIds = validEvents.map((e) => e.transaction_id);
      const dedupResults = await checkAndMarkTransactions(transactionIds);

      for (const event of validEvents) {
        const isNew = dedupResults.get(event.transaction_id);

        if (isNew) {
          accepted.push(event);
        } else {
          duplicates.push(event.transaction_id);
        }
      }
    }

    // Step 3: Store accepted events in ClickHouse
    if (accepted.length > 0) {
      await insertEvents(accepted);
    }

    // Step 4: Backup raw batch to MinIO
    if (accepted.length > 0) {
      await backupEvents(accepted);
    }

    const response: EventIngestionResponse = {
      accepted: accepted.length,
      duplicates: duplicates.length,
      failed,
    };

    return reply.status(200).send(response);
  }
);

/**
 * GET /v1/usage - Query aggregated usage for a customer
 *
 * Uses Billable Metrics catalog to translate metric code into ClickHouse aggregation.
 * Supports optional group_by for dimensional breakdown.
 */
app.get(
  '/v1/usage',
  {
    schema: {
      querystring: UsageQuerySchema,
      response: {
        200: UsageQueryResponseSchema,
      },
    },
  },
  async (request, reply) => {
    const { customer_id, metric, start, end, group_by } = request.query;

    const result = await queryUsage({
      customer_id,
      metric,
      start,
      end,
      group_by,
    });

    return reply.status(200).send(result);
  }
);

/**
 * GET /v1/metrics - List available billable metrics
 */
app.get('/v1/metrics', async () => {
  return { metrics: METRICS_CATALOG };
});

/**
 * GET /v1/anomalies/check - Check if current usage is anomalous
 *
 * Compares current period usage against historical baseline using Z-score.
 * Z-score = (current_value - mean) / stddev
 *
 * Severity levels:
 * - normal: |z| < 2
 * - warning: 2 <= |z| < 3
 * - critical: |z| >= 3 (default threshold)
 *
 * Production note: In a production environment, this would be a scheduled job
 * running on AWS Lambda + EventBridge, storing anomalies in a dedicated table
 * for alerting and dashboard consumption. See docs/PRODUCTION_ANOMALY_DETECTION.md
 */
app.get(
  '/v1/anomalies/check',
  {
    schema: {
      querystring: AnomalyCheckSchema,
      response: {
        200: AnomalyCheckResponseSchema,
      },
    },
  },
  async (request, reply) => {
    const { customer_id, metric, current_start, current_end, baseline_days, threshold } = request.query;

    const result = await checkAnomaly({
      customer_id,
      metric,
      current_start,
      current_end,
      baseline_days,
      threshold,
    });

    return reply.status(200).send(result);
  }
);

/**
 * GET /v1/pricing - List all pricing rules
 */
app.get(
  '/v1/pricing',
  {
    schema: {
      response: {
        200: PricingListResponseSchema,
      },
    },
  },
  async () => {
    return { pricing: getAllPricingRules() };
  }
);

/**
 * GET /v1/pricing/:metric_code - Get pricing for a specific metric
 */
app.get(
  '/v1/pricing/:metric_code',
  {
    schema: {
      response: {
        200: PricingRuleSchema,
        404: ErrorResponseSchema,
      },
    },
  },
  async (request, reply) => {
    const { metric_code } = request.params as { metric_code: string };
    const rule = getPricingRule(metric_code);

    if (!rule) {
      return reply.status(404).send({ error: `Pricing rule not found for metric: ${metric_code}` });
    }

    return rule;
  }
);

/**
 * POST /v1/invoices/calculate - Calculate invoice for a billing period
 *
 * Takes customer_id and billing period (start/end timestamps).
 * Returns draft invoice with line items for each metric used.
 *
 * Supports:
 * - Flat pricing: simple unit_price × quantity
 * - Tiered pricing: progressive tiers with volume discounts
 */
app.post(
  '/v1/invoices/calculate',
  {
    schema: {
      body: InvoiceCalculateRequestSchema,
      response: {
        200: InvoiceResponseSchema,
      },
    },
  },
  async (request, reply) => {
    const { customer_id, start, end } = request.body;

    const invoice = await calculateInvoice({
      customer_id,
      start,
      end,
    });

    return reply.status(200).send(invoice);
  }
);

// Health check endpoint
app.get('/health', async () => {
  return { status: 'ok' };
});

// Start server
const start = async () => {
  try {
    // Initialize storage backends
    await initRedis();
    await initClickHouse();
    await initMinio();

    await app.listen({ port: 3000, host: '0.0.0.0' });
    console.log('MeterFlow API running on http://localhost:3000');
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
