# Production Anomaly Detection Architecture

This document describes how to implement scheduled anomaly detection in a production AWS environment.

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
