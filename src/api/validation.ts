import { UsageEvent } from './schemas';

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validate a single usage event beyond schema validation
 */
export function validateEvent(event: UsageEvent): ValidationResult {
  // Check timestamp is not in the future (allow 5 min buffer for clock skew)
  const now = Date.now();
  const fiveMinutes = 5 * 60 * 1000;

  if (event.timestamp > now + fiveMinutes) {
    return {
      valid: false,
      reason: 'Timestamp is in the future',
    };
  }

  // Check timestamp is not too old (30 days max)
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  if (event.timestamp < now - thirtyDays) {
    return {
      valid: false,
      reason: 'Timestamp is older than 30 days',
    };
  }

  // Check transaction_id format (alphanumeric, dashes, underscores)
  const validIdPattern = /^[a-zA-Z0-9_-]+$/;
  if (!validIdPattern.test(event.transaction_id)) {
    return {
      valid: false,
      reason: 'Invalid transaction_id format',
    };
  }

  if (!validIdPattern.test(event.customer_id)) {
    return {
      valid: false,
      reason: 'Invalid customer_id format',
    };
  }

  // Check properties values are reasonable sizes
  for (const [key, value] of Object.entries(event.properties)) {
    if (typeof value === 'string' && value.length > 1000) {
      return {
        valid: false,
        reason: `Property "${key}" value exceeds 1000 characters`,
      };
    }
  }

  return { valid: true };
}
