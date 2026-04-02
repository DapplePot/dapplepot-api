# dapplepot_api

**Dapplepot — Platform API**

Zone 4 of the Dapplepot observability platform. This is the read-side API
that serves the dashboard (`dapplepot_ui`) and the `dapplepot_langgraph` SDK
control channel. It reads from the Postgres and ClickHouse databases that
`dapplepot_pipeline` writes to.

**Language: TypeScript + Hono**

---

## Why TypeScript for this service

`dapplepot_pipeline` is Python (write path — Kafka consumers, bulk inserts).
`dapplepot_api` is TypeScript for three concrete reasons:

1. **Shared types with the UI.** `dapplepot_ui` is React/TypeScript. The API
   response types defined in `src/types/` can be exported as a `@dapplepot/types`
   package that the UI imports directly. The API shape and the UI's expected
   shape are the same TypeScript file — they can never drift apart.

2. **Native SSE.** `GET /v1/sessions/live` is an SSE stream. Hono has
   first-class streaming support built in. No workarounds.

3. **Async fan-out is idiomatic.** Every session detail response requires a
   parallel Postgres + ClickHouse query. `Promise.all([pgQuery, chQuery])` is
   the natural Node.js pattern for this — readable and efficient.

---

## What this service does

```
dapplepot_ui (React dashboard)
  └── GET  /v1/sessions                 paginated session list
  └── GET  /v1/sessions/:id             stitch: Postgres + ClickHouse
  └── GET  /v1/sessions/:id/trace       cursor-paginated event timeline
  └── GET  /v1/sessions/:id/state-history  checkpoint + interrupt events
  └── GET  /v1/sessions/:id/alerts      alerts for a session
  └── GET  /v1/sessions/live            SSE — open sessions pushed every 2s
  └── GET  /v1/analytics/overview       session counts + token/latency summary
  └── GET  /v1/analytics/llm-usage      token usage over time by model
  └── GET  /v1/analytics/error-rates    error rate per node
  └── GET  /v1/analytics/latency        avg + p95 latency over time
  └── GET  /v1/analytics/cost           token cost by agent
  └── GET  /v1/analytics/sessions/funnel  session completion funnel
  └── GET  /v1/alerts                   paginated alert feed
  └── GET  /v1/alerts/:id               alert detail
  └── PUT  /v1/alerts/:id/status        acknowledge or resolve
  └── GET  /v1/alerts/stats             counts by severity + top rules
  └── POST /v1/control/kill-switch      terminate session → Redis + Kafka
  └── POST /v1/control/interrupt        interrupt session → Kafka
  └── GET/POST/PUT /v1/rules            policy rule management
  └── GET/POST/PUT /v1/channels         delivery channel management
  └── GET  /v1/security/overview        tenant risk summary (band distribution, OWASP freq)
  └── GET  /v1/security/sessions/:id/score    per-session risk score from dapplepot_security
  └── GET  /v1/security/sessions/:id/findings security findings for a session
  └── GET  /v1/security/remediation     top firing signals + fix guidance
  └── GET  /v1/security/signatures      active injection signatures for tenant

dapplepot_langgraph SDK
  └── GET  /v1/control/commands         SDK polls every 5s for pending commands (JSON)

Reads from:
  ├── Postgres     (sessions, agents, alerts, policy_rules, channels, alert_deliveries,
  │                 session_risk_scores, security_findings, injection_signatures)
  └── ClickHouse   (obs_events, obs_llm_hourly, obs_error_hourly, obs_session_tokens)

Writes to:
  ├── Postgres     (alerts.status, alerts.resolved_at — acknowledge/resolve only)
  ├── Redis        (dp:commands:{agent_id} — command queue; cache invalidation)
  └── Kafka        (obs.priority.v1 — kill-switch + interrupt commands only)
```

**No HTTP calls to `dapplepot_pipeline`.** Shared databases and Redis are the
only integration points between the two services.

---

## Related repositories

| Repo | Zone | Language | What it is |
|------|------|----------|-----------|
| `dapplepot_sim` | 1 | Python | Simulation agent |
| `dapplepot_langgraph` | 2 | Python | SDK |
| `dapplepot_pipeline` | 3 | Python | Event ingestion + pipeline (write path) |
| **`dapplepot_api`** | **4** | **TypeScript** | **This repo — platform API (read path)** |
| `dapplepot_ui` | 5 | TypeScript / React | Dashboard |
| `dapplepot_security` | 6 | Python | OWASP detection + risk scoring |

---

## Repo layout

```
dapplepot_api/
├── agent.md                        ← full IDE agent context (read before coding)
├── README.md                       ← this file
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json                   ← strict mode
├── tsconfig.build.json
├── .env.example
├── vitest.config.ts
│
├── scripts/
│   └── migrate.ts                  ← Node.js migration runner (no psql needed)
│
└── src/
    ├── index.ts                    ← server entry: serve() + SIGTERM handler
    ├── app.ts                      ← Hono app, middleware, routes, error handlers
    ├── env.ts                      ← zod-validated env vars (dotenv loaded here)
    │
    ├── types/                      ← exported as @dapplepot/types for dapplepot_ui
    │   ├── index.ts                ← barrel re-export of all type modules
    │   ├── session.ts              ← SessionStatus, SessionSummary, SessionDetail,
    │   │                              TraceEvent, TracePage, StateHistoryEvent, StateHistory
    │   ├── alert.ts                ← AlertSummary, AlertDetail, AlertStatus, AlertStats,
    │   │                              AlertDelivery
    │   ├── analytics.ts            ← OverviewMetrics, LlmUsagePoint, ErrorRatePoint,
    │   │                              LatencyStat, SessionFunnel
    │   ├── rule.ts                 ← PolicyRule, RuleType, EvalType
    │   ├── channel.ts              ← DeliveryChannel, ChannelType, ChannelConfig,
    │   │                              WebhookConfig, SlackConfig, PagerdutyConfig
    │   ├── common.ts               ← Paginated<T>, ApiError, ListParams
    │   └── security.ts             ← RiskBand, SessionRiskScore, SecurityFinding,
    │                                  SecurityOverview, RemediationCard, InjectionSignature  (Zone 6)
    │
    ├── lib/                        ← infra clients
    │   ├── postgres.ts             ← postgres.js pool + queryRow/queryRows/queryValue
    │   ├── clickhouse.ts           ← @clickhouse/client + stream/batch helpers
    │   ├── redis.ts                ← ioredis + pub/sub helpers
    │   ├── kafka.ts                ← kafkajs producer (control events only)
    │   └── cache.ts                ← generic Redis cache wrapper (dp:api: prefix)
    │
    ├── middleware/
    │   ├── auth.ts                 ← JWT (dashboard) + SDK key (control/commands) auth
    │   ├── ratelimit.ts            ← per-tenant Redis sliding window
    │   └── cors.ts
    │
    ├── queries/                    ← pure DB functions, no HTTP concerns
    │   ├── sessions.pg.ts          ← session list, detail, alerts
    │   ├── sessions.ch.ts          ← trace, state-history, token totals, event stats
    │   ├── analytics.ch.ts         ← all aggregate table queries
    │   ├── alerts.pg.ts            ← alert feed, detail, stats, status update
    │   ├── rules.pg.ts             ← rule CRUD + dry-run
    │   ├── channels.pg.ts          ← channel CRUD
    │   └── security.pg.ts          ← overview, session score, findings, remediation stats (Zone 6)
    │
    ├── stitchers/                  ← combines PG + CH results, no HTTP
    │   ├── session-detail.ts       ← Promise.all([pgRow, chTokens, chStats])
    │   └── overview.ts             ← Promise.all([pgCounts, chMetrics])
    │
    └── routes/
        ├── index.ts                ← mounts all groups
        ├── sessions.ts             ← 6 session endpoints + SSE live feed
        ├── analytics.ts            ← 6 analytics endpoints
        ├── alerts.ts               ← 4 alert endpoints
        ├── control.ts              ← kill-switch, interrupt, SDK command poll
        ├── rules.ts                ← GET/POST/PUT rules
        ├── channels.ts             ← GET/POST/PUT channels
        └── security.ts             ← 5 security endpoints (Zone 6)
```

---

## Prerequisites

- Node.js 22 LTS
- pnpm 9+
- `dapplepot_pipeline` cloned and `docker compose up -d` running
  (this service shares the same Postgres + ClickHouse + Redis + Kafka)

---

## Local setup

### 1. Install

```bash
git clone https://github.com/dapplepot/dapplepot_api
cd dapplepot_api
pnpm install
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your actual connection strings
```

Key variables:

| Variable | Example | Notes |
|----------|---------|-------|
| `POSTGRES_URL` | `postgresql://user:pass@host/db` | Aiven/cloud — SSL required |
| `CLICKHOUSE_HOST` | `abc.clickhouse.cloud` | Hostname only, no `https://` |
| `CLICKHOUSE_PORT` | `8443` | Default for ClickHouse Cloud |
| `REDIS_URL` | `redis://localhost:6379` | |
| `DAPPLEPOT_JWT_SECRET` | `changeme` | Min 1 char |

### 3. Run schema migrations

These run once against the shared Postgres instance. The pipeline has already
created the base tables — these add API-managed columns and the `channels` table.

```bash
pnpm migrate
```

Reads `POSTGRES_URL` from `.env`, connects over SSL, and tracks applied files in
a `_migrations` table. Both files are idempotent — safe to re-run.

### 4. Start

```bash
# From dapplepot_pipeline repo, if not already running:
# docker compose up -d

pnpm dev     # hot-reload dev server on port 3000
```

### 5. Verify

```bash
curl http://localhost:3000/health
# → { "status": "ok", "postgres": "ok", "clickhouse": "ok", "redis": "ok" }

curl -H "Authorization: Bearer <jwt>" \
     http://localhost:3000/v1/sessions?limit=5
```

---

## Running tests

```bash
pnpm test:unit          # vitest unit tests, no infra
pnpm test:integration   # requires docker compose up (from dapplepot_pipeline)
pnpm test               # all
pnpm typecheck          # tsc --noEmit
pnpm lint               # eslint
pnpm lint:fix           # eslint --fix
```

---

## API reference

### Authentication

Two auth paths — different endpoints use different tokens:

**Dashboard endpoints (all except `GET /v1/control/commands`):**
`Authorization: Bearer <jwt>` — JWT signed with `DAPPLEPOT_JWT_SECRET`.
JWT payload must contain `tenant_id` and `user_id`.

**SDK polling endpoint (`GET /v1/control/commands` only):**
`Authorization: Bearer <sdk_key>` — the write-only SDK key issued per tenant.
The API verifies via `dp:auth:{key_hash}` Redis cache (same mechanism as the pipeline).

> SDK keys must never be sent to dashboard endpoints, and JWTs must never be
> sent to `GET /v1/control/commands`.

---

### Sessions

#### `GET /v1/sessions`

```
Query params:
  page         number    default 1
  limit        number    default 20, max 100
  status       string    'stub' | 'open' | 'finalised' | 'interrupted' | 'killed' | 'error'
  agentId      string    filter by agent_id
  environment  string    'prod' | 'staging' | 'simulation'
  since        string    ISO 8601 — started_at >=
  until        string    ISO 8601 — started_at <
  q            string    search session_id prefix or user_context_id

Response: Paginated<SessionSummary>   (Postgres only — index scan on tenant_id, started_at)
```

#### `GET /v1/sessions/:id`

Full session detail. Parallel fan-out to Postgres (session row + last alert)
and ClickHouse (token totals from `obs_session_tokens` + event stats from `obs_events`).
Typical latency: 20–50ms.

```
Response: SessionDetail
Caching:  status=open      → no cache
          status=finalised → Cache-Control: public, max-age=300, s-maxage=300
```

#### `GET /v1/sessions/:id/trace`

```
Query params:
  after_seq    number    cursor (sequence_index of last seen event), default 0
  limit        number    default 100, max 200

Response: TracePage   — events in sequence_index ASC order
Caching:  finalised sessions → Cache-Control: public, max-age=300
Note:     Cursor pagination only — OFFSET is not supported (O(n) in ClickHouse)
```

#### `GET /v1/sessions/:id/state-history`

```
Response: StateHistory
  events filtered to: checkpoint_write | interrupt_raised | interrupt_resumed
  Ordered by sequence_index ASC — replay graph state evolution
```

#### `GET /v1/sessions/:id/alerts`

```
Response: AlertSummary[]   — all alerts triggered during this session
```

#### `GET /v1/sessions/live`

SSE stream. Sends `sessions` events every 2 seconds containing open sessions
updated in the last 30 seconds. Used by the dashboard home screen.

```
Event format:
  event: sessions
  data:  SessionSummary[]
```

---

### Analytics

All analytics endpoints accept `window` and optional `agentId`.
All read from pre-aggregated ClickHouse tables — never from raw `obs_events`.

```
Common query params:
  window    string    '1h' | '24h' | '7d' | '30d'   default '24h'
  agentId   string    optional agent filter
```

#### `GET /v1/analytics/overview`

```
Response: OverviewMetrics
  totalSessions, liveSessions, completedSessions, errorSessions, killedSessions  ← Postgres
  totalInputTokens, totalOutputTokens, totalLlmCalls, avgLatencyMs, p95LatencyMs ← obs_llm_hourly
Cache: 30s per tenant+window
```

#### `GET /v1/analytics/llm-usage`

```
Response: LlmUsagePoint[]   — per model per hour, from obs_llm_hourly
Cache: 60s
```

#### `GET /v1/analytics/error-rates`

```
Response: ErrorRatePoint[]  — per node per hour, from obs_error_hourly
Cache: 60s
```

#### `GET /v1/analytics/latency`

```
Response: LatencyStat[]   — avg + p95 latency per model per hour, from obs_llm_hourly
Cache: 60s
Note: p50/p99 are not available — the aggregate table stores avg and p95 only
```

#### `GET /v1/analytics/cost`

```
Response: cost attribution per agent — token counts + estimated USD cost
Cost rates: $3.00/M input, $15.00/M output (Sonnet 4 defaults, configurable)
Source: obs_session_tokens
Cache: 300s
```

#### `GET /v1/analytics/sessions/funnel`

```
Response: SessionFunnel   — Postgres session counts by status
  totalStarted, reachedOpen, reachedTerminal, completed, killed, interrupted,
  errored, completionRate
```

---

### Alerts

#### `GET /v1/alerts`

```
Query params: page, limit, severity, status, ruleId, agentId, since, until
Response: Paginated<AlertSummary>
```

#### `GET /v1/alerts/:id`

```
Response: AlertDetail   — includes delivery attempts from alert_deliveries
```

#### `PUT /v1/alerts/:id/status`

```
Body:     { "status": "acknowledged" | "resolved" | "open" }
Response: { alertId, status, resolvedAt }
```

#### `GET /v1/alerts/stats`

```
Query params: window
Response: AlertStats   — counts by severity + top 10 firing rules
```

---

### Control

#### `POST /v1/control/kill-switch`

Terminates a live session. Does two things in parallel:
1. RPUSH `terminate_session` command to `dp:commands:{agentId}` (SDK reads it on next poll)
2. Produce to Kafka `obs.priority.v1` (pipeline marks session as killed)

```
Body:     { "sessionId": "...", "reason": "..." }
Response: { "ok": true }
Auth:     JWT (dashboard user)
```

#### `POST /v1/control/interrupt`

Signals the pipeline to mark a session as interrupted via Kafka.
Does not push a Redis command — LangGraph interrupts are node-internal.

```
Body:     { "sessionId": "...", "reason": "..." }
Response: { "ok": true }
Auth:     JWT (dashboard user)
Note:     Returns 400 if session is not currently 'open'
```

#### `GET /v1/control/commands`

The `dapplepot_langgraph` SDK polls this endpoint every 5 seconds to check
for pending platform commands. Returns plain JSON — **not SSE**.
Commands are consumed once delivered (LPOP from Redis).

```
Query params: agent_id (required — sent by SDK on every poll)
Response:     { "commands": [...] }   — always 200, empty array when idle
Auth:         SDK key (Bearer <sdk_key>)

Command types:
  { type: "terminate_session", reason?: string }
  { type: "update_tool_blocklist", tool_names: string[] }
  { type: "update_sample_rate", sample_rate: number }
```

---

### Rules

#### `GET /v1/rules`

```
Response: PolicyRule[]
Cache: 60s — invalidated on PUT /v1/rules/:id
```

#### `POST /v1/rules`

Creates a rule and runs a dry-run preview against the last 7 days of data
before saving.

```
Body:     { name, ruleType, evalType, enabled, config, dedupWindowS }
Response: { rule: PolicyRule, preview: { wouldHaveFired: number, sessions: [...] } }
Side effects:
  - INSERT into policy_rules
  - DEL dp:rules:{tenantId}         (pipeline evaluator cache)
  - PUBLISH dp:rule-invalidate       (notifies pipeline workers)
  - DEL dp:api:rules:{tenantId}     (API read cache)
```

#### `PUT /v1/rules/:id`

```
Body:     Partial<PolicyRule>   — name, enabled, config, dedupWindowS
Response: PolicyRule (updated)
Side effects: same three-step cache invalidation as POST
```

---

### Security

Data written by `dapplepot_security` (Zone 6). This service reads and serves
the results — it does not run any detection or scoring itself.

#### `GET /v1/security/overview`

```
Query params:
  windowHours  number   default 168 (7 days)

Response: SecurityOverview
  window, sessionsScored, highCriticalCount, avgRiskScore,
  topSignalId, topSignalCount, bandDistribution, owaspFrequency,
  highRiskSessions (top 5 by risk score)
Cache: 120s per tenant+window
```

#### `GET /v1/security/sessions/:id/score`

```
Response: SessionRiskScore   — riskScore (0–100), riskBand, signalIds, scorerVersion, scoredAt
          404 { error: { code: 'NOT_FOUND' } } if scorer has not yet processed this session
Cache: 300s — scores are immutable once written by the scorer
```

#### `GET /v1/security/sessions/:id/findings`

```
Response: { findings: SecurityFinding[] }
  Each finding: findingId, signalId, sigType, owaspId, severity,
                matchedText (redacted), detail, scoreContrib, detectionPhase
```

#### `GET /v1/security/remediation`

```
Query params:
  windowHours  number   default 168

Response: { remediation: RemediationCard[] }
  Top 10 firing signals with title, description, fixSteps, optional sdkSnippet
Cache: 300s per tenant+window
```

#### `GET /v1/security/signatures`

```
Response: { signatures: InjectionSignature[] }
  Active injection signatures for this tenant (tenant-specific + platform-wide)
```

---

### Channels

#### `GET /v1/channels`

```
Response: DeliveryChannel[]
```

#### `POST /v1/channels`

```
Body:     { name, channelType, enabled, config }
  config for webhook:    { url, secret?, headers? }
  config for slack:      { webhookUrl, channel? }
  config for pagerduty:  { integrationKey, severity? }
Response: DeliveryChannel (with channelId)
```

#### `PUT /v1/channels/:id`

```
Body:     Partial<DeliveryChannel>
Response: DeliveryChannel (updated)
```

---

## Caching

All API cache keys are prefixed `dp:api:`. Both this service and `dapplepot_pipeline`
share Redis DB 0 — key collision is prevented by namespace prefix only.

| Endpoint | TTL | Notes |
|----------|-----|-------|
| `GET /v1/analytics/overview` | 30s | Short — dashboard auto-refreshes |
| `GET /v1/analytics/llm-usage` | 60s | Hourly aggregates |
| `GET /v1/analytics/error-rates` | 60s | Same |
| `GET /v1/analytics/latency` | 60s | Same |
| `GET /v1/analytics/cost` | 300s | Slow-changing |
| `GET /v1/sessions/:id` (open) | no cache | Status changes live |
| `GET /v1/sessions/:id` (finalised) | CDN 300s | Immutable once finalised |
| `GET /v1/sessions/:id/trace` (finalised) | CDN 300s | Immutable |
| `GET /v1/rules` | 60s | Invalidated on PUT /v1/rules/:id |
| `GET /v1/alerts` | no cache | Always live |
| `GET /v1/security/overview` | 120s | Per tenant+window |
| `GET /v1/security/sessions/:id/score` | 300s | Immutable once scored |
| `GET /v1/security/remediation` | 300s | Per tenant+window |
| `GET /v1/security/signatures` | no cache | Always live |

---

## Schema migrations

Two migrations must be run once before starting this service. Both are idempotent.

| File | What it does |
|------|-------------|
| `migrations/001_api_alerts_columns.sql` | Adds `status`, `resolved_at` to pipeline's `alerts` table |
| `migrations/002_channels_table.sql` | Creates the `channels` config table (API-owned) |

---

## Shared types with `dapplepot_ui`

Types in `src/types/` are the source of truth for the API contract.
To share with `dapplepot_ui` without an npm publish step, use a path alias:

```typescript
// dapplepot_ui/tsconfig.json
"paths": { "@dapplepot/types/*": ["../dapplepot_api/src/types/*"] }
```

The UI then imports directly:
```typescript
import type { SessionDetail, TracePage, OverviewMetrics } from '@dapplepot/types/session'
import type { SecurityOverview, SessionRiskScore, RemediationCard } from '@dapplepot/types/security'
```

Or via the barrel:
```typescript
import type { SessionDetail, SecurityOverview } from '@dapplepot/types'
```

---

## Databases this service reads

### Postgres tables

| Table | Access |
|-------|--------|
| `tenants` | Auth middleware (tenant validation) |
| `sdk_keys` | SDK key auth for `GET /v1/control/commands` |
| `agents` | Session list (agent name lookup) |
| `sessions` | All session endpoints, live SSE feed |
| `policy_rules` | Rules endpoints |
| `alerts` | Alerts endpoints (also writes `status`, `resolved_at`) |
| `alert_deliveries` | Alert detail (delivery attempt history) |
| `channels` | Channels endpoints (API-owned table) |
| `session_risk_scores` | Security score endpoints (written by `dapplepot_security`) |
| `security_findings` | Findings + remediation endpoints (written by `dapplepot_security`) |
| `injection_signatures` | Signatures endpoint (platform + tenant-specific rules) |

### ClickHouse tables

| Table | Engine | Read by |
|-------|--------|---------|
| `obs_events` | ReplacingMergeTree | Trace, state-history, event stats — always query with `FINAL` |
| `obs_llm_hourly` | AggregatingMergeTree | LLM usage, latency, overview — `avgMerge` / `quantileMerge` |
| `obs_error_hourly` | SummingMergeTree | Error rates |
| `obs_session_tokens` | SummingMergeTree | Token totals per session, cost attribution |

All aggregate table queries use `FINAL` to force dedup of unmerged parts.
Analytics endpoints read from aggregate tables only — `obs_events` is for
trace and state-history views only.

---

## Scripts reference

```bash
pnpm dev                # start with hot reload (tsx watch)
pnpm start              # production (node dist/index.js)
pnpm build              # tsc -p tsconfig.build.json → dist/
pnpm test               # vitest run (all)
pnpm test:unit          # vitest run tests/unit/
pnpm test:integration   # vitest run tests/integration/ (requires docker compose)
pnpm typecheck          # tsc --noEmit
pnpm lint               # eslint src/ tests/
pnpm lint:fix           # eslint --fix
pnpm migrate            # run SQL migrations from migrations/ against POSTGRES_URL in .env
```

---

## For IDE agents

Read `agent.md` in full before writing any code. It contains:
- All 22 endpoint definitions with exact query parameter specs
- Full SQL for every query (stitch, analytics, trace cursor, sessions list, rules, channels)
- All TypeScript response types with field-level comments
- The stitcher pattern for parallel PG + CH fan-out
- SSE implementation for the live session feed
- SDK command poll implementation (`GET /v1/control/commands`)
- Kill-switch and interrupt control flows
- 6-phase build order across all source files
- 12 locked architecture decisions with reasons
- ClickHouse aggregate table schemas (confirmed column lists)
- Schema migration SQL (alerts columns + channels table)
