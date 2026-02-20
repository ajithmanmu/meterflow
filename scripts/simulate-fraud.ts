/**
 * Simulate Fraudulent Usage
 *
 * Injects events with "fraudulent" pattern:
 * - Same daily volume as normal (~1000 events)
 * - But peaks at NIGHT (10pm-4am) instead of business hours (9am-5pm)
 *
 * This simulates a stolen API key being used from a different timezone.
 *
 * Run: pnpm simulate:fraud
 */

const API_BASE = 'http://localhost:3000';
const TEST_CUSTOMER = 'test_customer';

// FRAUDULENT pattern - peaks at night instead of business hours
// This is roughly the inverse of business hours
const FRAUD_HOURS_PATTERN = [
  0.10, 0.095, 0.09, 0.085, 0.08, 0.06,     // 00-05 (night - HIGH)
  0.04, 0.02, 0.015, 0.01, 0.01, 0.015,     // 06-11 (morning - LOW)
  0.02, 0.015, 0.01, 0.01, 0.015, 0.02,     // 12-17 (afternoon - LOW)
  0.04, 0.06, 0.08, 0.095, 0.10, 0.10,      // 18-23 (evening ramp-up to night)
];

// Similar volume to normal day
const FRAUD_DAILY_VOLUME = 1000;

function log(emoji: string, message: string) {
  console.log(`${emoji}  ${message}`);
}

function randomVariance(base: number, variance: number): number {
  const factor = 1 + (Math.random() * 2 - 1) * variance;
  return Math.round(base * factor);
}

async function generateFraudulentEvents(): Promise<number> {
  const today = new Date();
  const dateStr = today.toISOString().split('T')[0];

  const events: any[] = [];

  // Distribute events across hours based on FRAUD pattern
  for (let hour = 0; hour < 24; hour++) {
    const hourWeight = FRAUD_HOURS_PATTERN[hour];
    const hourCount = Math.round(FRAUD_DAILY_VOLUME * hourWeight);

    for (let i = 0; i < hourCount; i++) {
      // Random minute within the hour
      const minute = Math.floor(Math.random() * 60);
      const second = Math.floor(Math.random() * 60);

      const timestamp = new Date(today);
      timestamp.setUTCHours(hour, minute, second, 0);

      // Only include events that are in the past
      if (timestamp > new Date()) {
        continue;
      }

      events.push({
        transaction_id: `fraud_${dateStr}_${hour}_${i}_${Math.random().toString(36).slice(2, 8)}`,
        customer_id: TEST_CUSTOMER,
        event_type: 'api_request',
        timestamp: timestamp.getTime(),
        properties: {
          endpoint: ['/users', '/orders', '/products', '/search'][Math.floor(Math.random() * 4)],
          bytes: randomVariance(500, 0.5),
        },
      });
    }
  }

  // Send events in batches of 500
  const batchSize = 500;
  for (let i = 0; i < events.length; i += batchSize) {
    const batch = events.slice(i, i + batchSize);

    const response = await fetch(`${API_BASE}/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch }),
    });

    if (!response.ok) {
      throw new Error(`Failed to ingest events: ${response.status}`);
    }
  }

  return events.length;
}

async function waitForServer(maxAttempts = 30): Promise<boolean> {
  log('...', 'Waiting for server...');

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${API_BASE}/health`);
      if (response.ok) {
        log('OK', 'Server is ready');
        return true;
      }
    } catch {
      // Server not ready
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  return false;
}

async function main() {
  console.log('\n========================================');
  console.log('  SIMULATING FRAUDULENT USAGE PATTERN');
  console.log('========================================\n');

  log('!', 'This simulates a stolen API key being used from a different timezone');
  log('!', 'Normal pattern: peaks 9am-5pm');
  log('!', 'Fraud pattern: peaks 10pm-4am\n');

  // Wait for server
  const serverReady = await waitForServer();
  if (!serverReady) {
    console.error('Server not available. Run: pnpm dev');
    process.exit(1);
  }

  const count = await generateFraudulentEvents();

  console.log('\n========================================');
  log('OK', `Injected ${count} fraudulent events for today`);
  log('>', 'Refresh dashboard to see FRAUD DETECTED alert');
  log('>', 'http://localhost:3000/dashboard/');
  console.log('========================================\n');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
