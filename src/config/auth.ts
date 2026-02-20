/**
 * Authentication & Rate Limiting Configuration
 */

/** Redis key prefix for API keys */
export const API_KEY_PREFIX = 'apikey:';

/** Redis key prefix for rate limit counters */
export const RATE_LIMIT_PREFIX = 'ratelimit:';

/** Default rate limit (requests per minute) */
export const DEFAULT_RATE_LIMIT = 100;

/** Rate limit window in seconds */
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/** Routes that skip authentication (exact match) */
export const PUBLIC_ROUTES: string[] = [
  '/health',
  '/v1/metrics',
];

/** Route prefixes that skip authentication */
export const PUBLIC_PREFIXES: string[] = [
  '/dashboard',
  '/v1/dashboard',
  '/v1/pricing',
  '/v1/admin',
];
