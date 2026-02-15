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

async function verifyAnomalyAPI(): Promise<boolean> {
  log('🔍', 'Verifying Anomaly Detection API...');

  const now = Date.now();
  const start = now - 3600000; // 1 hour ago
  const end = now + 3600000; // 1 hour from now

  // Test anomaly check endpoint
  const response = await fetch(
    `${API_BASE}/v1/anomalies/check?customer_id=${TEST_CUSTOMER}&metric=api_calls&current_start=${start}&current_end=${end}`
  );

  if (!response.ok) {
    log('❌', `Anomaly API returned status ${response.status}`);
    return false;
  }

  const result = await response.json();

  let allPassed = true;

  // Verify response structure
  allPassed = (await assertEqual(result.customer_id, TEST_CUSTOMER, 'Anomaly customer_id')) && allPassed;
  allPassed = (await assertEqual(result.metric, 'api_calls', 'Anomaly metric')) && allPassed;
  allPassed = (await assertEqual(typeof result.z_score, 'number', 'Anomaly z_score type')) && allPassed;
  allPassed = (await assertEqual(typeof result.is_anomaly, 'boolean', 'Anomaly is_anomaly type')) && allPassed;
  allPassed = (await assertEqual(['normal', 'warning', 'critical'].includes(result.severity), true, 'Anomaly severity valid')) && allPassed;

  log('📊', `Z-score: ${result.z_score}, Severity: ${result.severity}`);

  return allPassed;
}

async function verifyPricingAPI(): Promise<boolean> {
  log('🔍', 'Verifying Pricing API...');

  let allPassed = true;

  // Test list all pricing rules
  const listResponse = await fetch(`${API_BASE}/v1/pricing`);
  if (!listResponse.ok) {
    log('❌', `Pricing list API returned status ${listResponse.status}`);
    return false;
  }

  const listResult = await listResponse.json();
  allPassed = (await assertEqual(Array.isArray(listResult.pricing), true, 'Pricing list is array')) && allPassed;
  allPassed = (await assertEqual(listResult.pricing.length, 4, 'Pricing has 4 metrics')) && allPassed;

  // Test get single pricing rule
  const singleResponse = await fetch(`${API_BASE}/v1/pricing/api_calls`);
  const singleResult = await singleResponse.json();
  allPassed = (await assertEqual(singleResult.metric_code, 'api_calls', 'api_calls pricing found')) && allPassed;
  allPassed = (await assertEqual(singleResult.model, 'tiered', 'api_calls is tiered')) && allPassed;
  allPassed = (await assertEqual(singleResult.tiers?.length, 3, 'api_calls has 3 tiers')) && allPassed;

  // Test 404 for unknown metric
  const notFoundResponse = await fetch(`${API_BASE}/v1/pricing/unknown_metric`);
  allPassed = (await assertEqual(notFoundResponse.status, 404, 'Unknown metric returns 404')) && allPassed;

  return allPassed;
}

async function verifyInvoiceAPI(): Promise<boolean> {
  log('🔍', 'Verifying Invoice API...');

  const now = Date.now();
  const start = now - 3600000; // 1 hour ago
  const end = now + 3600000; // 1 hour from now

  let allPassed = true;

  // Calculate invoice for test customer
  const response = await fetch(`${API_BASE}/v1/invoices/calculate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_id: TEST_CUSTOMER,
      start,
      end,
    }),
  });

  if (!response.ok) {
    log('❌', `Invoice API returned status ${response.status}`);
    return false;
  }

  const invoice = await response.json();

  // Verify invoice structure
  allPassed = (await assertEqual(invoice.customer_id, TEST_CUSTOMER, 'Invoice customer_id')) && allPassed;
  allPassed = (await assertEqual(typeof invoice.invoice_id, 'string', 'Invoice has invoice_id')) && allPassed;
  allPassed = (await assertEqual(invoice.status, 'draft', 'Invoice status is draft')) && allPassed;
  allPassed = (await assertEqual(invoice.currency, 'USD', 'Invoice currency is USD')) && allPassed;
  allPassed = (await assertEqual(Array.isArray(invoice.lines), true, 'Invoice has lines array')) && allPassed;

  // Verify we have line items for api_calls (3 events) and bandwidth (3500 bytes) and storage_peak (100 GB)
  const apiCallsLine = invoice.lines.find((l: any) => l.metric_code === 'api_calls');
  const bandwidthLine = invoice.lines.find((l: any) => l.metric_code === 'bandwidth');
  const storageLine = invoice.lines.find((l: any) => l.metric_code === 'storage_peak');

  if (apiCallsLine) {
    allPassed = (await assertEqual(apiCallsLine.quantity, 3, 'api_calls quantity')) && allPassed;
    allPassed = (await assertEqual(apiCallsLine.unit_price_display, 'Tiered', 'api_calls is tiered')) && allPassed;
    // 3 calls in free tier = $0
    allPassed = (await assertEqual(apiCallsLine.subtotal, 0, 'api_calls subtotal (free tier)')) && allPassed;
  } else {
    log('❌', 'api_calls line not found');
    allPassed = false;
  }

  if (bandwidthLine) {
    allPassed = (await assertEqual(bandwidthLine.quantity, 3500, 'bandwidth quantity')) && allPassed;
    // 3500 bytes × $0.00001 = $0.035 → rounds to $0.04
    allPassed = (await assertEqual(bandwidthLine.subtotal, 0.04, 'bandwidth subtotal')) && allPassed;
  } else {
    log('❌', 'bandwidth line not found');
    allPassed = false;
  }

  if (storageLine) {
    allPassed = (await assertEqual(storageLine.quantity, 100, 'storage_peak quantity')) && allPassed;
    // 100 GB × $0.10 = $10.00
    allPassed = (await assertEqual(storageLine.subtotal, 10, 'storage_peak subtotal')) && allPassed;
  } else {
    log('❌', 'storage_peak line not found');
    allPassed = false;
  }

  log('💵', `Invoice total: $${invoice.subtotal}`);

  return allPassed;
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

    // Step 7: Verify Anomaly Detection API
    allPassed = (await verifyAnomalyAPI()) && allPassed;

    // Step 8: Verify Pricing API
    allPassed = (await verifyPricingAPI()) && allPassed;

    // Step 9: Verify Invoice API
    allPassed = (await verifyInvoiceAPI()) && allPassed;

    // Step 10: Cleanup
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
