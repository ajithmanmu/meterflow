# Production Considerations

How each MeterFlow component would change for a production deployment on AWS. This document covers architecture patterns, technology choices, and key considerations — not a final design.

---

## Overall Architecture

In production, the synchronous demo pipeline would be split into managed AWS services:

```
┌──────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Client  │────▶│  API Gateway │────▶│  Lambda      │────▶│  Kinesis     │
│          │     │  + WAF       │     │  (validate   │     │  (buffer)    │
│          │◀────│              │     │   + dedup)   │     │              │
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

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  EventBridge │────▶│  Lambda      │────▶│  Stripe API  │
│  (scheduled) │     │  (billing,   │     │  (invoicing) │
│              │     │   anomaly,   │     │              │
│              │     │   fraud)     │     └──────────────┘
└──────────────┘     └──────┬───────┘
                            │
                  ┌─────────┴─────────┐
                  ▼                   ▼
         ┌──────────────┐    ┌──────────────┐
         │  DynamoDB    │    │  SNS         │
         │  (state)     │    │  (alerts)    │
         └──────────────┘    └──────────────┘
```

### Demo → Production Component Mapping

| Demo (Local) | Production (AWS) | Why |
|-------------|-----------------|-----|
| Fastify server | API Gateway + Lambda | Auto-scaling, managed TLS, WAF |
| Redis (single) | ElastiCache (Redis Cluster) | High availability, automatic failover |
| ClickHouse (Docker) | ClickHouse Cloud | Managed, scalable, VPC peering |
| MinIO | S3 | Native AWS, lifecycle policies, cross-region replication |
| In-process sync | Kinesis | Async buffer, back-pressure, replay capability |
| cron / manual | EventBridge | Managed scheduling, reliable triggers |
| Console logs | CloudWatch + SNS | Alerting, dashboards, PagerDuty integration |

---

## API Authentication

### Current (Demo)

API key auth via Redis lookup. Keys stored as plain JSON, admin routes are open.

### Production Considerations

| Concern | Demo | Production |
|---------|------|------------|
| Key storage | Redis (plain JSON) | DynamoDB or RDS (hashed with SHA-256) |
| Key format | `mf_{uuid}` | `mf_{uuid}` with prefix versioning |
| Rotation | Manual revoke/provision | Automated rotation with grace period |
| Admin access | Open `/v1/admin/*` | JWT + admin role, internal network only |
| Scoping | customer_id only | customer_id + permission scopes (read, write, admin) |

**Key hashing:** Store `SHA-256(api_key)` instead of the raw key. On lookup, hash the incoming key and compare. This prevents key exposure if the database is compromised.

**Admin key management** would sit behind an internal API Gateway with JWT auth:

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

---

## Rate Limiting

### Current (Demo)

Redis sorted set sliding window. Per-customer, 100 requests/minute default.

### Why Sliding Window over Fixed Window

Fixed window (`INCR`/`EXPIRE`) has a boundary problem: 100 requests at 0:59 + 100 requests at 1:01 = 200 requests in 2 seconds, all passing two separate windows. Sorted set gives a true sliding window.

### Production Considerations

| Concern | Demo | Production |
|---------|------|------------|
| Atomicity | Redis pipeline (near-atomic) | Lua script for true atomicity |
| Scope | Per-customer global | Per-customer + per-endpoint |
| Tiers | Single limit (100/min) | Tiered by plan (free, pro, enterprise) |
| Distributed | Single Redis | Redis Cluster or ElastiCache |
| Edge limiting | N/A | API Gateway throttling as first line of defense |

**Two-layer approach:** API Gateway provides coarse IP-based throttling to protect infrastructure, while the application layer enforces fine-grained per-customer limits tied to billing tiers.

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  API Gateway    │────▶│  Application    │────▶│  Business Logic │
│  (coarse limit) │     │  (fine limit)   │     │                 │
│  per-IP burst   │     │  per-customer   │     │                 │
│                 │     │  sliding window │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

**Atomicity:** Under high concurrency, the Redis pipeline approach could allow slight over-counting. A Lua script wrapping the same sorted set logic (ZREMRANGEBYSCORE → ZADD → ZCARD → EXPIRE) would execute atomically on the Redis server.

---

## Async Ingestion & Back-Pressure

### Current (Demo)

Synchronous pipeline: validate → dedup → store → backup, all in one request.

### Production Considerations

For high-throughput scenarios, decouple ingestion from processing with a stream buffer:

- **Kinesis over SQS**: Ordered within shard (partition by customer_id), replayable, configurable retention
- **Back-pressure**: Kinesis shard limits provide natural back-pressure. Clients receive 429 when capacity is reached.
- **Dead letter queue**: Failed batches route to SQS DLQ for investigation and replay
- **Idempotency**: The dedup layer (Redis SET NX) remains the same — it doesn't matter if an event arrives via HTTP or Kinesis, duplicates are caught either way

The client experience changes: instead of `200 OK` with results, they receive `202 Accepted` immediately. Processing happens asynchronously.

---

## Anomaly Detection

### Current (Demo)

On-demand API (`GET /v1/anomalies/check`) that calculates Z-scores when requested.

### Production Considerations

Anomaly detection would run as a **scheduled batch job** instead of on-demand:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  EventBridge    │────▶│  Lambda         │────▶│  ClickHouse     │
│  (scheduled)    │     │  (anomaly job)  │     │  (read usage)   │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    ▼                         ▼
           ┌─────────────────┐       ┌─────────────────┐
           │  DynamoDB       │       │  SNS / SQS      │
           │  (anomalies)    │       │  (alerts)       │
           └─────────────────┘       └─────────────────┘
```

- **Schedule**: Hourly or daily depending on detection latency needs
- **Storage**: Detected anomalies stored in DynamoDB with TTL for automatic cleanup
- **Alerts**: SNS topics routed to email, Slack, or PagerDuty based on severity
- **The detection logic itself** (`checkAnomaly()`) would be reused as-is — it already takes parameters for baseline window and threshold

---

## Fraud Detection

### Current (Demo)

On-demand vector similarity check (`GET /v1/fraud/check`) with baseline building via API.

### Production Considerations

- **Baseline rebuilding** would run on a weekly schedule (EventBridge → Lambda) instead of manual API calls
- **Detection** would run daily alongside anomaly detection, checking each customer's pattern against their weekday baseline
- **Combined detection**: Z-score catches volume anomalies, vector similarity catches pattern anomalies. Both signals feed into an alert that includes severity, type (volume/pattern/both), and recommended action
- **Threshold tuning**: The 0.9 cosine similarity threshold and 3.0 Z-score threshold would need tuning based on real customer data and false positive rates

---

## Stripe Billing

### Current (Demo)

Dry-run billing cycle (`POST /v1/billing/run`) that builds Stripe SDK payloads without calling Stripe.

### Production Considerations

| Concern | Demo | Production |
|---------|------|------------|
| Trigger | Manual API call | EventBridge (1st of month) |
| Execution | In-process, dry-run | Lambda → real Stripe SDK |
| Idempotency | Key generated, not enforced | Stripe idempotency keys + DynamoDB guard |
| Failure handling | N/A | DLQ + retry with exponential backoff |
| Customer mapping | `cus_{customer_id}` placeholder | Real Stripe Customer IDs from customer database |
| Webhooks | N/A | Handle `invoice.paid`, `invoice.payment_failed` |

**Billing pipeline:**

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

**Idempotency** is critical for billing. The idempotency key (`meterflow_{invoice_id}_{customer_id}_{period}`) ensures that retries, duplicate EventBridge deliveries, or manual re-runs don't double-charge customers. Stripe rejects duplicate requests with the same key within 48 hours. For longer protection, check a DynamoDB record before calling Stripe.

**Webhook handling** closes the loop — Stripe sends `invoice.paid` or `invoice.payment_failed` events to an API Gateway endpoint, which triggers a Lambda to update billing status and send alerts on failures.

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

---

## Migration Path

A realistic rollout would go in phases:

1. **Phase 1**: Deploy API on AWS (API Gateway + Lambda + ElastiCache + ClickHouse Cloud + S3). Keep synchronous pipeline.
2. **Phase 2**: Add Kinesis buffer for async ingestion. Switch client response to 202 Accepted.
3. **Phase 3**: Add scheduled jobs (EventBridge) for anomaly detection, fraud detection, and billing.
4. **Phase 4**: Integrate real Stripe SDK for billing. Set up webhook handling.
5. **Phase 5**: Add alerting (SNS → Slack/PagerDuty) and monitoring dashboards (CloudWatch).
