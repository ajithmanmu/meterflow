/**
 * Demo Reset - Clean slate for fraud detection demo
 *
 * Clears all data from ClickHouse and Redis without restarting Docker.
 * Run this before simulate:history to get a fresh demo.
 *
 * Run: pnpm demo:reset
 */

import { createClient } from '@clickhouse/client';
import Redis from 'ioredis';

const CLICKHOUSE_HOST = process.env.CLICKHOUSE_HOST || 'http://localhost:8123';
const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER || 'default';
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD || 'meterflow';
const CLICKHOUSE_DATABASE = process.env.CLICKHOUSE_DATABASE || 'meterflow';

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

function log(emoji: string, message: string) {
  console.log(`${emoji}  ${message}`);
}

async function resetClickHouse(): Promise<void> {
  const client = createClient({
    url: CLICKHOUSE_HOST,
    username: CLICKHOUSE_USER,
    password: CLICKHOUSE_PASSWORD,
    database: CLICKHOUSE_DATABASE,
  });

  try {
    await client.command({ query: `TRUNCATE TABLE IF EXISTS ${CLICKHOUSE_DATABASE}.events` });
    log('OK', 'ClickHouse: truncated events table');
  } catch (error: any) {
    if (error.message?.includes('UNKNOWN_TABLE')) {
      log('OK', 'ClickHouse: events table does not exist yet (will be created on server start)');
    } else {
      throw error;
    }
  } finally {
    await client.close();
  }
}

async function resetRedis(): Promise<void> {
  const redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: 3,
  });

  try {
    await redis.flushall();
    log('OK', 'Redis: flushed all keys (dedup + baselines)');
  } finally {
    redis.disconnect();
  }
}

async function main() {
  console.log('\n========================================');
  console.log('  RESETTING DEMO DATA (CLEAN SLATE)');
  console.log('========================================\n');

  log('...', 'Checking services...');

  try {
    await resetClickHouse();
  } catch (error) {
    console.error('Failed to reset ClickHouse. Is Docker running?', error);
    process.exit(1);
  }

  try {
    await resetRedis();
  } catch (error) {
    console.error('Failed to reset Redis. Is Docker running?', error);
    process.exit(1);
  }

  console.log('\n========================================');
  log('OK', 'Clean slate ready!');
  log('>', 'Next: pnpm simulate:history');
  console.log('========================================\n');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
