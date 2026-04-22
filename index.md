# DapplePot API — Agent Index

**Role:** Platform API. TypeScript/Hono REST service — ingest write path (events from SDK), REST read path (dashboard queries), and SSE live feed. Fans out ingest events to Postgres, ClickHouse, and the security service over HTTP.

**Stack:** TypeScript (strict), Node.js 22, Hono 4, pnpm, postgres.js, @clickhouse/client, ioredis

---

## Directory Map

```
src/
  index.ts             Hono app entry; mounts all routers; starts server on PORT (default 3000)

  routes/
    ingest.ts          POST /v1/ingest/events — normalize SDK v2 envelopes, batch idempotency
                       via Redis (dp:batch:{batchId}, TTL 3600s), then fire-and-forget processEvents()
                       sdkKeyAuth middleware; MAX_BATCH = 100
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
                         stub → finalised (graph_end race win before graph_start)
                         open → finalised (graph_end)
                         open → terminated (graph_error)
                       security_finding: out-of-band — patches graph_runs, never advances last_seq
                       graph_end/graph_error: closing events — never dropped on stale sequence index
                       checkpoint_write: updates graphState only
                       exit_reason: read from payload if present; else 'security_terminated' when
                         SecurityViolationError or DapplePotSessionTerminatedError detected
                       graph_runs: JSONB array tracks all lifecycle entries
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

  queries/             Extracted DB query functions — one file per resource
    sessions.pg.ts     Session list, detail, trace, state history queries
    security.pg.ts     Risk scores, findings (post_session + cross_session), agent profiles, signal registry, alert config
                       getSessionActions: now returns triggerEventType per action row
    security.ch.ts     ClickHouse security queries
    sessions.ch.ts     ClickHouse session queries
    analytics.ch.ts    ClickHouse analytics queries
    agents.pg.ts       Agent registry queries
    alerts.pg.ts       Alert feed + detail queries
    channels.pg.ts     Notification channel queries
    rules.ts           Policy rule queries
    users.pg.ts        User management queries
    tenants.pg.ts      Tenant queries
    sdk-keys.pg.ts     SDK key lookup + reveal queries
    invites.pg.ts      Invite management queries
    refresh-tokens.pg.ts, password-resets.pg.ts

  middleware/
    auth.ts            JWT verify (DAPPLEPOT_JWT_SECRET); sdk_key lookup from Postgres
    rate-limit.ts      Per-tenant rate limiting via Redis

  types/               Shared TypeScript types — sync into dapplepot-ui via `pnpm sync-types`

db/
  postgres/            21 Postgres migration files (001_tenants.sql … 021_remove_killed_status.sql)
                       Run with: pnpm migrate
  clickhouse/          4 ClickHouse schema files (001_obs_events.sql … 004_obs_session_tokens.sql)
                       Run with: pnpm migrate-clickhouse
```

---

## Ingest Fanout (Critical Path)

```
POST /v1/ingest/events  (header: x-sdk-key)
  │
  ├─ Normalize SDK v2 envelopes (dp_event_type / dp_session_id aliases)
  ├─ Batch idempotency: Redis SET dp:batch:{batchId} NX EX 3600  ← early return if duplicate
  ├─ Return 202 immediately (fire-and-forget below)
  │
  └─ processEvents() [background, void]
       │
       ├─ [1] event-appender.ts (bulk, whole batch)
       │    INSERT INTO obs_events (batch, 36 cols)
       │    RollingDedup: skip exact-duplicate event_id within 60s window
       │
       ├─ [2] session-writer.ts (sequential — preserves state machine ordering)
       │    For each event:
       │      SELECT FOR UPDATE SKIP LOCKED on sessions
       │      CAS upsert: state machine transition, graph_runs append
       │      Out-of-band: security_finding skips last_seq advance
       │      Closing: graph_end/graph_error never dropped on stale seq
       │
       └─ [3] security-client.ts (parallel via Promise.allSettled)
            POST {SECURITY_SERVICE_URL}/v1/evaluate
            5s timeout, fire-and-forget (graph_start/end/error + security_finding only)
```

HTTP response returns 202 before any of the three writes complete. A failure in one write does not affect the others.

---

## SDK v2 Envelope Normalization

`normalize()` in `ingest.ts` accepts both prefixed and un-prefixed field names:

| Internal field | SDK v2 field | Fallback |
|----------------|-------------|---------|
| `sdkEventType` | `dp_event_type` | `event_type` |
| `sessionId` | `dp_session_id` | `session_id` |
| `agentId` | `dp_agent_id` | `agent_id` |
| `tenantId` | `dp_tenant_id` | `tenant_id` (from sdk_key lookup) |

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
(no row) ──────────────────────→ stub → open
                  graph_end (before graph_start arrives)
(no row) ──────────────────────→ finalised   (race guard)
                  graph_end
    open ──────────────────────→ finalised  (immutable)
                  graph_error
    open ──────────────────────→ terminated (immutable)
                                 exit_reason = 'security_terminated' if SecurityViolationError
```

SDK sends `session_start/end/error`; `session-writer.ts` translates via `SDK_TO_INTERNAL` before applying the state machine.

**Special event handling:**
- `security_finding` — out-of-band: patches `graph_runs` array but never advances `last_seq` (SDK emits these inline before the buffer flushes session_start)
- `checkpoint_write` — updates `graph_state` only
- `graph_end`/`graph_error` — closing events: never discarded on stale sequence index

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
| Change ingest fan-out logic | `src/routes/ingest.ts` → `processEvents()` |
| Change batch idempotency TTL | `src/routes/ingest.ts` → `BATCH_DEDUP_TTL` |
| Change session state machine | `src/lib/session-writer.ts` → `SDK_TO_INTERNAL` + `TRANSITIONS` |
| Change closing/out-of-band event logic | `src/lib/session-writer.ts` → `isClosingEvent` / `isOutOfBand` |
| Change ClickHouse schema / hot fields | `src/lib/event-appender.ts` |
| Change which events go to security | `src/lib/security-client.ts` → `SECURITY_EVENT_TYPES` set |
| Add a new REST route | `src/routes/<resource>.ts` + mount in `src/index.ts` |
| Add a DB query | `src/queries/<resource>.pg.ts` or `.ch.ts` |
| Add a shared type | `src/types/<resource>.ts` → run `pnpm sync-types` in dapplepot-ui |
| Change JWT expiry | `src/routes/auth.ts` |
| Change rate limits | `src/middleware/rate-limit.ts` |
| Debug missing security evaluations | `src/lib/security-client.ts` — check `SECURITY_EVENT_TYPES` filter + 5s timeout logs |
