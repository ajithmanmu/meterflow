/**
 * API Key Authentication & Rate Limiting Types
 */

/** Stored API key record in Redis */
export interface ApiKeyRecord {
  customer_id: string;
  name: string;
  created_at: number;
  rate_limit: number; // requests per minute
}

/** Auth context attached to authenticated requests */
export interface AuthContext {
  customer_id: string;
  api_key: string;
  rate_limit: number;
}

/** Rate limit check result */
export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  reset_in_seconds: number;
}
