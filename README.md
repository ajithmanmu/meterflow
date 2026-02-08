# MeterFlow

A usage-based billing engine built for learning and portfolio demonstration. Handles event ingestion, deduplication, storage, and aggregation for metered billing scenarios.

## Architecture

```
┌──────────┐     ┌───────────────┐     ┌──────────┐     ┌──────────────┐
│  Client  │────▶│   API Layer   │────▶│  Redis   │────▶│   Worker     │
└──────────┘     │  (Fastify)    │     │  (Dedup) │     │  (Process)   │
                 └───────────────┘     └──────────┘     └──────┬───────┘
                                                               │
                                         ┌─────────────────────┼──────────────────┐
                                         ▼                                        ▼
                                  ┌─────────────┐                          ┌─────────────┐
                                  │ ClickHouse  │                          │    MinIO    │
                                  │  (Storage)  │                          │  (Backup)   │
                                  └─────────────┘                          └─────────────┘
```

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **API Framework:** Fastify with TypeBox validation
- **Queue/Dedup:** Redis (SET NX for idempotency)
- **Storage:** ClickHouse (columnar DB for analytics)
- **Backup:** MinIO (S3-compatible object storage)
- **Containers:** Docker Compose

## Features

### Implemented
- [x] Event ingestion API (`POST /v1/events`)
- [x] Batch event support (up to 1000 events per request)
- [x] Schema validation (TypeBox)
- [x] Business validation (timestamp bounds, ID format)
- [x] Idempotent ingestion (Redis deduplication)
- [x] Event storage (ClickHouse with MergeTree)
- [x] Raw event backup (MinIO for disaster recovery)
- [x] Health check endpoint

### Planned
- [ ] Usage query API (aggregations by customer/time)
- [ ] Pricing engine (rate cards, tiered pricing)
- [ ] Invoice generation
- [ ] Customer management API
- [ ] API authentication (API keys)
- [ ] Rate limiting
- [ ] Async processing mode
- [ ] Dashboard UI

## Getting Started

### Prerequisites
- Node.js 18+
- pnpm
- Docker & Docker Compose

### Setup

```bash
# Install dependencies
pnpm install

# Start infrastructure (Redis, ClickHouse, MinIO)
docker compose up -d

# Start the API server
pnpm dev
```

### Test the API

```bash
# Health check
curl http://localhost:3000/health

# Ingest events
curl -X POST http://localhost:3000/v1/events \
  -H "Content-Type: application/json" \
  -d '{
    "events": [
      {
        "transaction_id": "txn_001",
        "customer_id": "cust_123",
        "event_type": "api_request",
        "timestamp": 1707357600000,
        "properties": {
          "endpoint": "/v1/users",
          "bytes": 2048
        }
      }
    ]
  }'
```

### Response Format

```json
{
  "accepted": 1,
  "duplicates": 0,
  "failed": []
}
```

## Event Schema

| Field | Type | Description |
|-------|------|-------------|
| `transaction_id` | string | Unique ID for idempotency |
| `customer_id` | string | Customer identifier |
| `event_type` | string | Event category (e.g., `api_request`, `storage`) |
| `timestamp` | number | Unix epoch milliseconds |
| `properties` | object | Flexible key-value data for billing metrics |

## Project Structure

```
src/
├── api/
│   ├── server.ts      # Fastify server & routes
│   ├── schemas.ts     # TypeBox validation schemas
│   └── validation.ts  # Business validation logic
├── config/
│   ├── redis.ts       # Redis client setup
│   ├── clickhouse.ts  # ClickHouse client & init
│   └── minio.ts       # MinIO (S3) client & init
├── utils/
│   ├── dedup.ts       # Deduplication logic
│   ├── storage.ts     # ClickHouse operations
│   └── backup.ts      # MinIO backup operations
└── types/
    └── event.ts       # TypeScript interfaces
```

## Infrastructure

| Service | Port | Purpose |
|---------|------|---------|
| API | 3000 | Event ingestion |
| Redis | 6379 | Deduplication |
| RedisInsight | 8001 | Redis UI |
| ClickHouse | 8123 | Event storage |
| MinIO API | 9002 | Object storage |
| MinIO Console | 9003 | MinIO UI |

## License

MIT
