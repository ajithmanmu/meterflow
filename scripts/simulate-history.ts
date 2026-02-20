/**
 * Simulate Historical Usage Data
 *
 * Generates 30 days of realistic usage data with:
 * - Business hours pattern (peaks 9am-5pm)
 * - Weekday vs weekend variation
 * - Natural randomness
 *
 * Run: pnpm simulate:history
 */

const API_BASE = 'http://localhost:3000';
const TEST_CUSTOMER = 'test_customer';
let API_KEY = '';

// Business hours distribution (normalized weights for each hour)
// Peak hours: 9am-5pm, low hours: 10pm-6am
const BUSINESS_HOURS_PATTERN = [
  0.01, 0.005, 0.003, 0.002, 0.002, 0.005,  // 00-05 (night)
  0.015, 0.04, 0.08, 0.10, 0.10, 0.095,     // 06-11 (morning ramp-up)
  0.09, 0.095, 0.10, 0.095, 0.085, 0.07,    // 12-17 (afternoon)
  0.05, 0.035, 0.025, 0.015, 0.01, 0.008,   // 18-23 (evening wind-down)
];

// Weekend has lower overall volume
const WEEKEND_MULTIPLIER = 0.3;

// Base daily volume (will vary by day)
const BASE_DAILY_VOLUME = 1000;
const VOLUME_VARIANCE = 0.2; // +/- 20%

function log(emoji: string, message: string) {
  console.log(`${emoji}  ${message}`);
}

function randomVariance(base: number, variance: number): number {
  const factor = 1 + (Math.random() * 2 - 1) * variance;
  return Math.round(base * factor);
}

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

async function generateEventsForDay(date: Date): Promise<number> {
  const dateStr = date.toISOString().split('T')[0];
  const isWeekendDay = isWeekend(date);

  // Calculate daily volume
  let dailyVolume = randomVariance(BASE_DAILY_VOLUME, VOLUME_VARIANCE);
  if (isWeekendDay) {
    dailyVolume = Math.round(dailyVolume * WEEKEND_MULTIPLIER);
  }

  const events: any[] = [];

  // Distribute events across hours based on pattern
  for (let hour = 0; hour < 24; hour++) {
    const hourWeight = BUSINESS_HOURS_PATTERN[hour];
    const hourCount = Math.round(dailyVolume * hourWeight);

    for (let i = 0; i < hourCount; i++) {
      // Random minute within the hour
      const minute = Math.floor(Math.random() * 60);
      const second = Math.floor(Math.random() * 60);

      const timestamp = new Date(date);
      timestamp.setUTCHours(hour, minute, second, 0);

      events.push({
        transaction_id: `hist_${dateStr}_${hour}_${i}_${Math.random().toString(36).slice(2, 8)}`,
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
      headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
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
  console.log('  SIMULATING 30 DAYS OF HISTORICAL DATA');
  console.log('========================================\n');

  // Wait for server
  const serverReady = await waitForServer();
  if (!serverReady) {
    console.error('Server not available. Run: pnpm dev');
    process.exit(1);
  }

  // Provision API key for simulation
  log('...', 'Provisioning API key...');
  const keyRes = await fetch(`${API_BASE}/v1/admin/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_id: TEST_CUSTOMER, name: 'simulate-history' }),
  });
  const keyData = await keyRes.json() as { api_key: string };
  API_KEY = keyData.api_key;
  log('OK', `API key provisioned: ${API_KEY.slice(0, 12)}...`);

  // Generate 30 days of history (starting from 31 days ago to yesterday)
  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 1); // Yesterday
  endDate.setUTCHours(0, 0, 0, 0);

  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 28); // 29 days total (avoids 30-day validation boundary)

  let totalEvents = 0;

  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];

    const count = await generateEventsForDay(new Date(d));
    totalEvents += count;

    log('OK', `${dateStr} (${dayName}): ${count} events`);
  }

  console.log('\n========================================');
  log('OK', `Total events generated: ${totalEvents}`);
  log('>', 'Next: Build baselines with POST /v1/fraud/baselines/build');
  console.log('========================================\n');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
