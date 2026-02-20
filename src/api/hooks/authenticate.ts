/**
 * API Key Authentication Hook
 *
 * Fastify preHandler that validates X-API-Key header,
 * resolves the customer, and enforces customer scoping.
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { lookupApiKey } from '../../utils/auth';
import { PUBLIC_ROUTES, PUBLIC_PREFIXES } from '../../config/auth';
import { AuthContext } from '../../types/auth';

function isPublicRoute(url: string): boolean {
  if (PUBLIC_ROUTES.includes(url)) return true;

  for (const prefix of PUBLIC_PREFIXES) {
    if (url.startsWith(prefix)) return true;
  }

  return false;
}

export async function authenticateHook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const path = request.url.split('?')[0];

  if (isPublicRoute(path)) return;

  const apiKey = request.headers['x-api-key'] as string | undefined;

  if (!apiKey) {
    reply.status(401).send({ error: 'Missing API key. Provide X-API-Key header.' });
    return;
  }

  const keyRecord = await lookupApiKey(apiKey);

  if (!keyRecord) {
    reply.status(401).send({ error: 'Invalid API key.' });
    return;
  }

  const authCustomerId = keyRecord.customer_id;

  // Attach auth context
  (request as any).auth = {
    customer_id: authCustomerId,
    api_key: apiKey,
    rate_limit: keyRecord.rate_limit,
  } as AuthContext;

  // Enforce customer scoping on query params
  const query = request.query as any;
  if (query?.customer_id && query.customer_id !== authCustomerId) {
    reply.status(403).send({
      error: `API key is scoped to customer ${authCustomerId}. Cannot access customer ${query.customer_id}.`,
    });
    return;
  }

  // Enforce customer scoping on body params
  const body = request.body as any;
  if (body?.customer_id && body.customer_id !== authCustomerId) {
    reply.status(403).send({
      error: `API key is scoped to customer ${authCustomerId}. Cannot access customer ${body.customer_id}.`,
    });
    return;
  }

  // Enforce scoping on batch events (POST /v1/events)
  if (body?.events && Array.isArray(body.events)) {
    const foreign = body.events.filter((e: any) => e.customer_id !== authCustomerId);
    if (foreign.length > 0) {
      reply.status(403).send({
        error: `API key is scoped to customer ${authCustomerId}. Batch contains events for other customers.`,
      });
      return;
    }
  }
}
