import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  BatchEventRequestSchema,
  EventIngestionResponseSchema,
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
