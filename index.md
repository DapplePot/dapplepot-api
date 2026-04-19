# DapplePot API — Agent Index

**Role:** Platform API. TypeScript/Hono REST service — ingest write path (events from SDK), REST read path (dashboard queries), and SSE live feed. Fans out ingest events to Postgres, ClickHouse, and the security service over HTTP.

**Stack:** TypeScript (strict), Node.js 22, Hono 4, pnpm, postgres.js, @clickhouse/client, ioredis

---

## Directory Map

```
src/
  index.ts             Hono app entry; mounts all routers; starts server on PORT (default 3000)

  routes/
    ingest.ts          POST /v1/ingest/events — 3-way fanout (ClickHouse + Postgres + security)
                       sdkKeyAuth middleware; bulk ClickHouse insert; per-event Postgres upsert;
                       fire-and-forget security forward via security-client.ts
    auth.ts            POST /v1/auth/login|logout|refresh|forgot-password|reset-password|accept-invite
    sessions.ts        GET /v1/sessions, /v1/sessions/:id, /v1/sessions/:id/trace (cursor pagination)
                       GET /v1/sessions/live (SSE — live session feed)
    analytics.ts       GET /v1/analytics/overview|llm-usage|error-rates|latency|cost
    security.ts        GET /v1/security/* — risk scores, findings, agent profiles, signal registry
                       PATCH endpoints for thresholds and subcheck toggles
    alerts.ts          GET/PATCH /v1/alerts, /v1/alerts/:id
    agents.ts          GET/POST /v1/agents
    rules.ts           GET/POST/PATCH /v1/rules
    channels.ts        GET/POST/PATCH /v1/channels
    sdk-keys.ts        GET /v1/sdk-keys, POST /v1/sdk-keys/:id/reveal
    tenants.ts         GET /v1/tenants, POST /v1/tenants/onboard (superadmin only)
    users.ts           GET/POST/PATCH /v1/users, /v1/users/me
    control.ts         POST /v1/control/kill-switch|interrupt (publishes to Redis pub/sub)

  lib/
    session-writer.ts  CAS upsert with SELECT FOR UPDATE SKIP LOCKED; state machine:
                         stub → open (graph_start)
                         open → finalised (graph_end)
                         open → terminated (graph_error)
                       SDK_TO_INTERNAL map: session_start→graph_start, session_end→graph_end,
                         session_error→graph_error
    event-appender.ts  ClickHouse bulk insert to obs_events (36 cols);
                       RollingDedup — rotating Set pair, 60s window prevents duplicate events
    security-client.ts HTTP forward to POST {SECURITY_SERVICE_URL}/v1/evaluate;
                       filtered to: graph_start, graph_end, graph_error, security_finding only;
                       5s timeout; fire-and-forget (never fails ingest)
    db.ts              postgres.js pool singleton
    clickhouse.ts      @clickhouse/client singleton
    redis.ts           ioredis singleton

  middleware/
    auth.ts            JWT verify (DAPPLEPOT_JWT_SECRET); sdk_key lookup from Postgres
    rate-limit.ts      Per-tenant rate limiting via Redis

  types/               Shared TypeScript types — sync into dapplepot-ui via `pnpm sync-types`

db/
  postgres/            21 Postgres migration files (001_tenants.sql … 021_remove_killed_status.sql)
                       Run with: pnpm migrate
  clickhouse/          4 ClickHouse schema files (001_obs_events.sql … 004_obs_session_tokens.sql)
                       Run with: pnpm migrate-clickhouse
    session.ts, analytics.ts, security.ts, alert.ts, auth.ts, agent.ts, …
```

---

## Ingest Fanout (Critical Path)

```
POST /v1/ingest/events  (header: x-sdk-key)
  │
  ├─ [1] event-appender.ts
  │    INSERT INTO obs_events (batch, 36 cols)
  │    RollingDedup: skip exact-duplicate event_id within 60s window
  │
  └─ [2] Promise.allSettled([...]) per event:
       ├─ session-writer.ts
       │    SELECT FOR UPDATE SKIP LOCKED on sessions
       │    CAS upsert: state machine transition
       │    INSERT session_events row
       │
       └─ security-client.ts  (graph_start / graph_end / graph_error / security_finding only)
            POST {SECURITY_SERVICE_URL}/v1/evaluate
            5s timeout, fire-and-forget
```

ClickHouse write completes before the per-event fan-out starts. All per-event operations run concurrently via `Promise.allSettled` — a failure in one event's security forward does not fail the others.

---

## ClickHouse: obs_events Table

36 columns. Key hot-extracted fields (indexed for fast query without JSON scan):

| Column | Source |
|--------|--------|
| `event_id` | SDK-generated UUID |
| `session_id` | From event |
| `tenant_id` | From SDK key lookup |
| `agent_id` | From event |
| `event_type` | `graph_start\|node_start\|llm_start\|…` |
| `node_name` | Hot-extracted from payload |
| `model` | Hot-extracted from LLM events |
| `prompt_tokens` | Hot-extracted |
| `completion_tokens` | Hot-extracted |
| `latency_ms` | Hot-extracted |
| `emitted_at` | SDK timestamp (TIMESTAMPTZ) |
| `received_at` | API insertion time |
| `payload` | Full JSON (remaining fields) |

Partitioned by `toYYYYMM(emitted_at)`. Primary key: `(tenant_id, session_id, emitted_at, event_id)`.

---

## Session State Machine

```
                  graph_start
(no row) ──────────────────────→ open
                  graph_end
    open ──────────────────────→ finalised  (immutable)
                  graph_error
    open ──────────────────────→ terminated (immutable)
```

SDK sends `session_start/end/error`; `session-writer.ts` translates via `SDK_TO_INTERNAL` before applying the state machine.

---

## SSE: Live Session Feed

`GET /v1/sessions/live` — streams `SessionSummary[]` every ~5s.

```
Response: text/event-stream
event: sessions
data: [{...SessionSummary}, ...]
```

UI uses `@microsoft/fetch-event-source` (needs Authorization header). `queryClient.setQueryData(['sessions', 'live'], sessions)` on each message — no redundant HTTP poll.

---

## Configuration Reference

```env
POSTGRES_URL=postgresql://dapplepot:dapplepot@localhost:5432/dapplepot
CLICKHOUSE_HOST=localhost
CLICKHOUSE_PORT=8123
CLICKHOUSE_USER=dapplepot
CLICKHOUSE_PASSWORD=dapplepot
REDIS_URL=redis://localhost:6379
SECURITY_SERVICE_URL=http://localhost:8001
DAPPLEPOT_JWT_SECRET=<secret>
PORT=3000
```

---

## Finding Specific Code

| Need to... | File |
|-----------|------|
| Change ingest fan-out logic | `src/routes/ingest.ts` |
| Change session state machine | `src/lib/session-writer.ts` → `SDK_TO_INTERNAL` + `TRANSITIONS` |
| Change ClickHouse schema / hot fields | `src/lib/event-appender.ts` |
| Change which events go to security | `src/lib/security-client.ts` → `SECURITY_EVENT_TYPES` set |
| Add a new REST route | `src/routes/<resource>.ts` + mount in `src/index.ts` |
| Add a shared type | `src/types/<resource>.ts` → run `pnpm sync-types` in dapplepot-ui |
| Change JWT expiry | `src/routes/auth.ts` |
| Change rate limits | `src/middleware/rate-limit.ts` |
| Debug missing security evaluations | `src/lib/security-client.ts` — check `SECURITY_EVENT_TYPES` filter + 5s timeout logs |
