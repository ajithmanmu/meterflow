import { redis } from '../config/redis';

// TTL for dedup keys: 30 days (matches our timestamp validation window)
const DEDUP_TTL_SECONDS = 30 * 24 * 60 * 60;

// Key prefix for dedup entries
const DEDUP_PREFIX = 'dedup:';

/**
 * Check if a transaction_id has been seen before.
 * If not seen, marks it as seen atomically.
 *
 * Uses SET NX (set if not exists) for atomic check-and-set.
 * Returns true if this is a NEW transaction (not a duplicate).
 * Returns false if this transaction_id was already processed.
 */
export async function checkAndMarkTransaction(transactionId: string): Promise<boolean> {
  const key = `${DEDUP_PREFIX}${transactionId}`;

  // SET key value NX EX ttl
  // Returns "OK" if key was set (new transaction)
  // Returns null if key already exists (duplicate)
  const result = await redis.set(key, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');

  return result === 'OK';
}

/**
 * Check multiple transaction_ids at once.
 * Returns an object mapping transaction_id -> isNew (true if new, false if duplicate)
 *
 * Uses pipeline for efficiency.
 */
export async function checkAndMarkTransactions(
  transactionIds: string[]
): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();

  if (transactionIds.length === 0) {
    return results;
  }

  // Use pipeline for batch operations
  const pipeline = redis.pipeline();

  for (const txId of transactionIds) {
    const key = `${DEDUP_PREFIX}${txId}`;
    pipeline.set(key, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
  }

  const pipelineResults = await pipeline.exec();

  if (!pipelineResults) {
    throw new Error('Redis pipeline failed');
  }

  for (let i = 0; i < transactionIds.length; i++) {
    const [err, result] = pipelineResults[i];
    if (err) {
      throw err;
    }
    // result is "OK" for new, null for duplicate
    results.set(transactionIds[i], result === 'OK');
  }

  return results;
}
