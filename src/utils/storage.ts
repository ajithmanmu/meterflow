import { clickhouse } from '../config/clickhouse';
import { UsageEvent } from '../api/schemas';

/**
 * Insert events into ClickHouse
 * Uses batch insert for efficiency
 */
export async function insertEvents(events: UsageEvent[]): Promise<void> {
  if (events.length === 0) {
    return;
  }

  // Transform events for ClickHouse
  const rows = events.map((event) => ({
    transaction_id: event.transaction_id,
    customer_id: event.customer_id,
    event_type: event.event_type,
    // Convert Unix ms to ISO string for DateTime64
    timestamp: new Date(event.timestamp).toISOString().replace('T', ' ').replace('Z', ''),
    // Store properties as JSON string
    properties: JSON.stringify(event.properties),
  }));

  await clickhouse.insert({
    table: 'events',
    values: rows,
    format: 'JSONEachRow',
  });
}

/**
 * Query total events for a customer in a time range
 * Example aggregation query
 */
export async function getCustomerUsage(
  customerId: string,
  startTime: number,
  endTime: number
): Promise<{
  total_events: number;
  by_event_type: Record<string, number>;
}> {
  const result = await clickhouse.query({
    query: `
      SELECT
        count() as total_events,
        event_type,
        count() as count
      FROM events
      WHERE customer_id = {customerId: String}
        AND timestamp >= fromUnixTimestamp64Milli({startTime: Int64})
        AND timestamp <= fromUnixTimestamp64Milli({endTime: Int64})
      GROUP BY event_type
    `,
    query_params: {
      customerId,
      startTime,
      endTime,
    },
    format: 'JSONEachRow',
  });

  const rows = await result.json<{ total_events: number; event_type: string; count: string }>();

  const by_event_type: Record<string, number> = {};
  let total = 0;

  for (const row of rows) {
    const count = parseInt(row.count, 10);
    by_event_type[row.event_type] = count;
    total += count;
  }

  return { total_events: total, by_event_type };
}
