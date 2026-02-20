# Production Architecture

This document describes production architecture for MeterFlow's key systems: authentication, rate limiting, anomaly detection, and async ingestion.

---

## API Authentication

### Current Implementation (Demo)

API key auth via Redis lookup. Keys are customer-scoped with per-key rate limits.

```
Client → X-API-Key header → Redis lookup → customer_id resolved → request scoped
```

### Production Implementation

| Concern | Demo | Production |
|---------|------|------------|
| Key storage | Redis (plain JSON) | DynamoDB or RDS (hashed with bcrypt/SHA-256) |
| Key format | `mf_{uuid}` | `mf_{uuid}` with prefix versioning |
| Rotation | Manual revoke/provision | Automated rotation with grace period |
| Admin access | Open `/v1/admin/*` | JWT + admin role, internal network only |
| Scoping | customer_id only | customer_id + permission scopes (read, write, admin) |

### Production Key Management

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Admin Dashboard │────▶│  API Gateway    │────▶│  Lambda         │
│  (key CRUD)      │     │  + JWT Auth     │     │  (key service)  │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                          │
                                               ┌──────────┴──────────┐
                                               ▼                     ▼
                                      ┌─────────────────┐  ┌─────────────────┐
                                      │  DynamoDB       │  │  CloudWatch     │
                                      │  (key store)    │  │  (audit logs)   │
                                      └─────────────────┘  └─────────────────┘
```

Key hashing: Store `SHA-256(api_key)` in DynamoDB, not the raw key. On lookup, hash the incoming key and compare. This prevents key exposure if the database is compromised.

---

## Rate Limiting

### Current Implementation (Demo)

Redis sorted set sliding window. Per-customer, 100 requests/minute default.

```
Pipeline: ZREMRANGEBYSCORE → ZADD → ZCARD → EXPIRE
```

### Why Sliding Window over Fixed Window

Fixed window (INCR/EXPIRE) has a boundary problem: 100 requests at 0:59 + 100 requests at 1:01 = 200 requests in 2 seconds, all passing two separate windows. Sorted set gives a true sliding window.

### Production Implementation

| Concern | Demo | Production |
|---------|------|------------|
| Atomicity | Redis pipeline (near-atomic) | Lua script for true atomicity |
| Scope | Per-customer global | Per-customer + per-endpoint |
| Tiers | Single limit (100/min) | Free: 60/min, Pro: 1000/min, Enterprise: custom |
| Distributed | Single Redis | Redis Cluster or ElastiCache |
| Edge limiting | N/A | API Gateway throttling (first line of defense) |

### Two-Layer Rate Limiting

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  API Gateway    │────▶│  Application    │────▶│  Business Logic │
│  (coarse limit) │     │  (fine limit)   │     │                 │
│  1000 req/s     │     │  per-customer   │     │                 │
│  per-IP burst   │     │  sliding window │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

- **Layer 1 (API Gateway)**: Protects infrastructure. IP-based, high threshold (1000/s burst). Returns 429 for DDoS-level traffic.
- **Layer 2 (Application)**: Enforces billing tier limits. Customer-scoped, per-minute. Uses Redis Cluster for distributed counting.

### Lua Script for Atomic Rate Limiting

```lua
-- rate_limit.lua (loaded into Redis)
local key = KEYS[1]
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)

if count < limit then
  redis.call('ZADD', key, now, now .. ':' .. math.random())
  redis.call('EXPIRE', key, window + 1)
  return {1, limit - count - 1} -- allowed, remaining
else
  return {0, 0} -- denied, 0 remaining
end
```

---

## Async Ingestion & Back-Pressure

### Current Implementation (Demo)

Synchronous pipeline: validate → dedup → store → backup, all in one request.

### Production Implementation

For high-throughput scenarios (>10K events/sec), add an async buffer:

```
┌──────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Client  │────▶│  API Gateway │────▶│  Lambda      │────▶│  Kinesis     │
│          │     │  + Auth      │     │  (validate   │     │  (buffer)    │
│          │◀────│  202 Accepted│     │   + dedup)   │     │  7-day retain│
└──────────┘     └──────────────┘     └──────────────┘     └──────┬───────┘
                                                                   │
                                                        ┌──────────┴──────────┐
                                                        ▼                     ▼
                                               ┌──────────────┐     ┌──────────────┐
                                               │  Lambda      │     │  S3          │
                                               │  (processor) │     │  (backup)    │
                                               │  → ClickHouse│     │              │
                                               └──────────────┘     └──────────────┘
```

Key design decisions:
- **Kinesis over SQS**: Ordered within shard (partition by customer_id), replayable, 7-day retention
- **Batch size**: Processor Lambda handles 10 records/invocation with bisect-on-error
- **Back-pressure**: Kinesis shard limits (1MB/s write, 1000 records/s) provide natural back-pressure. Clients receive 429 when shards are full.
- **DLQ**: Failed batches route to SQS dead letter queue (14-day retention) for replay

### Cost Estimate (per month, 1M events/day)

| Component | Usage | Cost |
|-----------|-------|------|
| Kinesis | 1 shard, 1M writes/day | ~$15 |
| Lambda (ingestion) | 1M invocations | ~$5 |
| Lambda (processor) | 100K invocations | ~$2 |
| S3 (backup) | 10GB/month | ~$0.25 |
| **Total** | | **~$22/month** |

---

## Anomaly Detection

This section describes how to implement scheduled anomaly detection in a production AWS environment.

## Current Implementation (Demo)

The demo uses an **on-demand API** (`GET /v1/anomalies/check`) that:
- Calculates anomalies when requested
- Returns results immediately
- Good for demos and debugging

## Production Implementation (AWS Scheduled Jobs)

For production, anomaly detection should run as a **scheduled batch job** that:
- Runs hourly or daily
- Checks all active customers
- Stores detected anomalies
- Triggers alerts

### Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  EventBridge    │────▶│  Lambda         │────▶│  ClickHouse     │
│  (cron: hourly) │     │  (anomaly job)  │     │  (read usage)   │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    ▼                         ▼
           ┌─────────────────┐       ┌─────────────────┐
           │  DynamoDB       │       │  SNS / SQS      │
           │  (anomalies)    │       │  (alerts)       │
           └─────────────────┘       └─────────────────┘
```

### AWS Components

| Component | Purpose | Configuration |
|-----------|---------|---------------|
| **EventBridge** | Trigger on schedule | `rate(1 hour)` or `cron(0 * * * ? *)` |
| **Lambda** | Execute anomaly detection | Node.js 20.x, 512MB RAM, 5min timeout |
| **ClickHouse Cloud** | Query historical data | VPC peering to Lambda |
| **DynamoDB** | Store detected anomalies | On-demand capacity |
| **SNS** | Send alerts | Email, Slack, PagerDuty |
| **CloudWatch** | Monitor job health | Alarms on Lambda errors |

### Lambda Function

```typescript
// handler.ts
import { checkAnomaly } from './utils/anomaly';
import { DynamoDB } from '@aws-sdk/client-dynamodb';
import { SNS } from '@aws-sdk/client-sns';

const dynamo = new DynamoDB({});
const sns = new SNS({});

interface ScheduledEvent {
  time: string;
  'detail-type': string;
}

export async function handler(event: ScheduledEvent) {
  const now = Date.now();
  const periodEnd = now;
  const periodStart = now - 24 * 60 * 60 * 1000; // Last 24 hours

  // Get active customers from your customer database
  const customers = await getActiveCustomers();
  const metrics = ['api_calls', 'bandwidth', 'storage_peak', 'compute_time'];

  const anomalies = [];

  for (const customer of customers) {
    for (const metric of metrics) {
      const result = await checkAnomaly({
        customer_id: customer.id,
        metric,
        current_start: periodStart,
        current_end: periodEnd,
        baseline_days: 30,
        threshold: 3,
      });

      if (result.is_anomaly) {
        anomalies.push(result);

        // Store in DynamoDB
        await dynamo.putItem({
          TableName: 'meterflow-anomalies',
          Item: {
            pk: { S: `CUSTOMER#${customer.id}` },
            sk: { S: `ANOMALY#${now}#${metric}` },
            customer_id: { S: customer.id },
            metric: { S: metric },
            detected_at: { N: String(now) },
            current_value: { N: String(result.current_value) },
            baseline_mean: { N: String(result.baseline.mean) },
            baseline_stddev: { N: String(result.baseline.stddev) },
            z_score: { N: String(result.z_score) },
            severity: { S: result.severity },
            ttl: { N: String(Math.floor(now / 1000) + 90 * 24 * 60 * 60) }, // 90 days
          },
        });

        // Send alert for critical anomalies
        if (result.severity === 'critical') {
          await sns.publish({
            TopicArn: process.env.ALERT_TOPIC_ARN,
            Subject: `[MeterFlow] Critical anomaly: ${customer.id} - ${metric}`,
            Message: JSON.stringify({
              customer_id: customer.id,
              metric,
              current_value: result.current_value,
              baseline_mean: result.baseline.mean,
              z_score: result.z_score,
              detected_at: new Date(now).toISOString(),
            }, null, 2),
          });
        }
      }
    }
  }

  return {
    statusCode: 200,
    body: {
      checked: customers.length * metrics.length,
      anomalies_found: anomalies.length,
      timestamp: new Date(now).toISOString(),
    },
  };
}
```

### DynamoDB Schema

```
Table: meterflow-anomalies

Primary Key:
  - pk: CUSTOMER#{customer_id}
  - sk: ANOMALY#{timestamp}#{metric}

Attributes:
  - customer_id (S)
  - metric (S)
  - detected_at (N) - Unix timestamp ms
  - current_value (N)
  - baseline_mean (N)
  - baseline_stddev (N)
  - z_score (N)
  - severity (S) - 'warning' | 'critical'
  - ttl (N) - Auto-expire after 90 days

GSI: metric-severity-index
  - pk: metric
  - sk: detected_at
  - Used for: "Show all bandwidth anomalies in the last week"
```

### EventBridge Rule (Terraform)

```hcl
resource "aws_cloudwatch_event_rule" "anomaly_detection" {
  name                = "meterflow-anomaly-detection"
  description         = "Run anomaly detection hourly"
  schedule_expression = "rate(1 hour)"
}

resource "aws_cloudwatch_event_target" "anomaly_lambda" {
  rule      = aws_cloudwatch_event_rule.anomaly_detection.name
  target_id = "AnomalyDetectionLambda"
  arn       = aws_lambda_function.anomaly_detection.arn
}

resource "aws_lambda_permission" "allow_eventbridge" {
  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.anomaly_detection.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.anomaly_detection.arn
}
```

### Alert Destinations

Configure SNS subscriptions for:

1. **Email** - For ops team daily digest
2. **Slack** - Via Lambda or AWS Chatbot integration
3. **PagerDuty** - For critical alerts requiring immediate action

### Monitoring

CloudWatch alarms to set up:

| Metric | Threshold | Action |
|--------|-----------|--------|
| Lambda Errors | > 0 in 5min | Alert ops team |
| Lambda Duration | > 4min | Review customer count |
| Anomalies/Hour | > 50 | Possible system issue |
| DynamoDB Throttles | > 0 | Scale capacity |

### Cost Estimate (per month)

| Component | Usage | Cost |
|-----------|-------|------|
| Lambda | 720 invocations/month, ~30s each | ~$0.50 |
| EventBridge | 720 events/month | ~$0.01 |
| DynamoDB | 10K writes, 100K reads | ~$1.25 |
| SNS | 1K notifications | ~$0.50 |
| **Total** | | **~$2.50/month** |

## Migration Path

1. **Phase 1**: Keep on-demand API for debugging
2. **Phase 2**: Deploy Lambda + EventBridge
3. **Phase 3**: Add DynamoDB storage
4. **Phase 4**: Integrate alerting (SNS/Slack)
5. **Phase 5**: Build dashboard from DynamoDB data

## V2 Enhancement: Vector Similarity

For more sophisticated pattern detection, upgrade to vector-based anomaly detection:

1. Store 24-dim hourly usage vectors in Redis Vector Sets
2. Compare current day's vector to historical weekday baseline
3. Use cosine similarity (threshold ~0.9)
4. Combine with Z-score for volume + shape detection

See: Redis Vector Search documentation

---

## Stripe Billing Integration

### Current Implementation (Demo)

The demo provides a dry-run billing cycle endpoint (`POST /v1/billing/run`) that:
- Calculates a MeterFlow invoice (usage aggregation → pricing tiers → line items)
- Builds the exact Stripe SDK payloads that would be executed
- Returns both for inspection without calling Stripe

### Billing Pipeline

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  EventBridge │────▶│  Lambda      │────▶│  MeterFlow   │────▶│  Stripe API  │
│  (1st of     │     │  (billing    │     │  Invoice     │     │              │
│   month)     │     │   runner)    │     │  Calculation │     │  1. Create   │
└──────────────┘     └──────────────┘     └──────────────┘     │  2. Items    │
                                                                │  3. Finalize │
                                                                │  4. Send     │
                                                                └──────┬───────┘
                                                                       │
                                                                       ▼
                                                              ┌──────────────┐
                                                              │  Customer    │
                                                              │  receives    │
                                                              │  invoice     │
                                                              │  via email   │
                                                              └──────────────┘
```

### Stripe API Flow

| Step | Stripe SDK Call | Purpose |
|------|----------------|---------|
| 1 | `stripe.invoices.create()` | Create draft invoice with metadata (billing period, MeterFlow invoice ID) |
| 2 | `stripe.invoiceItems.create()` | Add line item per metric (amount in cents, description, quantity) |
| 3 | `stripe.invoices.finalizeInvoice()` | Lock invoice — no more items can be added |
| 4 | `stripe.invoices.sendInvoice()` | Email customer with Stripe-hosted payment page |

### Idempotency

Billing jobs must be idempotent — running the same billing cycle twice should not double-charge.

- **Idempotency key**: `meterflow_{invoice_id}_{customer_id}_{period_start}_{period_end}`
- Stripe's idempotency layer rejects duplicate requests with the same key (48-hour window)
- For longer protection, store completed billing runs in DynamoDB and check before executing

### Production Implementation

| Concern | Demo | Production |
|---------|------|------------|
| Trigger | Manual API call | EventBridge (1st of month) |
| Execution | In-process, dry-run | Lambda → real Stripe SDK |
| Idempotency | Key generated, not enforced | Stripe idempotency + DynamoDB guard |
| Failure handling | N/A | DLQ + retry with exponential backoff |
| Customer mapping | `cus_{customer_id}` | Real Stripe Customer IDs from customer database |
| Webhooks | N/A | `invoice.paid`, `invoice.payment_failed` → update billing status |

### Webhook Handling (Payment Events)

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Stripe      │────▶│  API Gateway │────▶│  Lambda      │
│  Webhook     │     │  /webhooks/  │     │  (handler)   │
│              │     │  stripe      │     │              │
└──────────────┘     └──────────────┘     └────────┬─────┘
                                                    │
                                          ┌─────────┴─────────┐
                                          ▼                   ▼
                                 ┌──────────────┐    ┌──────────────┐
                                 │  DynamoDB    │    │  SNS         │
                                 │  (billing    │    │  (alerts on  │
                                 │   status)    │    │   failures)  │
                                 └──────────────┘    └──────────────┘
```

Key webhook events to handle:

| Event | Action |
|-------|--------|
| `invoice.paid` | Mark billing period as paid, update customer status |
| `invoice.payment_failed` | Retry logic, notify customer, escalate after 3 failures |
| `customer.subscription.deleted` | Trigger grace period, restrict API access |

### Cost Estimate (per month, 100 customers)

| Component | Usage | Cost |
|-----------|-------|------|
| Lambda (billing runner) | 100 invocations/month | ~$0.01 |
| Lambda (webhook handler) | ~300 events/month | ~$0.01 |
| DynamoDB (billing records) | 100 writes, 1K reads | ~$0.01 |
| Stripe | 100 invoices | Per Stripe pricing (0.5% + $0.25/invoice) |
| **Total (AWS)** | | **~$0.03/month** |
