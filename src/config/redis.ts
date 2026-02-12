import Redis from 'ioredis';

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

export const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  maxRetriesPerRequest: 3,
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

redis.on('error', (err) => {
  console.error('Redis error:', err);
});

/**
 * Initialize Redis: verify connection is ready
 */
export async function initRedis(): Promise<void> {
  const result = await redis.ping();
  if (result !== 'PONG') {
    throw new Error('Redis ping failed');
  }
  console.log('Redis initialized');
}
