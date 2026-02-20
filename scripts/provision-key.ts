/**
 * Provision API Key
 *
 * CLI tool to create API keys for customers.
 * Connects directly to Redis (no server needed).
 *
 * Usage: pnpm provision-key <customer_id> [name]
 * Example: pnpm provision-key test_customer "My Test Key"
 */

import { initRedis } from '../src/config/redis';
import { redis } from '../src/config/redis';
import { provisionApiKey } from '../src/utils/auth';

async function main() {
  const customerId = process.argv[2];
  const name = process.argv[3] || 'default';

  if (!customerId) {
    console.log('Usage: pnpm provision-key <customer_id> [name]');
    console.log('Example: pnpm provision-key test_customer "My Test Key"');
    process.exit(1);
  }

  await initRedis();

  const apiKey = await provisionApiKey({
    customer_id: customerId,
    name,
  });

  console.log('\nAPI Key provisioned:');
  console.log(`  Customer: ${customerId}`);
  console.log(`  Name:     ${name}`);
  console.log(`  Key:      ${apiKey}`);
  console.log(`\nUse with: -H "X-API-Key: ${apiKey}"`);

  redis.disconnect();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
