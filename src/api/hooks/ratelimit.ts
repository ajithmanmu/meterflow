/**
 * Rate Limiting Hook
 *
 * Fastify preHandler that enforces per-customer rate limits.
 * Runs after authentication (so we have auth context).
 * Sets standard X-RateLimit-* headers on all authenticated responses.
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { checkRateLimit } from '../../utils/ratelimit';
import { AuthContext } from '../../types/auth';

export async function rateLimitHook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const auth = (request as any).auth as AuthContext | undefined;

  // No auth context = public route, skip rate limiting
  if (!auth) return;

  const result = await checkRateLimit(auth.customer_id, auth.rate_limit);

  // Always set rate limit headers
  reply.header('X-RateLimit-Limit', result.limit);
  reply.header('X-RateLimit-Remaining', result.remaining);
  reply.header('X-RateLimit-Reset', result.reset_in_seconds);

  if (!result.allowed) {
    reply.status(429).send({
      error: 'Rate limit exceeded. Try again later.',
      retry_after_seconds: result.reset_in_seconds,
    });
    return;
  }
}
