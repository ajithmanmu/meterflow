/**
 * MeterFlow Validation Script
 *
 * Tests the full flow:
 * 1. Clear all data
 * 2. Insert test events via API
 * 3. Verify data in ClickHouse directly
 * 4. Query usage API and validate results
 * 5. Clean up
 *
 * Run: pnpm validate
 */

import { createClient } from '@clickhouse/client';
import Redis from 'ioredis';

const API_BASE = 'http://localhost:3000';

const clickhouse = createClient({
  url: 'http://localhost:8123',
  username: 'default',
  password: 'meterflow',
  database: 'meterflow',
});

const redis = new Redis();

// Test data
const TEST_CUSTOMER = 'test_customer_validation';
const TEST_EVENTS = [
  { transaction_id: 'val_001', customer_id: TEST_CUSTOMER, event_type: 'api_request', properties: { endpoint: '/users', bytes: 1000 } },
  { transaction_id: 'val_002', customer_id: TEST_CUSTOMER, event_type: 'api_request', properties: { endpoint: '/users', bytes: 2000 } },
  { transaction_id: 'val_003', customer_id: TEST_CUSTOMER, event_type: 'api_request', properties: { endpoint: '/orders', bytes: 500 } },
  { transaction_id: 'val_004', customer_id: TEST_CUSTOMER, event_type: 'storage', properties: { gb_stored: 50 } },
  { transaction_id: 'val_005', customer_id: TEST_CUSTOMER, event_type: 'storage', properties: { gb_stored: 100 } },
];

async function log(emoji: string, message: string) {
  console.log(`${emoji}  ${message}`);
}

async function waitForServer(maxAttempts = 30): Promise<boolean> {
  log('⏳', 'Waiting for server to be ready...');

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${API_BASE}/health`);
      if (response.ok) {
        log('✅', 'Server is ready');
        return true;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  log('❌', 'Server failed to start');
  return false;
}

async function assertEqual(actual: any, expected: any, name: string) {
  if (actual === expected) {
    log('✅', `${name}: ${actual} === ${expected}`);
    return true;
  } else {
    log('❌', `${name}: expected ${expected}, got ${actual}`);
    return false;
  }
}

async function cleanup() {
  log('🧹', 'Cleaning up test data...');

  // Delete test events from ClickHouse
  await clickhouse.command({
    query: `DELETE FROM events WHERE customer_id = '${TEST_CUSTOMER}'`,
  });

  // Delete dedup keys from Redis
  const keys = await redis.keys(`dedup:val_*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }

  log('✅', 'Cleanup complete');
}

async function ingestEvents(): Promise<boolean> {
  log('📥', 'Ingesting test events via API...');

  const now = Date.now();
  const events = TEST_EVENTS.map((e) => ({
    ...e,
    timestamp: now,
  }));

  const response = await fetch(`${API_BASE}/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  });

  const result = await response.json();
  return assertEqual(result.accepted, 5, 'Events accepted');
}

async function verifyClickHouse(): Promise<boolean> {
  log('🔍', 'Verifying data in ClickHouse directly...');

  // Wait a moment for data to be written
  await new Promise((r) => setTimeout(r, 500));

  const result = await clickhouse.query({
    query: `SELECT count() as count FROM events WHERE customer_id = '${TEST_CUSTOMER}'`,
    format: 'JSONEachRow',
  });

  const rows = await result.json<{ count: string }>();
  const count = parseInt(rows[0]?.count || '0', 10);

  return assertEqual(count, 5, 'ClickHouse row count');
}

async function verifyRedis(): Promise<boolean> {
  log('🔍', 'Verifying dedup keys in Redis...');

  const keys = await redis.keys('dedup:val_*');
  return assertEqual(keys.length, 5, 'Redis dedup keys');
}

async function verifyUsageAPI(): Promise<boolean> {
  log('🔍', 'Verifying Usage API results...');

  const now = Date.now();
  const start = now - 3600000; // 1 hour ago
  const end = now + 3600000; // 1 hour from now

  let allPassed = true;

  // Test api_calls COUNT
  const apiCallsRes = await fetch(
    `${API_BASE}/v1/usage?customer_id=${TEST_CUSTOMER}&metric=api_calls&start=${start}&end=${end}`
  );
  const apiCalls = await apiCallsRes.json();
  allPassed = (await assertEqual(apiCalls.value, 3, 'api_calls COUNT')) && allPassed;

  // Test bandwidth SUM
  const bandwidthRes = await fetch(
    `${API_BASE}/v1/usage?customer_id=${TEST_CUSTOMER}&metric=bandwidth&start=${start}&end=${end}`
  );
  const bandwidth = await bandwidthRes.json();
  allPassed = (await assertEqual(bandwidth.value, 3500, 'bandwidth SUM')) && allPassed;

  // Test storage_peak MAX
  const storageRes = await fetch(
    `${API_BASE}/v1/usage?customer_id=${TEST_CUSTOMER}&metric=storage_peak&start=${start}&end=${end}`
  );
  const storage = await storageRes.json();
  allPassed = (await assertEqual(storage.value, 100, 'storage_peak MAX')) && allPassed;

  // Test group_by
  const groupByRes = await fetch(
    `${API_BASE}/v1/usage?customer_id=${TEST_CUSTOMER}&metric=api_calls&start=${start}&end=${end}&group_by=endpoint`
  );
  const groupBy = await groupByRes.json();
  allPassed = (await assertEqual(groupBy.breakdown?.['/users'], 2, 'group_by /users')) && allPassed;
  allPassed = (await assertEqual(groupBy.breakdown?.['/orders'], 1, 'group_by /orders')) && allPassed;

  return allPassed;
}

async function verifyDuplicateRejection(): Promise<boolean> {
  log('🔍', 'Verifying duplicate rejection...');

  const now = Date.now();
  const response = await fetch(`${API_BASE}/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      events: [{ transaction_id: 'val_001', customer_id: TEST_CUSTOMER, event_type: 'api_request', timestamp: now, properties: {} }],
    }),
  });

  const result = await response.json();
  return assertEqual(result.duplicates, 1, 'Duplicate rejected');
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║           METERFLOW VALIDATION SCRIPT                      ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  let allPassed = true;

  try {
    // Step 0: Wait for server to be ready
    const serverReady = await waitForServer();
    if (!serverReady) {
      console.error('Server not available. Make sure to run: pnpm start');
      process.exit(1);
    }

    // Step 1: Cleanup any existing test data
    await cleanup();

    // Step 2: Ingest events
    allPassed = (await ingestEvents()) && allPassed;

    // Step 3: Verify ClickHouse
    allPassed = (await verifyClickHouse()) && allPassed;

    // Step 4: Verify Redis
    allPassed = (await verifyRedis()) && allPassed;

    // Step 5: Verify Usage API
    allPassed = (await verifyUsageAPI()) && allPassed;

    // Step 6: Verify duplicate rejection
    allPassed = (await verifyDuplicateRejection()) && allPassed;

    // Step 7: Cleanup
    await cleanup();

    console.log('\n' + '═'.repeat(60));
    if (allPassed) {
      console.log('✅ ALL VALIDATIONS PASSED');
    } else {
      console.log('❌ SOME VALIDATIONS FAILED');
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Validation script error:', error);
    process.exit(1);
  } finally {
    await clickhouse.close();
    redis.disconnect();
  }
}

main();
