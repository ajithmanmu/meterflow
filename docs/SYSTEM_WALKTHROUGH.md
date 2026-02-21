# MeterFlow System Walkthrough

A real-world walkthrough of how MeterFlow works, told through the story of a single customer — **Acme Corp** — from their first API call to their monthly invoice.

This document is designed to be read top-to-bottom. Each section builds on the previous one, following the lifecycle of a usage event through the entire system.

---

## Table of Contents

1. [Getting an API Key](#1-getting-an-api-key)
2. [Sending an Event](#2-sending-an-event)
3. [Rate Limiting](#3-rate-limiting)
4. [Validation](#4-validation)
5. [Deduplication](#5-deduplication)
6. [Storage & Backup](#6-storage--backup)
7. [Usage Aggregation](#7-usage-aggregation)
8. [Anomaly Detection (Z-Score)](#8-anomaly-detection-z-score)
9. [Fraud Detection (Vector Similarity)](#9-fraud-detection-vector-similarity)
10. [Pricing & Invoicing](#10-pricing--invoicing)
11. [Billing & Stripe](#11-billing--stripe)
12. [Deep Dive: Async Ingestion & Back-Pressure](#12-deep-dive-async-ingestion--back-pressure)

---

## 1. Getting an API Key

Acme Corp signs up for your platform. Before they can send any usage events, they need an API key.

An admin provisions a key for them:

```bash
curl -X POST localhost:3000/v1/admin/keys \
  -H "Content-Type: application/json" \
  -d '{"customer_id": "acme_corp", "name": "production", "rate_limit": 200}'
```

This returns: `mf_a7b3c9d1-...`

**What happens internally:**

1. `provisionApiKey()` in `src/utils/auth.ts` generates a key with the `mf_` prefix followed by a UUID
2. It stores the key in Redis: `apikey:mf_a7b3c9d1-...` → `{customer_id: "acme_corp", name: "production", rate_limit: 200, created_at: ...}`
3. The key maps to Acme's customer_id — every request Acme makes with this key is automatically scoped to their data

**Why this design:**

- The `mf_` prefix makes keys identifiable in logs ("that's a MeterFlow key")
- Redis gives sub-millisecond lookups on every request
- No expiration — keys live until explicitly revoked, just like real API keys
- In production, you'd hash the key with SHA-256 before storing it so a database breach doesn't expose raw keys

**Key files:** `src/utils/auth.ts`, `src/config/auth.ts`, `src/types/auth.ts`

---

## 2. Sending an Event

Acme's backend makes an API call to `/users/123`. Their integration sends this to MeterFlow:

```bash
curl -X POST localhost:3000/v1/events \
  -H "Content-Type: application/json" \
  -H "X-API-Key: mf_a7b3c9d1-..." \
  -d '{
    "events": [{
      "transaction_id": "txn_abc123",
      "customer_id": "acme_corp",
      "event_type": "api_request",
      "timestamp": 1706745600000,
      "properties": {
        "endpoint": "/users",
        "bytes": 1500
      }
    }]
  }'
```

**What happens internally (in order):**

The request hits two Fastify preHandler hooks before reaching the route handler:

### Hook 1: Authentication (`src/api/hooks/authenticate.ts`)

1. Check if `/v1/events` is a public route — it's not, so auth is required
2. Read the `X-API-Key` header → `mf_a7b3c9d1-...`
3. Look up the key in Redis → get back `{customer_id: "acme_corp", rate_limit: 200}`
4. **Customer scoping check**: the request body has `customer_id: "acme_corp"` and the key belongs to `acme_corp` — they match, so the request is allowed
5. Attach auth context to the request: `request.auth = {customer_id: "acme_corp", api_key: "mf_...", rate_limit: 200}`

If Acme tried to send events with `customer_id: "other_company"`, they'd get a **403 Forbidden**. Their key only works for their own data. For batch events, every single event in the array is checked — one foreign event rejects the entire batch.

### Hook 2: Rate Limiting (`src/api/hooks/ratelimit.ts`)

1. Read `request.auth` — Acme has a 200 req/min limit
2. Call `checkRateLimit("acme_corp", 200)` which runs a Redis pipeline (see [Rate Limiting](#3-rate-limiting) below)
3. Set response headers: `X-RateLimit-Limit: 200`, `X-RateLimit-Remaining: 199`, `X-RateLimit-Reset: 60`
4. Acme is under their limit, so the request continues

### Route Handler: Event Ingestion (`src/api/server.ts`)

Now the actual ingestion pipeline runs — this is the core of MeterFlow:

1. **Validation** — check each event for business rule violations
2. **Deduplication** — check Redis for duplicate transaction IDs
3. **Storage** — insert accepted events into ClickHouse
4. **Backup** — write raw JSON to MinIO (S3-compatible)

The response tells Acme exactly what happened:

```json
{
  "accepted": 1,
  "duplicates": 0,
  "failed": []
}
```

**Key files:** `src/api/server.ts` (route handler), `src/api/hooks/authenticate.ts`, `src/api/hooks/ratelimit.ts`

---

## 3. Rate Limiting

Acme's integration has a bug — it's firing 300 requests per minute instead of the expected 50.

At request #201, the rate limiter kicks in and returns **429 Too Many Requests**:

```json
{
  "error": "Rate limit exceeded",
  "limit": 200,
  "retry_after_seconds": 45
}
```

**How the sliding window works** (`src/utils/ratelimit.ts`):

The rate limiter uses a Redis sorted set per customer. Each request is a member with its timestamp as the score.

```
Key: ratelimit:acme_corp
Members: [
  {score: 1706745600, member: "1706745600123:a8f3"},
  {score: 1706745601, member: "1706745601456:b2c1"},
  ...
]
```

On every request, four Redis commands run in a pipeline:

1. **ZREMRANGEBYSCORE** — remove all entries older than 60 seconds. This "slides" the window forward.
2. **ZADD** — add this request with the current timestamp as score
3. **ZCARD** — count remaining entries = requests in the last 60 seconds
4. **EXPIRE** — set a safety TTL so abandoned keys don't leak memory

If ZCARD returns a count > limit, the request is denied.

**Why sorted sets instead of a simple counter:**

A simple `INCR key` + `EXPIRE 60` creates a fixed window. The problem: Acme could send 200 requests at second 59 of window 1, then 200 more at second 1 of window 2 — that's 400 requests in 2 seconds, all passing two separate windows. The sorted set gives a true sliding window where the count is always calculated over the last 60 seconds from right now.

**Key files:** `src/utils/ratelimit.ts`, `src/api/hooks/ratelimit.ts`, `src/config/auth.ts`

### Deep Dive: Pipeline vs Lua Atomicity

The demo implementation uses a Redis pipeline — 4 commands sent in one network round trip. This is fast and works fine at low concurrency. But there's a subtle race condition at scale.

**The problem: add-then-check**

Our pipeline does this:

```
Step 1: ZREMRANGEBYSCORE  → remove old entries
Step 2: ZADD              → add THIS request to the set
Step 3: ZCARD             → count entries in the set
Step 4: EXPIRE            → safety TTL
```

Notice the order: we **add first** (ZADD), then **count** (ZCARD). If the count exceeds the limit, we deny the request — but the entry is already in the set.

A pipeline sends all 4 commands in one network round trip, but Redis still executes them as 4 separate commands. Between our commands, another client's commands can interleave.

**Scenario: the race condition**

```
Rate limit: 100/min. Currently 99 requests in the window.
Client A and Client B arrive at the same moment.

Client A's pipeline: ZREM, ZADD(A), ZCARD, EXPIRE
Client B's pipeline: ZREM, ZADD(B), ZCARD, EXPIRE

Redis executes them interleaved:
  1. A.ZREMRANGEBYSCORE  → removes old entries (still 99)
  2. A.ZADD              → adds A (now 100 in set)
  3. B.ZREMRANGEBYSCORE  → nothing to remove (still 100)
  4. B.ZADD              → adds B (now 101 in set)
  5. A.ZCARD             → returns 101 → A is DENIED
  6. B.ZCARD             → returns 101 → B is DENIED

Result: Both denied. But one should have been allowed (99 → 100 is fine).
```

The problem is that both clients added their entry before either checked the count. By the time ZCARD runs, it sees both entries.

**The fix: Lua script (check-then-add, atomic)**

A Lua script executes as a single atomic unit in Redis. No other client's commands can run between any of the lines. This lets us flip the order: **count first, add only if under limit**.

```lua
-- rate_limit.lua
-- Runs atomically on the Redis server — no interleaving possible

local key = KEYS[1]
local window = tonumber(ARGV[1])    -- 60 seconds
local limit = tonumber(ARGV[2])     -- e.g. 100
local now = tonumber(ARGV[3])       -- current timestamp

-- Step 1: Remove entries older than the window
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

-- Step 2: Count FIRST (before adding)
local count = redis.call('ZCARD', key)

-- Step 3: Only add if under limit
if count < limit then
  redis.call('ZADD', key, now, now .. ':' .. math.random())
  redis.call('EXPIRE', key, window + 1)
  return {1, limit - count - 1}   -- {allowed=1, remaining}
else
  return {0, 0}                    -- {denied=0, remaining=0}
end
```

**Same scenario with Lua script:**

```
Rate limit: 100/min. Currently 99 requests in the window.
Client A and Client B arrive at the same moment.

Redis executes A's Lua script atomically (B waits):
  1. ZREMRANGEBYSCORE  → removes old entries (99 in set)
  2. ZCARD             → returns 99
  3. 99 < 100          → allowed!
  4. ZADD(A)           → adds A (100 in set)
  5. Return {1, 0}     → A is ALLOWED, 0 remaining

Then Redis executes B's Lua script atomically:
  1. ZREMRANGEBYSCORE  → nothing to remove (100 in set)
  2. ZCARD             → returns 100
  3. 100 < 100         → false!
  4. Return {0, 0}     → B is DENIED, entry never added

Result: A is allowed (99 → 100), B is denied (at limit). Exactly correct.
```

**Why the demo uses pipeline anyway:** At demo throughput (one user, a few requests/second), the race condition is nearly impossible. The pipeline is simpler code and easier to read. For production with thousands of concurrent requests per second, the Lua script is the right choice.

---

## 4. Validation

Acme accidentally sends an event with a timestamp from 45 days ago. It fails validation.

**Business rules** checked by `validateEvent()` in `src/api/validation.ts`:

| Rule | Check | Why |
|------|-------|-----|
| Future timestamp | `timestamp > now + 5min` | Prevents clock skew abuse. 5-minute buffer for reasonable drift. |
| Old timestamp | `timestamp < now - 30 days` | Prevents backfilling ancient data. Also keeps dedup Redis keys bounded. |
| Transaction ID format | Alphanumeric, dashes, underscores only | Prevents injection in Redis key names |
| Customer ID format | Same pattern | Same reason |
| Property value size | String values max 1000 chars | Prevents storage abuse |

Schema validation happens automatically via Fastify + TypeBox before the business rules run. TypeBox enforces structure — required fields, types, array bounds (max 1000 events per batch). Business validation catches things schema can't express — like "is this timestamp reasonable?"

Failed events are returned in the response so the client knows exactly what went wrong:

```json
{
  "accepted": 4,
  "duplicates": 0,
  "failed": [
    {"transaction_id": "txn_old_one", "reason": "Timestamp is older than 30 days"}
  ]
}
```

**Key files:** `src/api/validation.ts`, `src/api/schemas.ts`

---

## 5. Deduplication

Acme's integration retries a failed batch (network timeout). The same events arrive twice. Without deduplication, they'd be double-counted and Acme would be double-billed.

**How it works** (`src/utils/dedup.ts`):

Every event has a unique `transaction_id`. When a batch arrives:

1. For each event, try `SET dedup:{transaction_id} 1 NX EX 2592000` in Redis
2. `NX` = "set only if not exists" — this is the atomic check-and-set
3. If Redis returns `OK` → new event, accept it
4. If Redis returns `null` → duplicate, skip it

For batches, this runs as a Redis pipeline — all SET commands are sent in one round trip instead of one per event.

**Why SET NX over a simple EXISTS check:**

If you check with EXISTS and then SET separately, there's a race condition: two identical events arrive simultaneously, both check EXISTS (both return false), both get stored. SET NX is atomic — only one wins.

**Why 30-day TTL:**

The TTL matches the timestamp validation window (30 days). Events older than 30 days are rejected by validation, so dedup keys older than 30 days will never be checked. The TTL lets Redis reclaim the memory automatically.

**The response tells the client exactly what happened:**

```json
{
  "accepted": 3,
  "duplicates": 2,
  "failed": []
}
```

The client can look at `duplicates > 0` and know their retry was safe — no double-counting.

**Key files:** `src/utils/dedup.ts`

---

## 6. Storage & Backup

After passing validation and dedup, accepted events are stored in two places simultaneously.

### ClickHouse (primary storage)

Events are batch-inserted into a MergeTree table ordered by `(customer_id, event_type, timestamp)`. This ordering is deliberate — queries like "how many API calls did Acme make last month?" scan a contiguous range of data instead of jumping around the disk.

ClickHouse is a columnar database. When you query `SELECT count() FROM events WHERE customer_id = 'acme_corp'`, it only reads the `customer_id` column — not the entire row. This makes aggregation queries extremely fast even on millions of events.

**Key file:** `src/utils/storage.ts`

### MinIO backup (disaster recovery)

Every accepted batch is also written as a raw JSON file to MinIO (S3-compatible) at a path like:

```
events/2026/02/15/batch_1708012800000_a8f3x2.json
```

This provides:
- **Disaster recovery**: if ClickHouse loses data, replay from raw files
- **Audit trail**: immutable record of exactly what was received
- **Reprocessing**: if you find a bug in your aggregation logic, replay old events through the fixed pipeline

The date-partitioned path structure (`YYYY/MM/DD`) makes it easy to find and replay specific time ranges.

**Key file:** `src/utils/backup.ts`

---

## 7. Usage Aggregation

Acme wants to know how many API calls they've made this month. They query:

```bash
curl -H "X-API-Key: mf_..." \
  "localhost:3000/v1/usage?customer_id=acme_corp&metric=api_calls&start=1706745600000&end=1709424000000"
```

**How it works** (`src/utils/usage.ts`):

The key concept is the **Billable Metrics Catalog** (`src/config/metrics.ts`). It defines how raw events become billable quantities:

| Metric Code | Event Type | Aggregation | Property | Unit |
|-------------|-----------|-------------|----------|------|
| `api_calls` | `api_request` | COUNT | — | calls |
| `bandwidth` | `api_request` | SUM | `bytes` | bytes |
| `storage_peak` | `storage` | MAX | `gb_stored` | GB |
| `compute_time` | `compute` | SUM | `cpu_ms` | ms |

When Acme queries `metric=api_calls`, the system:

1. Looks up `api_calls` in the catalog → `{event_type: "api_request", aggregation: "COUNT"}`
2. Builds a ClickHouse query: `SELECT count() FROM events WHERE customer_id = 'acme_corp' AND event_type = 'api_request' AND timestamp BETWEEN ...`
3. Returns: `{value: 15000, unit: "calls"}`

For `bandwidth`, it's a SUM instead of COUNT: `SELECT sum(JSONExtractFloat(properties, 'bytes')) FROM events WHERE ...`

The catalog is the single source of truth for "how do raw events translate to billable numbers." Adding a new billable metric means adding one entry to the catalog — no query changes needed.

**Group-by support:**

Acme can also break down their usage by a property dimension:

```
GET /v1/usage?...&group_by=endpoint
→ {value: 15000, breakdown: {"/users": 8000, "/orders": 5000, "/products": 2000}}
```

This tells Acme which endpoints drive their bill.

**Key files:** `src/utils/usage.ts`, `src/config/metrics.ts`

---

## 8. Anomaly Detection (Z-Score)

It's a Tuesday and Acme normally makes ~1,000 API calls per day. Today they've made 5,000. Is something wrong?

The anomaly detection system answers this using Z-score statistics:

```
Z-score = (current_value - mean) / standard_deviation
Z = (5000 - 1000) / 200 = 20.0 → Critical anomaly
```

**How it works** (`src/utils/anomaly.ts`):

1. **Query current period**: count API calls in the last 24 hours → 5,000
2. **Query baseline**: get daily counts for the last 30 days → [980, 1020, 1050, 990, ...]
3. **Calculate statistics**: mean = 1,000, stddev = 200
4. **Calculate Z-score**: (5,000 - 1,000) / 200 = 20.0
5. **Classify severity**:
   - `|Z| < 2` → normal
   - `2 ≤ |Z| < 3` → warning
   - `|Z| ≥ 3` → critical

Z-score of 20 means Acme is 20 standard deviations above their normal usage — this is a critical anomaly. Possible causes: a runaway script, sudden viral growth, or an attack.

**What Z-score catches and what it misses:**

Z-score detects **volume** anomalies — "too much" or "too little" compared to history. But it misses **pattern** anomalies. If someone steals Acme's API key and makes the same 1,000 calls per day but at 3am instead of business hours, Z-score sees nothing unusual. That's where fraud detection comes in.

**Key files:** `src/utils/anomaly.ts`

---

## 9. Fraud Detection (Vector Similarity)

Someone steals Acme's API key. They're clever — they make roughly the same number of calls per day (1,000) to avoid triggering volume-based anomaly detection. But they're in a different timezone, so the calls happen at night instead of business hours.

**How it works** (three-stage process):

### Stage 1: Build Baselines (`src/utils/fraud/baseline.ts`)

After Acme has 30 days of history, you build baselines:

```bash
curl -X POST localhost:3000/v1/fraud/baselines/build \
  -d '{"customer_id": "acme_corp", "metric": "api_calls", "days": 30}'
```

This processes 30 days of data and creates a **per-weekday baseline**. Why per-weekday? Because usage patterns differ — Mondays might be heavier than Fridays, weekends are quieter.

For each day, the system generates a **24-dimensional vector** — one value per hour — representing the shape of usage across the day. All the Monday vectors are averaged together to create a Monday baseline, and so on.

The baseline vectors are stored in Redis with a 90-day TTL: `baseline:acme_corp:api_calls:monday → {vector: [0.01, 0.005, ..., 0.008], avg_volume: 1050}`

### Stage 2: Generate Hourly Vectors (`src/utils/fraud/vectors.ts`)

For any given day, the system queries ClickHouse for hourly event counts:

```sql
SELECT toHour(timestamp) as hour, count() as value
FROM events WHERE customer_id = 'acme_corp' AND toDate(timestamp) = '2026-02-15'
GROUP BY hour
```

This returns something like: `[5, 2, 1, 0, 0, 3, 15, 40, 80, 100, 100, 95, 90, 95, 100, 95, 85, 70, 50, 35, 25, 15, 10, 8]`

That's Acme's normal pattern — low at night, ramps up at 8am, peaks 9am-5pm, winds down in the evening.

The vector is **normalized** (divided by the sum) so we're comparing shapes, not volumes: `[0.008, 0.003, 0.001, 0.0, ..., 0.013]`

### Stage 3: Detect Fraud (`src/utils/fraud/detection.ts`)

On the day of the attack, the system compares today's vector against the baseline for today's weekday using **cosine similarity**:

```
Normal Tuesday:  [low, low, low, ..., HIGH, HIGH, HIGH, ..., low, low]  (9am-5pm peak)
Stolen key day:  [HIGH, HIGH, HIGH, ..., low, low, low, ..., HIGH, HIGH]  (10pm-4am peak)

Cosine similarity = 0.28 → way below 0.9 threshold → FRAUD DETECTED
```

Cosine similarity measures the angle between two vectors. 1.0 = identical pattern, 0.0 = completely different. The threshold is 0.9 — anything below means the shape of usage has fundamentally changed.

**The clever part**: the attacker kept the volume the same (~1,000 calls), so Z-score says "normal." But the vector comparison catches the pattern shift — same amount of work, completely different time distribution. The system flags this as `fraud_type: "pattern"` — the volume looks normal but the shape is wrong.

**Key files:** `src/utils/fraud/vectors.ts`, `src/utils/fraud/baseline.ts`, `src/utils/fraud/detection.ts`

---

## 10. Pricing & Invoicing

February ends. Time to calculate Acme's bill.

**Pricing Catalog** (`src/config/pricing.ts`):

Each metric has a pricing rule. API calls use **tiered pricing** — the more you use, the cheaper per unit:

| Tier | Range | Price |
|------|-------|-------|
| Free | 0 – 1,000 calls | $0.00/call |
| Standard | 1,001 – 10,000 calls | $0.001/call |
| Volume | 10,001+ calls | $0.0005/call |

Bandwidth and storage use **flat pricing** — simple multiplication:

| Metric | Price |
|--------|-------|
| Bandwidth | $0.00001/byte ($10.00/GB) |
| Peak Storage | $0.10/GB |
| Compute Time | $0.00001/ms ($36.00/hour) |

**Invoice calculation** (`src/utils/invoice.ts`):

```bash
curl -X POST localhost:3000/v1/invoices/calculate \
  -H "X-API-Key: mf_..." \
  -d '{"customer_id": "acme_corp", "start": 1706745600000, "end": 1709424000000}'
```

The system queries usage for each metric, then applies pricing rules:

**Acme's February usage:**
- API calls: 15,000 requests
- Bandwidth: 2.1 GB (2,100,000,000 bytes)
- Peak storage: 50 GB
- Compute: 0 ms

**Tiered calculation for API calls:**

The tiered pricing function walks through each tier, consuming quantity from the cheapest tier first:

1. Tier 1: 1,000 calls at $0.00 = **$0.00** (free tier consumed, 14,000 remaining)
2. Tier 2: 9,000 calls at $0.001 = **$9.00** (standard tier consumed, 5,000 remaining)
3. Tier 3: 5,000 calls at $0.0005 = **$2.50** (volume tier, all remaining)
4. API calls total: **$11.50**

**Flat calculations:**
- Bandwidth: 2,100,000,000 bytes x $0.00001 = **$21,000.00**
- Peak storage: 50 GB x $0.10 = **$5.00**

**Invoice total: $21,016.50**

The invoice comes back as a structured document with line items, tier breakdowns, and a `draft` status. It exists only in MeterFlow at this point — the customer hasn't been charged.

**Key files:** `src/utils/invoice.ts`, `src/config/pricing.ts`

---

## 11. Billing & Stripe

The invoice is calculated. Now we need to actually collect payment. This is where Stripe comes in.

```bash
curl -X POST localhost:3000/v1/billing/run \
  -H "X-API-Key: mf_..." \
  -d '{"customer_id": "acme_corp", "start": 1706745600000, "end": 1709424000000}'
```

**What happens** (`src/utils/billing.ts` → `src/utils/stripe.ts`):

1. **Calculate the MeterFlow invoice** — same as above, reuses `calculateInvoice()`
2. **Build Stripe API payloads** — translates our invoice into Stripe SDK calls

The Stripe flow has four steps:

### Step 1: Create Draft Invoice

```
stripe.invoices.create({
  customer: "cus_acme_corp",
  collection_method: "send_invoice",
  days_until_due: 30,
  auto_advance: false,
  metadata: {
    meterflow_invoice_id: "inv_a7b3c9d1",
    billing_period_start: "2026-02-01T00:00:00.000Z",
    billing_period_end: "2026-02-28T23:59:59.000Z"
  }
})
```

`auto_advance: false` keeps it as a draft until we explicitly finalize. The metadata links back to our internal invoice ID for reconciliation.

### Step 2: Add Line Items

One call per metric. Stripe requires amounts in **cents** (smallest currency unit):

```
stripe.invoiceItems.create({
  customer: "cus_acme_corp",
  invoice: "in_inv_a7b3c9d1",
  amount: 1150,        // $11.50 in cents
  currency: "usd",
  description: "API Calls: 15,000 requests (Tiered pricing)",
  metadata: { metric_code: "api_calls", quantity: "15000" }
})
```

The dollar-to-cents conversion (`Math.round(subtotal * 100)`) prevents floating-point issues. $11.50 becomes exactly 1150 cents.

### Step 3: Finalize Invoice

```
stripe.invoices.finalizeInvoice("in_inv_a7b3c9d1")
```

This locks the invoice — no more line items can be added. The invoice moves from `draft` to `open`.

### Step 4: Send to Customer

```
stripe.invoices.sendInvoice("in_inv_a7b3c9d1")
```

Stripe emails Acme a link to a hosted payment page. They click it, enter their payment method, and pay. Stripe handles the payment processing, receipts, and retry logic.

### Idempotency

Billing jobs must be idempotent. If the billing Lambda runs twice for the same period (timeout + retry, EventBridge duplicate delivery, manual re-run), Acme should not be double-charged.

The idempotency key is: `meterflow_{invoice_id}_{customer_id}_{period_start}_{period_end}`

When Stripe receives a second request with the same idempotency key within 48 hours, it returns the original response instead of creating a new invoice. For longer protection, you'd check a DynamoDB record before calling Stripe at all.

### Current Implementation

The current endpoint is a **dry-run** — it builds all the Stripe payloads but doesn't call Stripe. The response includes both the MeterFlow invoice and the exact Stripe API calls that would execute. To go live, you'd replace `buildStripeOperations()` with actual Stripe SDK calls — the data structures are identical.

**Key files:** `src/utils/billing.ts`, `src/utils/stripe.ts`, `src/types/billing.ts`

---

## 12. Deep Dive: Async Ingestion & Back-Pressure

The demo pipeline is synchronous — validate, dedup, store, backup all happen in one request. This is simple and works for demo throughput, but in production, you'd decouple ingestion from processing using a stream buffer.

### The async pipeline

```
Client sends POST /v1/events
         │
         ▼
┌─────────────────┐
│  API Gateway    │  Receives the HTTP request
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Ingestion      │  1. Validates schema + business rules
│  Lambda         │  2. Checks Redis for duplicates (SET NX)
│                 │  3. Writes accepted events to Kinesis
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Client gets    │  202 Accepted (not 200 OK)
│  response back  │  "Your events are received, processing happens later"
└─────────────────┘
```

The client is done. They don't wait for ClickHouse or S3. The response is fast because validation + dedup are Redis operations (sub-millisecond).

**In the background:**

```
┌─────────────────┐
│  Kinesis Stream │  Events sit here, ordered by customer_id (partition key)
│  (the buffer)   │  Retained for 7 days even if nothing reads them
└────────┬────────┘
         │  Kinesis triggers processor Lambda with a batch of records
         ▼
┌─────────────────┐
│  Processor      │  1. Batch insert into ClickHouse
│  Lambda         │  2. Write raw JSON to S3
└─────────────────┘
```

### How back-pressure works

Each Kinesis shard has a **hard write capacity**: 1 MB/sec and 1,000 records/sec. These are fixed limits per shard — not configurable.

Back-pressure means: **when one part of the system is overwhelmed, it pushes resistance back to the caller so the caller slows down.** In this pipeline, Kinesis shard limits are the natural throttle point.

### Scenario 1: Traffic spike (ingestion side)

Normal traffic is 500 events/sec. You have 1 Kinesis shard (capacity: 1,000 records/sec). Suddenly a customer's integration goes haywire and sends 2,000 events/sec.

```
Normal:    500 events/sec  →  Kinesis shard (1,000/sec capacity)  →  accepted
Spike:   2,000 events/sec  →  Kinesis shard (1,000/sec capacity)  →  FULL
```

When the ingestion Lambda calls `kinesis.putRecords()` and the shard is full, Kinesis throws `ProvisionedThroughputExceededException`. The Lambda catches this and returns **429 Too Many Requests** back through API Gateway to the client.

```
Client  ←── 429 Too Many Requests ←── Lambda ←── Kinesis shard full

The pressure chain:
  Client sees 429 → backs off (exponential retry)
  → traffic drops → shard has capacity again → requests start succeeding
```

The client sees 429 with a `retry_after_seconds` header and knows to slow down. This is back-pressure: the system's capacity limit propagates all the way back to the caller.

### Scenario 2: ClickHouse is slow (processing side)

Traffic is normal, but ClickHouse is having a bad day — slow inserts, maintenance, whatever.

**Without Kinesis (our current sync pipeline):**

```
Client sends event
  → Lambda tries ClickHouse insert
  → ClickHouse takes 10 seconds to respond
  → Client's request hangs for 10 seconds
  → If many concurrent requests: all blocked, all timing out
```

Every client is directly coupled to ClickHouse's performance.

**With Kinesis:**

```
Client sends event
  → Lambda validates, dedupes, writes to Kinesis
  → Client gets 202 Accepted in ~50ms (ClickHouse not involved)

Meanwhile in the background:
  Kinesis: [event1, event2, event3, event4, ...]  ← records accumulating
                                        │
                                        ▼
  Processor Lambda: ClickHouse insert is slow...
    → Lambda execution takes 30s instead of 2s
    → Fewer batches processed per minute
    → Records pile up in Kinesis (buffer absorbs the backlog)

  ClickHouse recovers:
    → Processor Lambda speeds up
    → Works through the backlog
    → Stream drains back to normal
```

The client never knew anything was wrong — they got their 202 immediately. Kinesis absorbed the impact. The 7-day retention means even if ClickHouse is down for hours, no data is lost.

### Scenario 3: Processor Lambda crashes

The processor Lambda hits an uncaught exception and crashes.

```
Kinesis: [event1, event2, event3, ...]
                    │
                    ▼
  Processor Lambda: CRASH

  Kinesis retries:
    → Sends the same batch to a new Lambda invocation
    → Lambda crashes again

  After N retries (configurable):
    → Failed records route to SQS Dead Letter Queue (DLQ)
    → DLQ retains records for 14 days
    → Engineer investigates, fixes the bug, replays from DLQ

  Meanwhile:
    → New events keep flowing into Kinesis (clients still get 202)
    → Only the failing batch is stuck, not the whole stream
```

The DLQ is the safety net. Events are never lost — they either make it to ClickHouse or they land in the DLQ for manual replay.

### Why Kinesis over SQS

Both are AWS message services, but they serve different purposes:

| Concern | Kinesis | SQS |
|---------|---------|-----|
| Ordering | Ordered within shard (partition by customer_id) | No ordering guarantee |
| Replay | Can re-read data within retention window | Once consumed, gone |
| Retention | Configurable (1-365 days) | 14 days max |
| Consumer model | Multiple consumers read same data | Single consumer per message |
| Back-pressure | Shard limits provide natural throttle | No built-in throttle |

For a billing system, ordering matters — if Acme sends events A, B, C, they should be processed in that order. Kinesis guarantees this within a shard when you partition by customer_id. SQS doesn't guarantee ordering (unless you use FIFO queues, which have lower throughput).

Replay is also critical — if you find a bug in the processor, you can rewind the stream and reprocess. With SQS, consumed messages are gone.

### The key insight

Kinesis decouples "receiving events" from "processing events":

- **Fast path** (client-facing): validate → dedup → write to Kinesis → 202 Accepted
- **Slow path** (background): read from Kinesis → ClickHouse insert → S3 backup

The client only touches the fast path. The slow path happens asynchronously. And the shard capacity limits are what prevent the system from being overwhelmed — that's the back-pressure mechanism.

---

## Full Pipeline Summary

Here's the complete lifecycle of a usage event, from ingestion to billing:

```
Acme's backend
    │
    ▼
POST /v1/events (with X-API-Key)
    │
    ├── Authentication → Redis lookup → customer scoping
    ├── Rate Limiting  → Redis sorted set → sliding window check
    │
    ▼ (request allowed)
    │
    ├── Validation     → Schema (TypeBox) + business rules (timestamp, format)
    ├── Deduplication  → Redis SET NX → reject duplicates
    ├── Storage        → ClickHouse batch insert (columnar, fast aggregation)
    ├── Backup         → MinIO/S3 raw JSON (disaster recovery, audit trail)
    │
    ▼ (events stored)
    │
    ├── Usage Query    → Metrics catalog + ClickHouse aggregation
    ├── Anomaly Detection → Z-score against 30-day baseline (volume)
    ├── Fraud Detection   → Cosine similarity of hourly vectors (pattern)
    │
    ▼ (end of billing period)
    │
    ├── Invoice Calculation → Usage × pricing rules → line items
    ├── Stripe Integration  → Create invoice → add items → finalize → send
    │
    ▼
Acme receives invoice, pays via Stripe
```

Each step is a separate, testable module. The pipeline is synchronous in demo mode (single request processes everything) but designed to be split into async stages for production (Kinesis buffering, Lambda processors, scheduled billing jobs). See [Production Considerations](PRODUCTION_CONSIDERATIONS.md) for how each component would change for AWS deployment.
