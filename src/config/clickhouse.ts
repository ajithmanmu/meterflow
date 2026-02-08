import { createClient } from '@clickhouse/client';

const CLICKHOUSE_HOST = process.env.CLICKHOUSE_HOST || 'http://localhost:8123';
const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER || 'default';
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD || 'meterflow';
const CLICKHOUSE_DATABASE = process.env.CLICKHOUSE_DATABASE || 'meterflow';

export const clickhouse = createClient({
  url: CLICKHOUSE_HOST,
  username: CLICKHOUSE_USER,
  password: CLICKHOUSE_PASSWORD,
  database: CLICKHOUSE_DATABASE,
});

/**
 * Initialize ClickHouse: create database and tables if they don't exist
 */
export async function initClickHouse(): Promise<void> {
  // Create database if not exists
  await clickhouse.command({
    query: `CREATE DATABASE IF NOT EXISTS ${CLICKHOUSE_DATABASE}`,
  });

  // Create events table
  // Using MergeTree engine - good for time-series data with high insert rates
  await clickhouse.command({
    query: `
      CREATE TABLE IF NOT EXISTS ${CLICKHOUSE_DATABASE}.events (
        transaction_id String,
        customer_id String,
        event_type String,
        timestamp DateTime64(3),
        properties String,
        ingested_at DateTime64(3) DEFAULT now64(3)
      )
      ENGINE = MergeTree()
      ORDER BY (customer_id, event_type, timestamp)
      PRIMARY KEY (customer_id, event_type, timestamp)
    `,
  });

  console.log('ClickHouse initialized');
}
