/**
 * Sliding Window Rate Limiter (Redis Sorted Set)
 *
 * Uses a sorted set per customer to track requests in a sliding window.
 *
 * How it works:
 * - Each request adds a member to a sorted set keyed by customer_id
 * - Score = Unix timestamp (seconds) of the request
 * - Member = unique ID (timestamp:random) to allow same-second requests
 * - Before checking, we remove all entries older than the window
 * - Count remaining entries = requests in current window
 *
 * Why sorted set over simple INCR/EXPIRE:
 * - Simple counter has a boundary problem: a burst at 0:59 and 1:01
 *   passes two separate windows even though they're 2 seconds apart
 * - Sorted set gives a true sliding window with no boundary artifacts
 *
 * Redis commands per check: ZREMRANGEBYSCORE, ZADD, ZCARD, EXPIRE (pipelined)
 *
 * Production note: For true atomicity under high concurrency, wrap this
 * in a Lua script. The pipeline approach here is sufficient for demo
 * throughput but could allow slight over-counting under extreme load.
 */

import { redis } from '../config/redis';
import { RATE_LIMIT_PREFIX, RATE_LIMIT_WINDOW_SECONDS } from '../config/auth';
import { RateLimitResult } from '../types/auth';

export async function checkRateLimit(
  customerId: string,
  limit: number
): Promise<RateLimitResult> {
  const now = Date.now();
  const nowSeconds = Math.floor(now / 1000);
  const windowStart = nowSeconds - RATE_LIMIT_WINDOW_SECONDS;
  const key = `${RATE_LIMIT_PREFIX}${customerId}`;
  const member = `${now}:${Math.random().toString(36).substring(2, 8)}`;

  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(key, 0, windowStart);
  pipeline.zadd(key, nowSeconds, member);
  pipeline.zcard(key);
  pipeline.expire(key, RATE_LIMIT_WINDOW_SECONDS + 1);

  const results = await pipeline.exec();
  if (!results) {
    throw new Error('Rate limit pipeline failed');
  }

  const [, , [err, count]] = results;
  if (err) throw err;

  const currentCount = count as number;
  const remaining = Math.max(0, limit - currentCount);

  return {
    allowed: currentCount <= limit,
    limit,
    remaining,
    reset_in_seconds: RATE_LIMIT_WINDOW_SECONDS,
  };
}
