# dapplepot-api

**DapplePot — Platform API**

TypeScript/Hono REST service that serves as the central hub of the DapplePot platform. Receives events from `dapplepot-sdk`, fans them out to Postgres, ClickHouse, and `dapplepot-security`, and serves the React dashboard with session, analytics, security, and alert data.

**Stack:** TypeScript (strict), Node.js 22, Hono 4, pnpm, postgres.js, @clickhouse/client, ioredis

## Quick Start

```bash
pnpm install
cp .env.example .env   # fill in connection strings
pnpm db:migrate        # run Postgres migrations
pnpm dev               # http://localhost:3000
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POSTGRES_URL` | ✅ | — | `postgresql://user:pass@host:5432/db` |
| `CLICKHOUSE_HOST` | ✅ | — | ClickHouse host |
| `CLICKHOUSE_PORT` | — | `8123` | ClickHouse HTTP port |
| `CLICKHOUSE_USER` | — | `dapplepot` | ClickHouse user |
| `CLICKHOUSE_PASSWORD` | — | — | ClickHouse password |
| `REDIS_URL` | ✅ | — | `redis://localhost:6379` |
| `SECURITY_SERVICE_URL` | ✅ | `http://localhost:8001` | `dapplepot-security` base URL |
| `DAPPLEPOT_JWT_SECRET` | ✅ | — | JWT signing secret |
| `PORT` | — | `3000` | HTTP listen port |

## Ingest — 3-Way Fanout

`POST /v1/ingest/events` (authenticated via `x-sdk-key`) is the write path. For each event batch it fans out in parallel:

```
POST /v1/ingest/events
  ├─ ClickHouse → obs_events (bulk insert, 36 cols, rolling dedup 60s)
  ├─ Postgres   → sessions (CAS upsert, state machine: stub→open→finalised/terminated)
  └─ HTTP POST  → {SECURITY_SERVICE_URL}/v1/evaluate
                  (graph_start, graph_end, graph_error, security_finding only)
```

All three writes use `Promise.allSettled` — a failure in one leg does not fail the ingest request.

## Session State Machine

The session-writer implements a compare-and-swap upsert with `SELECT FOR UPDATE SKIP LOCKED`:

| Event received | Current state | New state |
|----------------|--------------|-----------|
| `graph_start` | — | `open` |
| `graph_end` | `open` | `finalised` |
| `graph_error` | `open` | `terminated` |

Event type mapping (SDK → internal): `session_start→graph_start`, `session_end→graph_end`, `session_error→graph_error`.

## Key Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/v1/ingest/events` | sdk_key | Ingest event batch from SDK |
| `POST` | `/v1/auth/login` | — | Login, get JWT + refresh token |
| `POST` | `/v1/auth/refresh` | refresh_token | Rotate access token |
| `GET` | `/v1/sessions` | JWT | Paginated session list |
| `GET` | `/v1/sessions/:id` | JWT | Session detail |
| `GET` | `/v1/sessions/:id/trace` | JWT | Cursor-paginated event trace |
| `GET` | `/v1/analytics/*` | JWT | Overview, LLM usage, error rates, cost |
| `GET` | `/v1/security/*` | JWT | Risk scores, findings, agent profiles |
| `GET` | `/v1/alerts` | JWT | Alert feed |
| `GET` | `/v1/agents` | JWT | Agent registry |
| `POST` | `/v1/control/kill-switch` | JWT | Publish terminate to Redis |
| `GET` | `/v1/sessions/live` | JWT | SSE — live session feed |

## Key Files

| File | Description |
|------|-------------|
| `src/routes/ingest.ts` | 3-way fanout handler; `sdkKeyAuth` middleware |
| `src/lib/session-writer.ts` | CAS upsert, state machine, `SDK_TO_INTERNAL` map |
| `src/lib/event-appender.ts` | ClickHouse bulk insert, `RollingDedup` (60s window) |
| `src/lib/security-client.ts` | Fire-and-forget HTTP forward to security service (5s timeout) |
| `src/lib/db.ts` | postgres.js pool |
| `src/lib/clickhouse.ts` | @clickhouse/client singleton |
| `src/lib/redis.ts` | ioredis singleton |
| `src/middleware/auth.ts` | JWT verify + sdk_key lookup |
| `src/types/` | Shared TypeScript types (copied into `dapplepot-ui/src/types/`) |

## Related Repos

| Repo | Role |
|------|------|
| [dapplepot-sdk](../dapplepot-sdk) | Python SDK — sends events here |
| [dapplepot-security](../dapplepot-security) | FastAPI security engine — receives forwarded events |
| [dapplepot-ui](../dapplepot-ui) | React dashboard — reads from this API |
