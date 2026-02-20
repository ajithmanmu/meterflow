/**
 * API Key Authentication Utilities
 *
 * Manages API keys in Redis. Each key maps to a customer_id
 * and controls access scoping + rate limits.
 *
 * Redis key format: apikey:{key} → JSON of ApiKeyRecord
 */

import { randomUUID } from 'crypto';
import { redis } from '../config/redis';
import { API_KEY_PREFIX, DEFAULT_RATE_LIMIT } from '../config/auth';
import { ApiKeyRecord } from '../types/auth';

/**
 * Look up an API key in Redis
 * Returns the associated customer record, or null if invalid
 */
export async function lookupApiKey(apiKey: string): Promise<ApiKeyRecord | null> {
  const data = await redis.get(`${API_KEY_PREFIX}${apiKey}`);
  if (!data) return null;
  return JSON.parse(data) as ApiKeyRecord;
}

/**
 * Provision a new API key for a customer
 * Key format: mf_{uuid} (mf = MeterFlow prefix for easy identification)
 */
export async function provisionApiKey(params: {
  customer_id: string;
  name: string;
  rate_limit?: number;
}): Promise<string> {
  const apiKey = `mf_${randomUUID().replace(/-/g, '')}`;

  const record: ApiKeyRecord = {
    customer_id: params.customer_id,
    name: params.name,
    created_at: Date.now(),
    rate_limit: params.rate_limit ?? DEFAULT_RATE_LIMIT,
  };

  await redis.set(`${API_KEY_PREFIX}${apiKey}`, JSON.stringify(record));

  return apiKey;
}

/**
 * Revoke an API key
 */
export async function revokeApiKey(apiKey: string): Promise<boolean> {
  const deleted = await redis.del(`${API_KEY_PREFIX}${apiKey}`);
  return deleted > 0;
}
