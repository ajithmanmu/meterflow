import { clickhouse } from '../config/clickhouse';
import { getMetric } from '../config/metrics';
import { UsageQueryParams, UsageQueryResponse } from '../types/metrics';

/**
 * Query usage for a customer based on a billable metric
 *
 * Translates the metric definition into a ClickHouse aggregation query.
 */
export async function queryUsage(params: UsageQueryParams): Promise<UsageQueryResponse> {
  const { customer_id, metric, start, end, group_by } = params;

  // Get metric definition from catalog
  const metricDef = getMetric(metric);
  if (!metricDef) {
    throw new Error(`Unknown metric: ${metric}`);
  }

  // Build aggregation expression based on metric type
  let aggregationExpr: string;
  switch (metricDef.aggregation) {
    case 'COUNT':
      aggregationExpr = 'count()';
      break;
    case 'SUM':
      if (!metricDef.property) {
        throw new Error(`SUM metric "${metric}" requires a property`);
      }
      // Extract numeric value from JSON properties
      aggregationExpr = `sum(JSONExtractFloat(properties, '${metricDef.property}'))`;
      break;
    case 'MAX':
      if (!metricDef.property) {
        throw new Error(`MAX metric "${metric}" requires a property`);
      }
      aggregationExpr = `max(JSONExtractFloat(properties, '${metricDef.property}'))`;
      break;
    default:
      throw new Error(`Unsupported aggregation: ${metricDef.aggregation}`);
  }

  // Convert timestamps to ClickHouse format
  const startDate = new Date(start).toISOString().replace('T', ' ').replace('Z', '');
  const endDate = new Date(end).toISOString().replace('T', ' ').replace('Z', '');

  // Build and execute query
  if (group_by) {
    // Query with grouping
    const query = `
      SELECT
        JSONExtractString(properties, '${group_by}') as dimension,
        ${aggregationExpr} as value
      FROM events
      WHERE customer_id = '${customer_id}'
        AND event_type = '${metricDef.event_type}'
        AND timestamp >= '${startDate}'
        AND timestamp <= '${endDate}'
      GROUP BY dimension
      ORDER BY value DESC
    `;

    const result = await clickhouse.query({
      query,
      format: 'JSONEachRow',
    });

    const rows = await result.json<{ dimension: string; value: number }>();

    // Build breakdown and calculate total
    const breakdown: Record<string, number> = {};
    let total = 0;

    for (const row of rows) {
      const key = row.dimension || '(empty)';
      breakdown[key] = row.value;
      total += row.value;
    }

    return {
      customer_id,
      metric,
      period: { start, end },
      value: total,
      unit: metricDef.unit,
      breakdown,
    };
  } else {
    // Query without grouping (total only)
    const query = `
      SELECT ${aggregationExpr} as value
      FROM events
      WHERE customer_id = '${customer_id}'
        AND event_type = '${metricDef.event_type}'
        AND timestamp >= '${startDate}'
        AND timestamp <= '${endDate}'
    `;

    const result = await clickhouse.query({
      query,
      format: 'JSONEachRow',
    });

    const rows = await result.json<{ value: number }>();
    const value = rows[0]?.value ?? 0;

    return {
      customer_id,
      metric,
      period: { start, end },
      value,
      unit: metricDef.unit,
    };
  }
}
