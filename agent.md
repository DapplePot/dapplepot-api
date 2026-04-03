# AGENT.md — dapplepot_api: Full Context for IDE Agent

> Read this file completely before writing any code.
> It contains the full design, every query pattern, every response schema,
> the exact repo structure, and the build order. Nothing here is aspirational —
> it is the agreed spec. Do not invent alternatives unless explicitly asked.

---

## 1. Company + product context

**Company:** Dapplepot
**Product:** A production-grade observability and security platform for
LangGraph-based AI agents.

This repository (`dapplepot_api`) is **Zone 4 — Platform API**. It is the
**read-side** service. It reads from the Postgres and ClickHouse databases
that `dapplepot_pipeline` writes to, and serves them to `dapplepot_ui`
(the React dashboard) and to customer integrations.

### All Dapplepot repositories

| Zone | Repo | Language | What it is |
|------|------|----------|-----------|
| 1 | `dapplepot_sim` | Python | LangGraph simulation agent |
| 2 | `dapplepot_langgraph` | Python | SDK — `DapplePot.instrument(graph)` |
| 3 | `dapplepot_pipeline` | Python | Event ingestion + data pipeline (write path) |
| **4** | **`dapplepot_api`** | **TypeScript** | **This repo — platform API (read path)** |
| 5 | `dapplepot_ui` | TypeScript / React | Dashboard UI |
| 6 | `dapplepot_security` | Python | OWASP detection + risk scoring |

### Language: TypeScript + Hono

- Runtime: **Node.js 22** (LTS)
- Framework: **Hono** — lightweight, fast, native SSE, edge-deployable
- Package manager: **pnpm**
- TypeScript: strict mode, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`

Why TypeScript over Python for this service:
1. Shared type system with `dapplepot_ui` — API response types exported
   as `@dapplepot/types` package; UI imports them directly, never out of sync.
2. Hono has native SSE support — the live session feed and control channel
   SSE endpoints are first-class, not bolted on.
3. `Promise.all` for parallel Postgres + ClickHouse fan-out is idiomatic
   and readable in TypeScript.
4. `@clickhouse/client` streams ClickHouse results natively — perfect for
   the trace pagination endpoint.

### Boundary between this repo and `dapplepot_pipeline`

`dapplepot_api` = **read path + control plane.**
- Reads from Postgres and ClickHouse.
- Writes to `alerts.status` / `alerts.resolved_at` — operational, not telemetry.
- Produces to Kafka `obs.priority.v1` for kill-switch and interrupt — the only Kafka write in this repo.
- Serves `GET /v1/control/commands` — the SDK polls this for pending commands.

**Ingest endpoints (`POST /v1/ingest/events`, `POST /v1/ingest/single`) belong to
`dapplepot_pipeline` (Zone 3), not this repo.** `sdk_contract.md` is included here
for reference only. Do not implement ingest endpoints in `dapplepot_api`.

**No HTTP calls between `dapplepot_api` and `dapplepot_pipeline`.**
Shared databases and Redis are the only integration points.

---

## 2. Repo structure

```
dapplepot_api/
│
│   # Project root
├── AGENT.md                            ← this file
├── README.md                           ← human setup guide
├── package.json                        ← pnpm deps, scripts
├── pnpm-lock.yaml
├── tsconfig.json                       ← strict TypeScript config; no rootDir (includes src, tests, scripts)
├── tsconfig.build.json                 ← rootDir=src, excludes tests + scripts, for dist/
├── .env.example                        ← copy to .env
├── .eslintrc.json
├── vitest.config.ts
│
│   # Migration runner
├── scripts/
│   ├── migrate.ts                      ← Node.js migration runner (uses dotenv + postgres.js, no psql needed)
│   └── seed_admin.ts                   ← seeds default admin user (admin@dapplepot.dev / changeme123) for dev
│
│   # Application entry
├── src/
│   ├── index.ts                        ← server entry only: serve() + SIGTERM handler
│   ├── app.ts                          ← Hono app factory, middleware wiring, error handlers (import in tests)
│   ├── env.ts                          ← zod-validated env vars; loads dotenv/config at module init
│   │
│   │   # Shared types — exported as @dapplepot/types for dapplepot_ui to import
│   ├── types/
│   │   ├── session.ts                  ← Session, SessionDetail, SessionSummary, TracePage
│   │   ├── alert.ts                    ← Alert, AlertDetail, AlertStatus
│   │   ├── analytics.ts                ← OverviewMetrics, LlmUsagePoint, ErrorRatePoint, LatencyStat
│   │   ├── rule.ts                     ← PolicyRule, RuleType, RuleCondition, AlertConfig
│   │   ├── channel.ts                  ← DeliveryChannel, ChannelType, ChannelConfig
│   │   ├── common.ts                   ← Paginated<T>, ApiError, DateRange, SortOrder
│   │   ├── security.ts                 ← RiskBand, SessionRiskScore, SecurityFinding,
│   │   │                                  SecurityOverview, RemediationCard, InjectionSignature  (Zone 6)
│   │   └── auth.ts                     ← LoginRequest/Response, UserSummary, InviteSummary,
│   │                                      ForgotPasswordRequest, ResetPasswordRequest, etc.
│   │
│   │   # Infrastructure clients — one module per store
│   ├── lib/
│   │   ├── postgres.ts                 ← postgres.js pool, typed query helpers
│   │   ├── clickhouse.ts               ← @clickhouse/client, stream + batch helpers
│   │   ├── redis.ts                    ← ioredis, cache helpers, pub/sub subscribe
│   │   ├── kafka.ts                    ← kafkajs producer (control events only)
│   │   ├── cache.ts                    ← generic Redis cache wrapper: get/set/invalidate
│   │   ├── auth-tokens.ts              ← generateAccessToken, generateRefreshToken, hashToken, verifyAccessToken
│   │   └── email/
│   │       ├── index.ts                ← EmailProvider interface + createEmailProvider() factory
│   │       ├── console.ts              ← ConsoleEmailProvider — logs full email to stdout (default dev)
│   │       ├── smtp.ts                 ← SmtpEmailProvider via nodemailer
│   │       ├── resend.ts               ← ResendEmailProvider via resend SDK
│   │       └── templates.ts            ← inviteEmail() and resetEmail() — HTML + plain text
│   │
│   │   # Auth + middleware
│   ├── middleware/
│   │   ├── auth.ts                     ← JWT (now with role + type:'access' check) and SDK key auth
│   │   ├── authorize.ts                ← requireRole('admin'|'editor'|'viewer') — rank-based check
│   │   ├── ratelimit.ts                ← per-tenant sliding window via Redis
│   │   └── cors.ts                     ← CORS config for dapplepot_ui origin
│   │
│   │   # Route handlers — one file per resource group
│   ├── routes/
│   │   ├── index.ts                    ← mounts all route groups onto Hono app
│   │   ├── auth.ts                     ← POST /v1/auth/login|refresh|logout|forgot-password|reset-password|accept-invite
│   │   ├── users.ts                    ← GET/POST /v1/users, /me, /invites, /:id/role, /:id/status
│   │   ├── sessions.ts                 ← GET /v1/sessions, /v1/sessions/:id, /trace, /state-history, /alerts, /live (SSE)
│   │   ├── analytics.ts                ← GET /v1/analytics/overview, /llm-usage, /error-rates, /latency, /cost, /sessions/funnel
│   │   ├── alerts.ts                   ← GET /v1/alerts, /:id  |  PUT /v1/alerts/:id/status
│   │   ├── control.ts                  ← POST /v1/control/kill-switch, /interrupt  |  GET /v1/control/commands
│   │   ├── rules.ts                    ← GET/POST /v1/rules  |  PUT /v1/rules/:id
│   │   ├── channels.ts                 ← GET/POST /v1/channels  |  PUT /v1/channels/:id
│   │   └── security.ts                 ← GET /v1/security/overview, /sessions/:id/score,
│   │                                      /sessions/:id/findings, /remediation, /signatures (Zone 6)
│   │
│   │   # Query layer — pure async functions, no HTTP concerns
│   ├── queries/
│   │   ├── sessions.pg.ts              ← Postgres queries for session list, detail, alerts
│   │   ├── sessions.ch.ts              ← ClickHouse queries for trace, state-history, token totals, event stats
│   │   ├── analytics.ch.ts             ← All analytics queries (read from aggregate tables)
│   │   ├── alerts.pg.ts                ← Postgres alert feed + detail queries
│   │   ├── rules.pg.ts                 ← policy_rules CRUD queries
│   │   ├── channels.pg.ts              ← delivery channel CRUD queries
│   │   ├── security.pg.ts              ← overview, session score, findings, remediation stats (Zone 6)
│   │   ├── users.pg.ts                 ← findByEmail, findById, create, listUsers, updateRole, updateStatus, updateProfile
│   │   ├── invites.pg.ts               ← createInvite, listInvites, findPendingByToken/Email, acceptInvite, revokeInvite
│   │   ├── refresh-tokens.pg.ts        ← createRefreshToken, findActiveRefreshToken, revokeRefreshToken, revokeAllForUser
│   │   └── password-resets.pg.ts       ← createPasswordReset, findValidPasswordReset, markPasswordResetUsed
│   │
│   │   # Stitch layer — combines PG + CH results into final response shape
│   └── stitchers/
│       ├── session-detail.ts           ← Promise.all([pgRow, chTokens, chStats]) → SessionDetail
│       └── overview.ts                 ← Promise.all([pgCounts, chMetrics]) → OverviewMetrics
│
│   # Tests
└── tests/
    ├── setup.ts                        ← vitest globalSetup: env var defaults for test runs
    ├── unit/                           ← pure logic, no infra
    │   ├── session-stitch.test.ts
    │   ├── analytics-transform.test.ts
    │   ├── rule-validation.test.ts
    │   ├── auth-tokens.test.ts         ← generateAccessToken, verifyAccessToken, generateRefreshToken, hashToken
    │   └── authorize.test.ts           ← requireRole() rank-based access control
    └── integration/                    ← hits real infra via .env; uses app.ts directly (no server start)
        ├── setup.ts
        ├── health.test.ts
        ├── auth.test.ts                ← JWT middleware + full login→refresh→logout→reset→invite flows
        ├── users.test.ts               ← user list, me, invite, role/status change, RBAC enforcement
        ├── sessions.test.ts
        ├── alerts.test.ts
        ├── analytics.test.ts
        ├── rules.test.ts
        └── not-found.test.ts
```

---

## 3. All endpoints

### Resource group: Auth (6 endpoints — public, no JWT required)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/auth/login` | Verify email+password, issue access + refresh tokens |
| POST | `/v1/auth/refresh` | Rotate refresh token, issue new access token |
| POST | `/v1/auth/logout` | Revoke refresh token |
| POST | `/v1/auth/forgot-password` | Send password reset email (always 200) |
| POST | `/v1/auth/reset-password` | Consume reset token, update password, revoke all sessions |
| POST | `/v1/auth/accept-invite` | Accept invite token, create user, auto-login |

### Resource group: Users (8 endpoints — JWT required)

| Method | Path | Role | Purpose |
|--------|------|------|---------|
| GET | `/v1/users` | admin | Paginated user list with status filter |
| GET | `/v1/users/me` | any | Own profile (no passwordHash) |
| PUT | `/v1/users/me` | any | Update name or change password |
| POST | `/v1/users/invite` | admin | Create invite, send email |
| GET | `/v1/users/invites` | admin | List all invites |
| DELETE | `/v1/users/invites/:id` | admin | Revoke pending invite |
| PUT | `/v1/users/:id/role` | admin | Change role (cannot change own) |
| PUT | `/v1/users/:id/status` | admin | Enable/disable user; disable revokes all sessions |

### Resource group: Sessions (6 endpoints)

| Method | Path | Stores | Purpose |
|--------|------|--------|---------|
| GET | `/v1/sessions` | PG | Paginated session list with filters |
| GET | `/v1/sessions/:id` | PG + CH | Full session detail — the main stitch query |
| GET | `/v1/sessions/:id/trace` | CH | Paginated event timeline (cursor-based) |
| GET | `/v1/sessions/:id/state-history` | CH | Ordered state_snapshot + state_delta events |
| GET | `/v1/sessions/:id/alerts` | PG | All alerts triggered during this session |
| GET | `/v1/sessions/live` | PG | SSE stream of open sessions (2s poll) |

### Resource group: Analytics (6 endpoints)

| Method | Path | Store | Purpose |
|--------|------|-------|---------|
| GET | `/v1/analytics/overview` | PG + CH | Dashboard summary: sessions, tokens, error rate, latency |
| GET | `/v1/analytics/llm-usage` | CH | Token usage over time by model (`obs_llm_hourly`) |
| GET | `/v1/analytics/error-rates` | CH | Error rate per node per agent (`obs_error_hourly`) |
| GET | `/v1/analytics/latency` | CH | p50/p95/p99 latency over time |
| GET | `/v1/analytics/cost` | CH | Token cost attribution by agent |
| GET | `/v1/analytics/sessions/funnel` | PG + CH | Session completion funnel |

### Resource group: Alerts (4 endpoints)

| Method | Path | Store | Purpose |
|--------|------|-------|---------|
| GET | `/v1/alerts` | PG | Paginated alert feed with filters |
| GET | `/v1/alerts/:id` | PG | Alert detail |
| PUT | `/v1/alerts/:id/status` | PG | Acknowledge or resolve alert |
| GET | `/v1/alerts/stats` | PG | Alert counts by severity + rule |

### Resource group: Control (3 endpoints)

**Note:** `GET /v1/control/commands` is SDK-facing (Bearer = SDK key). The two POST endpoints are dashboard-facing (Bearer = JWT).

| Method | Path | Action | Purpose |
|--------|------|--------|---------|
| POST | `/v1/control/kill-switch` | Redis + Kafka | Queue `terminate_session` command + produce to `obs.priority.v1` |
| POST | `/v1/control/interrupt` | Redis + Kafka | Queue `interrupt` command + produce to `obs.priority.v1` |
| GET | `/v1/control/commands` | Redis list | SDK polls every 5s — returns pending commands as JSON, consumed once |

### Resource group: Config — Rules (2 endpoints)

| Method | Path | Store | Purpose |
|--------|------|-------|---------|
| GET | `/v1/rules` | PG | List all policy rules for tenant |
| POST | `/v1/rules` | PG | Create rule with dry-run preview |
| PUT | `/v1/rules/:id` | PG + Redis | Update rule + invalidate `dp:rules:{tenant_id}` cache |

### Resource group: Config — Channels (2 endpoints)

| Method | Path | Store | Purpose |
|--------|------|-------|---------|
| GET | `/v1/channels` | PG | List delivery channels for tenant |
| POST | `/v1/channels` | PG | Create channel config |
| PUT | `/v1/channels/:id` | PG | Update channel config (enable/disable, edit) |

### Resource group: Security (5 endpoints — Zone 6, read-only)

Data written by `dapplepot_security`. This service reads and serves the results — it does not run detection or scoring itself.

**Note:** `GET /v1/control/commands` auth path (SDK key) is unaffected. All security endpoints use standard JWT auth.

| Method | Path | Store | Purpose |
|--------|------|-------|---------|
| GET | `/v1/security/overview` | PG | Tenant risk summary: band distribution, OWASP freq, top sessions |
| GET | `/v1/security/sessions/:id/score` | PG | Per-session risk score + signal IDs |
| GET | `/v1/security/sessions/:id/findings` | PG | Security findings for a session |
| GET | `/v1/security/remediation` | PG | Top firing signals + remediation guidance |
| GET | `/v1/security/signatures` | PG | Active injection signatures for tenant |

---

## 4. Auth + tenant resolution

### Three auth paths

**Public (`/v1/auth/*`):** No token. These endpoints issue and revoke tokens.

**Dashboard JWT path (all other `/v1/*` except `/v1/control/commands`):**
`Authorization: Bearer <access_token>` — JWT signed with `DAPPLEPOT_JWT_SECRET`.

```typescript
// JWT payload shape (access token):
{
  sub: userId,
  tenant_id: tenantId,   // ← kept for backward compat
  user_id: userId,
  role: 'admin' | 'editor' | 'viewer',
  type: 'access',
  iat, exp
}

// middleware/auth.ts sets:
c.set('tenantId', payload.tenant_id)
c.set('userId', payload.user_id)
c.set('role', payload.role ?? 'viewer')  // default 'viewer' for legacy tokens

// Middleware REJECTS tokens where payload.type is defined but !== 'access'
// (prevents refresh tokens being used as access tokens)
```

**SDK key path (`GET /v1/control/commands` only):**
`Authorization: Bearer <sdk_key>` — write-only key issued per tenant.
Verify via `dp:auth:{key_hash}` Redis cache → `sdk_keys` table on miss. 401 / 403.

### Role-based authorization

`src/middleware/authorize.ts` — `requireRole(minimumRole)`:

```typescript
const ROLE_RANK = { admin: 3, editor: 2, viewer: 1 }
// unknown role → rank 0 → always blocked
// Must run AFTER jwtAuth (which sets 'role' on context)
```

Role permission matrix:

| Action | admin | editor | viewer |
|--------|-------|--------|--------|
| All read endpoints | yes | yes | yes |
| `PUT /v1/alerts/:id/status` | yes | yes | no |
| `POST /v1/control/kill-switch \| interrupt` | yes | yes | no |
| `POST/PUT /v1/rules` | yes | yes | no |
| `POST/PUT /v1/channels` | yes | no | no |
| `GET /v1/users` | yes | no | no |
| `POST /v1/users/invite`, `PUT /:id/role`, `PUT /:id/status` | yes | no | no |
| `GET/PUT /v1/users/me` | yes | yes | yes |

### Token design

- **Access token:** JWT, 15 min expiry, type: `'access'`
- **Refresh token:** 64-byte random hex (opaque), SHA-256 hash stored in `refresh_tokens` table, 7 days, rotated on every use
- **Reset token:** 32-byte random hex, SHA-256 hash in `password_resets`, 1 hour, single-use
- **Invite token:** 32-byte random hex, SHA-256 hash in `invites`, 7 days, single-use

### Rate limiting for auth routes (keys in `src/routes/auth.ts`)

```
dp:rl:auth:login:{email}    → 10 per 15 min
dp:rl:auth:reset:{email}    → 5 per hour
dp:rl:auth:refresh:{ip}     → 20 per minute
```

### Every query function takes tenantId as first parameter

```typescript
async function getSessionDetail(tenantId: string, sessionId: string): Promise<SessionDetail>
```

All downstream queries MUST filter by `tenantId` — never expose cross-tenant data.

---

## 5. The stitch pattern — parallel PG + ClickHouse queries

The most important query pattern. `GET /v1/sessions/:id` is the primary example.
Implement in `src/stitchers/session-detail.ts`.

```typescript
// stitchers/session-detail.ts
import { getSessionPg } from '../queries/sessions.pg.js'
import { getSessionTokens, getSessionEventStats } from '../queries/sessions.ch.js'

export async function stitchSessionDetail(
  tenantId: string,
  sessionId: string
): Promise<SessionDetail> {

  // Three concurrent reads — never sequential
  const [pgRow, chTokens, chStats] = await Promise.all([
    // Postgres: session row + latest alert (LATERAL join, one round-trip)
    getSessionPg(tenantId, sessionId),

    // ClickHouse: token totals from obs_session_tokens (point lookup, ~2-5ms)
    // Use FINAL to force dedup of unmerged SummingMergeTree parts
    getSessionTokens(tenantId, sessionId),

    // ClickHouse: event counts from obs_events (bloom filter on session_id, ~10-25ms)
    getSessionEventStats(tenantId, sessionId),
  ])

  if (!pgRow) throw new NotFoundError(`Session ${sessionId} not found`)

  return {
    // From Postgres
    sessionId:    pgRow.session_id,
    status:       pgRow.status,
    agentId:      pgRow.agent_id,
    agentVersion: pgRow.agent_version,
    environment:  pgRow.environment,
    startedAt:    pgRow.started_at,
    endedAt:      pgRow.ended_at,
    durationMs:   pgRow.duration_ms,
    exitReason:   pgRow.exit_reason,
    graphState:   pgRow.graph_state,
    initialInput: pgRow.initial_input,
    finalOutput:  pgRow.final_output,
    lastAlert:    pgRow.last_alert_id ? {
      alertId:     pgRow.last_alert_id,
      severity:    pgRow.last_alert_severity,
      title:       pgRow.last_alert_title,
      triggeredAt: pgRow.last_alert_at,
    } : null,

    // From ClickHouse obs_session_tokens
    tokenUsage: {
      totalInputTokens:  chTokens?.total_input_tok  ?? 0,
      totalOutputTokens: chTokens?.total_output_tok ?? 0,
      llmCallCount:      chTokens?.llm_call_count   ?? 0,
    },

    // From ClickHouse obs_events scan
    executionSummary: {
      nodeCount:     chStats.node_count,
      errorCount:    chStats.error_count,
      toolCallCount: chStats.tool_calls,
      nodesVisited:  chStats.nodes_visited,
      firstEventAt:  chStats.first_event_at,
      lastEventAt:   chStats.last_event_at,
    },
  }
}
```

### Postgres query for session detail (implement in `queries/sessions.pg.ts`)

```sql
SELECT
  s.*,
  a.alert_id        AS last_alert_id,
  a.triggered_at    AS last_alert_at,
  a.severity        AS last_alert_severity,
  a.title           AS last_alert_title
FROM sessions s
LEFT JOIN LATERAL (
  SELECT alert_id, triggered_at, severity, title
  FROM   alerts
  WHERE  session_id = s.session_id
  ORDER  BY triggered_at DESC
  LIMIT  1
) a ON true
WHERE s.session_id = $1
  AND s.tenant_id  = $2
```

### ClickHouse query for session token totals (queries/sessions.ch.ts)

```sql
SELECT
  sum(total_input_tok)  AS total_input_tok,
  sum(total_output_tok) AS total_output_tok,
  sum(llm_call_count)   AS llm_call_count
FROM obs_session_tokens
FINAL
WHERE tenant_id  = {tenantId: String}
  AND session_id = {sessionId: UUID}
```

`FINAL` forces immediate dedup of SummingMergeTree parts that haven't merged yet.

### ClickHouse query for event stats (queries/sessions.ch.ts)

```sql
SELECT
  countIf(event_type = 'node_start')           AS node_count,
  countIf(event_type LIKE '%_error')           AS error_count,
  countIf(event_type = 'tool_end')             AS tool_calls,
  min(emitted_at)                              AS first_event_at,
  max(emitted_at)                              AS last_event_at,
  groupArray(DISTINCT node_name)               AS nodes_visited
FROM obs_events
WHERE tenant_id  = {tenantId: String}
  AND session_id = {sessionId: UUID}
```

The bloom filter skip index on `session_id` makes this fast (~10-25ms).

---

## 6. Trace endpoint — cursor pagination

`GET /v1/sessions/:id/trace?after_seq=0&limit=100`

Implement in `routes/sessions.ts`. Query in `queries/sessions.ch.ts`.

```typescript
// Cursor pagination on sequence_index — never use OFFSET
// OFFSET N in ClickHouse scans and discards N rows — cost grows with depth.
// sequence_index > $cursor uses the ORDER BY key directly — always O(1).

const query = `
  SELECT
    event_id, event_type, event_category, emitted_at,
    sequence_index, node_run_id, llm_run_id, tool_run_id,
    node_name, node_status, llm_model,
    llm_input_tokens, llm_output_tokens, llm_latency_ms,
    tool_name, tool_status, error_code,
    payload
  FROM obs_events
  WHERE tenant_id     = {tenantId: String}
    AND session_id    = {sessionId: UUID}
    AND sequence_index > {afterSeq: UInt32}
  ORDER BY sequence_index ASC
  LIMIT {limit: UInt32}
`
// Fetch limit + 1 rows to detect whether next page exists.
// If rows.length > limit: hasNext = true, slice to limit.
// nextCursor = last row's sequence_index.
```

### CDN caching for finalised sessions

Once `status = 'finalised'`, the trace is immutable. Set response headers:
```typescript
if (session.status === 'finalised') {
  c.header('Cache-Control', 'public, max-age=300, s-maxage=300')
  c.header('Vary', 'Authorization')
}
```

---

## 7. Analytics queries

All analytics queries read from **pre-aggregated ClickHouse tables**, never
from `obs_events` directly. This keeps analytics fast regardless of event volume.

### Overview metrics (stitcher: `src/stitchers/overview.ts`)

```typescript
// Two concurrent reads
const [pgCounts, chMetrics] = await Promise.all([
  // Postgres: session counts (fast index scan on tenant_id, started_at)
  db.queryRow(`
    SELECT
      count(*)                                      AS total_sessions,
      countIf(status = 'open')                      AS live_sessions,
      countIf(status = 'finalised')                 AS completed_sessions,
      countIf(status IN ('killed','interrupted'))   AS terminated_sessions
    FROM sessions
    WHERE tenant_id  = $1
      AND started_at >= now() - $2::interval
  `, [tenantId, windowInterval]),

  // ClickHouse: aggregate from obs_llm_hourly (pre-computed, very fast)
  clickhouse.query(`
    SELECT
      sum(llm_call_count)                    AS total_llm_calls,
      sum(total_input_tok + total_output_tok) AS total_tokens,
      avgMerge(avg_latency_state)            AS avg_latency_ms,
      quantileMerge(0.95)(p95_latency_state) AS p95_latency_ms
    FROM obs_llm_hourly
    FINAL
    WHERE tenant_id = {tenantId: String}
      AND hour >= toStartOfHour(now() - INTERVAL {hours: UInt32} HOUR)
  `, { tenantId, hours: windowHours })
])
```

### LLM usage over time (`/v1/analytics/llm-usage`)

```sql
SELECT
  llm_model,
  toStartOfHour(hour)                    AS hour,
  sum(llm_call_count)                    AS llm_call_count,
  sum(total_input_tok)                   AS total_input_tok,
  sum(total_output_tok)                  AS total_output_tok,
  avgMerge(avg_latency_state)            AS avg_latency_ms,
  quantileMerge(0.95)(p95_latency_state) AS p95_latency_ms
FROM obs_llm_hourly
FINAL
WHERE tenant_id = {tenantId: String}
  AND hour >= toStartOfHour(now() - INTERVAL {hours: UInt32} HOUR)
  AND ({agentId: String} = '' OR agent_id = {agentId: String})
GROUP BY llm_model, hour
ORDER BY hour ASC
```

### Error rates (`/v1/analytics/error-rates`)

```sql
SELECT
  agent_id,
  node_name,
  toStartOfHour(hour)    AS hour,
  sum(error_count)       AS error_count,
  sum(total_count)       AS total_count,
  sum(error_count) / sum(total_count) AS error_rate
FROM obs_error_hourly
WHERE tenant_id = {tenantId: String}
  AND hour >= toStartOfHour(now() - INTERVAL {hours: UInt32} HOUR)
GROUP BY agent_id, node_name, hour
ORDER BY error_rate DESC
```

### Cost attribution (`/v1/analytics/cost`)

`obs_session_tokens` has no `agent_id` or `day` column — returns a single aggregate row.

```sql
SELECT
  sum(input_tokens)  AS input_tokens,
  sum(output_tokens) AS output_tokens,
  sum(total_tokens)  AS total_tokens
FROM obs_session_tokens
FINAL
WHERE tenant_id = {tenantId: String}
  AND toDate(created_at) >= today() - {days: UInt32}
```

Cost estimate computed in the route handler (not in SQL):
```typescript
// Per-model rates configurable via env or tenant settings
const COST_PER_M_INPUT  = 3.00   // USD per 1M input tokens (Sonnet 4)
const COST_PER_M_OUTPUT = 15.00  // USD per 1M output tokens

const estimatedCost = (row.input_tokens / 1_000_000 * COST_PER_M_INPUT)
                    + (row.output_tokens / 1_000_000 * COST_PER_M_OUTPUT)
```

---

## 8. Caching strategy

Implement in `src/lib/cache.ts`. All cache keys prefixed `dp:api:`.

```typescript
// Generic cache wrapper
async function cached<T>(
  key: string,
  ttlSeconds: number,
  fetch: () => Promise<T>
): Promise<T> {
  const hit = await redis.get(key)
  if (hit) return JSON.parse(hit) as T
  const value = await fetch()
  await redis.setex(key, ttlSeconds, JSON.stringify(value))
  return value
}
```

### Cache TTLs per endpoint

| Endpoint | Cache key | TTL | Notes |
|----------|-----------|-----|-------|
| `/v1/analytics/overview` | `dp:api:overview:{tenant}:{window}` | 30s | Short — dashboard auto-refreshes |
| `/v1/analytics/llm-usage` | `dp:api:llm:{tenant}:{window}:{agent}` | 60s | Hourly aggregates don't change fast |
| `/v1/analytics/error-rates` | `dp:api:err:{tenant}:{window}:{agent}` | 60s | Same |
| `/v1/analytics/latency` | `dp:api:lat:{tenant}:{window}` | 60s | Same |
| `/v1/analytics/cost` | `dp:api:cost:{tenant}:{window}` | 300s | Cost data refreshes slowly |
| `/v1/sessions/:id` (open) | no cache | — | Mutable — status changes |
| `/v1/sessions/:id` (finalised) | CDN Cache-Control header | 300s | Immutable once finalised |
| `/v1/sessions/:id/trace` (finalised) | CDN Cache-Control header | 300s | Immutable |
| `/v1/alerts` | no cache | — | Always live |
| `/v1/rules` | `dp:api:rules:{tenant}` | 60s | Invalidate on PUT /v1/rules/:id |
| `/v1/security/overview` | `dp:api:security:overview:{tenant}:{window}` | 120s (`CACHE_TTL_SECURITY_OVERVIEW`) | Matches UI staleTime: 2min |
| `/v1/security/sessions/:id/score` | `dp:api:security:score:{tenant}:{session}` | 300s (`CACHE_TTL_SESSION_SCORE`) | Scores are immutable once written by scorer |
| `/v1/security/remediation` | `dp:api:security:remediation:{tenant}:{window}` | 300s (`CACHE_TTL_REMEDIATION`) | Slow-changing aggregate |
| `/v1/security/signatures` | no cache | — | Always live — signatures update frequently |

### Rule cache invalidation on update

When `PUT /v1/rules/:id` is called:
```typescript
// 1. Update the rule in Postgres
// 2. Bump the rule's version column
// 3. Invalidate the pipeline's Redis rule cache
await redis.del(`dp:rules:${tenantId}`)
await redis.publish('dp:rule-invalidate', tenantId)
// 4. Invalidate the API's own rules cache
await redis.del(`dp:api:rules:${tenantId}`)
```

The `PUBLISH` to `dp:rule-invalidate` notifies all `dapplepot_pipeline`
policy-evaluator workers to clear their in-process rule cache immediately,
rather than waiting for the 60s TTL to expire.

---

## 9. SSE endpoints

Two SSE endpoints — both implemented in Hono using its native streaming response.

### `/v1/sessions/live` — live session feed (dashboard home screen)

```typescript
// routes/sessions.ts
app.get('/v1/sessions/live', async (c) => {
  const tenantId = c.get('tenantId')
  return streamSSE(c, async (stream) => {
    while (true) {
      // Poll Postgres for sessions updated in last 30 seconds
      const sessions = await db.query(`
        SELECT session_id, agent_id, status, started_at, last_active_at
        FROM   sessions
        WHERE  tenant_id      = $1
          AND  status         = 'open'
          AND  last_active_at >= now() - interval '30 seconds'
        ORDER  BY last_active_at DESC
        LIMIT  50
      `, [tenantId])

      await stream.writeSSE({ event: 'sessions', data: JSON.stringify(sessions) })
      await stream.sleep(2000)   // poll every 2 seconds
    }
  })
})
```

### `GET /v1/control/commands` — SDK command poll

The SDK polls this endpoint every 5 seconds using its SDK key (not a JWT).
It expects plain JSON back — **not SSE**. Commands are consumed once delivered.

```typescript
// routes/control.ts
app.get('/v1/control/commands', async (c) => {
  // Auth: SDK key → tenant_id (see auth.ts SDK key path)
  const tenantId = c.get('tenantId')
  const agentId  = c.req.query('agent_id')   // SDK always sends this
  if (!agentId) return c.json({ error: { code: 'BAD_REQUEST', message: 'agent_id required' } }, 400)

  // Validate agent_id belongs to this tenant — prevents cross-tenant command snooping
  const exists = await db.queryValue<number>(
    'SELECT 1 FROM sessions WHERE agent_id = $1 AND tenant_id = $2 LIMIT 1',
    [agentId, tenantId]
  )
  if (!exists) return c.json({ commands: [] })   // unknown agent → empty, not 403 (avoids enumeration)

  const redisKey = `dp:commands:${agentId}`

  // LPOP all pending commands atomically — consumed once, never re-delivered
  const raw: string[] = []
  let item: string | null
  while ((item = await redis.lpop(redisKey)) !== null) {
    raw.push(item)
  }

  const commands = raw.map(s => JSON.parse(s))

  // Always return 200 with commands array (even if empty — SDK checks for 200 explicitly)
  return c.json({ commands })
})
```

Command shapes (per sdk_contract.md):
```typescript
// terminate_session — queued by POST /v1/control/kill-switch
{ type: 'terminate_session', reason?: string }

// update_tool_blocklist — future platform feature
{ type: 'update_tool_blocklist', tool_names: string[] }

// update_sample_rate — future platform feature
{ type: 'update_sample_rate', sample_rate: number }
```

### Kill-switch flow (POST /v1/control/kill-switch)

```typescript
// routes/control.ts
app.post('/v1/control/kill-switch', async (c) => {
  const { sessionId, reason } = await c.req.json()
  const tenantId = c.get('tenantId')

  // Look up agentId from session — needed for dp:commands key
  const agentId = await db.queryValue<string>(
    'SELECT agent_id FROM sessions WHERE session_id = $1 AND tenant_id = $2',
    [sessionId, tenantId]
  )
  if (!agentId) throw new NotFoundError(`Session ${sessionId} not found`)

  const cmd = JSON.stringify({ type: 'terminate_session', reason })

  await Promise.all([
    // 1. Queue command in Redis — SDK reads it on next poll (every 5s)
    redis.rpush(`dp:commands:${agentId}`, cmd),
    redis.expire(`dp:commands:${agentId}`, 3600),

    // 2. Produce to obs.priority.v1 — pipeline picks it up, updates session row
    kafka.send({
      topic:    'obs.priority.v1',
      messages: [{ key: sessionId, value: JSON.stringify(buildKillEvent(sessionId, tenantId, reason)) }],
    }),
  ])

  return c.json({ ok: true })
})
```

### Interrupt flow (POST /v1/control/interrupt)

The interrupt endpoint tells the pipeline to mark a session as `interrupted`
via Kafka. It does **not** push a Redis command to the SDK — LangGraph interrupts
are raised by the node itself (`NodeInterrupt`), not triggered externally.
The pipeline receives the Kafka event and updates `sessions.status = 'interrupted'`.

```typescript
// routes/control.ts
app.post('/v1/control/interrupt', async (c) => {
  const { sessionId, reason } = await c.req.json()
  const tenantId = c.get('tenantId')

  // Verify session belongs to tenant before acting
  const row = await db.queryRow<{ agent_id: string; status: string }>(
    'SELECT agent_id, status FROM sessions WHERE session_id = $1 AND tenant_id = $2',
    [sessionId, tenantId]
  )
  if (!row) throw new NotFoundError(`Session ${sessionId} not found`)
  if (row.status !== 'open') {
    throw new BadRequestError(`Session is ${row.status} — can only interrupt open sessions`)
  }

  await kafka.send({
    topic:    'obs.priority.v1',
    messages: [{
      key:   sessionId,
      value: JSON.stringify({
        event_type: 'interrupt_requested',
        session_id: sessionId,
        tenant_id:  tenantId,
        reason,
        ts:         new Date().toISOString(),
      }),
    }],
  })

  return c.json({ ok: true })
})
```

---

## 10. Rule authoring — dry-run preview

`POST /v1/rules` includes a dry-run: after validating the rule config,
query ClickHouse for the last 7 days and return how many times the rule
would have fired. This runs before saving the rule to Postgres.

```typescript
// queries/rules.pg.ts — dry-run for cumulative_cost rule type
async function dryRunCumulativeCost(
  tenantId: string,
  agentId: string | null,
  field: string,         // 'llm_input_tokens + llm_output_tokens' etc.
  threshold: number
): Promise<DryRunResult[]> {
  // Query obs_session_tokens for sessions exceeding threshold
  const rows = await clickhouse.query(`
    SELECT
      session_id,
      sum(total_tokens) AS value
    FROM obs_session_tokens
    FINAL
    WHERE tenant_id = {tenantId: String}
      AND ({agentId: String} = '' OR session_id IN (
            SELECT session_id FROM sessions
            WHERE tenant_id = {tenantId: String}
              AND agent_id  = {agentId: String}
          ))
      AND toDate(created_at) >= today() - 7
    GROUP BY session_id
    HAVING value > {threshold: Float64}
    ORDER BY value DESC
    LIMIT 10
  `, { tenantId, agentId: agentId ?? '', threshold })

  return rows.map(r => ({
    sessionId: r.session_id,
    value:     r.value,
    wouldFire: true,
  }))
}
```

---

## 11. Response schemas (canonical JSON shapes)

### GET /v1/sessions/:id → SessionDetail

```typescript
// types/session.ts
export interface SessionDetail {
  sessionId:     string           // UUID v7
  status:        SessionStatus    // 'stub' | 'open' | 'interrupted' | 'killed' | 'finalised'
  agentId:       string
  agentVersion:  string
  environment:   string
  deploymentId:  string
  userContextId: string
  startedAt:     string | null    // ISO 8601
  endedAt:       string | null
  durationMs:    number | null
  exitReason:    string | null
  graphState:    Record<string, unknown> | null
  initialInput:  Record<string, unknown> | null
  finalOutput:   Record<string, unknown> | null
  lastAlert: {
    alertId:     string
    severity:    'info' | 'warning' | 'critical'
    title:       string
    triggeredAt: string
  } | null
  tokenUsage: {
    totalInputTokens:  number
    totalOutputTokens: number
    llmCallCount:      number
  }
  executionSummary: {
    nodeCount:     number
    errorCount:    number
    toolCallCount: number
    nodesVisited:  string[]
    firstEventAt:  string | null
    lastEventAt:   string | null
  }
}
```

### GET /v1/sessions/:id/trace → TracePage

```typescript
// types/session.ts
export interface TraceEvent {
  eventId:       string
  eventType:     string          // one of 17 event types
  eventCategory: string          // one of 5 categories
  emittedAt:     string          // ISO 8601 with ms precision
  sequenceIndex: number
  nodeRunId:     string | null
  llmRunId:      string | null
  toolRunId:     string | null
  nodeName:      string
  nodeStatus:    string
  llmModel:      string
  llmInputTokens:  number
  llmOutputTokens: number
  llmLatencyMs:    number
  toolName:      string
  toolStatus:    string
  errorCode:     string
  payload:       Record<string, unknown>   // parsed from ZSTD-compressed CH column
}

export interface TracePage {
  sessionId:  string
  events:     TraceEvent[]
  nextCursor: number | null      // sequence_index of last event if more pages exist
  hasNext:    boolean
}
```

### GET /v1/alerts → Paginated<AlertSummary>

```typescript
// types/alert.ts
export interface AlertSummary {
  alertId:     string
  ruleId:      string | null
  ruleName:    string
  ruleType:    string           // from payload.rule_type or joined via rule_id
  sessionId:   string | null
  agentId:     string | null   // joined: alerts.session_id → sessions.agent_id (nullable)
  severity:    'info' | 'warning' | 'medium' | 'critical'  // 'medium' is pipeline default
  title:       string          // from payload.title — pipeline writes this into JSONB
  message:     string          // from payload.message — pipeline writes this into JSONB
  status:      'open' | 'acknowledged' | 'resolved'        // API-managed column (see note)
  triggeredAt: string
  resolvedAt:  string | null   // API-managed column (see note)
}

// NOTE — alerts table schema gap:
// The HANDOFF alerts table does not include `status` or `resolved_at` columns.
// These are API-managed operational columns that must be added via a schema migration
// before the alert endpoints can be built. Add to the shared Postgres schema:
//   ALTER TABLE alerts ADD COLUMN status TEXT NOT NULL DEFAULT 'open';
//   ALTER TABLE alerts ADD COLUMN resolved_at TIMESTAMPTZ;
//   CREATE INDEX idx_alerts_status ON alerts (tenant_id, status);
//
// `title` and `message` are not stored columns — extract from payload JSONB:
//   payload->>'title'   AS title
//   payload->>'message' AS message
//
// `agent_id` is not a stored column on alerts — join via session:
//   LEFT JOIN sessions s ON s.session_id = a.session_id

export type AlertStatus = 'open' | 'acknowledged' | 'resolved'

export interface AlertDetail extends AlertSummary {
  dedupKey:    string
  payload:     Record<string, unknown>  // full raw payload from the alerts row
  deliveries:  AlertDelivery[]
}

export interface AlertDelivery {
  deliveryId:      string
  channelId:       string
  channelName:     string
  status:          'pending' | 'delivered' | 'failed'
  attemptCount:    number
  lastAttemptedAt: string | null
  deliveredAt:     string | null
  errorMessage:    string | null
}
```

### GET /v1/sessions → Paginated<SessionSummary>

```typescript
// types/session.ts
export type SessionStatus =
  | 'stub'        // created by pipeline on first event, not yet open
  | 'open'        // graph running
  | 'finalised'   // graph completed successfully
  | 'interrupted' // paused at NodeInterrupt
  | 'killed'      // terminated via kill-switch
  | 'error'       // unhandled graph-level exception

export interface SessionSummary {
  sessionId:     string
  status:        SessionStatus
  agentId:       string | null
  agentVersion:  string | null
  environment:   string
  deploymentId:  string | null
  userContextId: string | null
  startedAt:     string | null
  endedAt:       string | null
  durationMs:    number | null
  lastActiveAt:  string | null
  alertCount:    number           // count of alerts for this session
}
```

### GET /v1/analytics/overview → OverviewMetrics

```typescript
// types/analytics.ts
export interface OverviewMetrics {
  window:              string    // e.g. '24h'
  totalSessions:       number
  liveSessions:        number
  completedSessions:   number
  errorSessions:       number
  killedSessions:      number
  totalLlmCalls:       number
  totalInputTokens:    number
  totalOutputTokens:   number
  avgLatencyMs:        number
  p95LatencyMs:        number
}
```

### GET /v1/analytics/llm-usage → LlmUsagePoint[]

```typescript
// types/analytics.ts
export interface LlmUsagePoint {
  hour:           string    // ISO 8601, truncated to hour boundary
  llmModel:       string
  llmCallCount:   number
  totalInputTok:  number
  totalOutputTok: number
  avgLatencyMs:   number
  p95LatencyMs:   number
}
```

### GET /v1/analytics/error-rates → ErrorRatePoint[]

```typescript
// types/analytics.ts
export interface ErrorRatePoint {
  hour:       string
  agentId:    string
  nodeName:   string
  errorCount: number
  totalCount: number
  errorRate:  number    // errorCount / totalCount, 0–1
}
```

### GET /v1/analytics/latency → LatencyStat[]

```typescript
// types/analytics.ts
export interface LatencyStat {
  hour:      string
  llmModel:  string
  avgMs:     number
  p95Ms:     number
  callCount: number
}
```

### GET /v1/analytics/sessions/funnel → SessionFunnel

```typescript
// types/analytics.ts
export interface SessionFunnel {
  window:          string    // e.g. '7d'
  totalStarted:    number
  reachedOpen:     number
  reachedTerminal: number
  completed:       number
  killed:          number
  interrupted:     number
  errored:         number
  completionRate:  number    // completed / totalStarted, 0–1
}
```

### GET /v1/alerts/stats → AlertStats

```typescript
// types/alert.ts
export interface AlertStats {
  window:     string
  bySeverity: Array<{
    severity:     'info' | 'warning' | 'medium' | 'critical'
    total:        number
    open:         number
    acknowledged: number
    resolved:     number
  }>
  topRules: Array<{
    ruleId:   string
    ruleName: string
    count:    number
  }>
}
```

### GET /v1/rules → PolicyRule[]

```typescript
// types/rule.ts
export type RuleType =
  | 'threshold'
  | 'content_match'
  | 'schema_violation'
  | 'state_transition'
  | 'rate'
  | 'cumulative_cost'
  | 'sequence'
  | 'session_duration'

export type EvalType = 'stateless' | 'stateful'

export interface PolicyRule {
  ruleId:       string
  tenantId:     string
  name:         string
  ruleType:     RuleType
  evalType:     EvalType
  enabled:      boolean
  config:       Record<string, unknown>   // rule-type-specific config blob
  dedupWindowS: number                    // dedup window in seconds
  createdAt:    string
  updatedAt:    string
}
```

### GET /v1/channels → DeliveryChannel[]

```typescript
// types/channel.ts
export type ChannelType = 'webhook' | 'slack' | 'pagerduty'

export interface WebhookConfig {
  url:      string
  secret?:  string                        // HMAC-SHA256 signing secret
  headers?: Record<string, string>
}

export interface SlackConfig {
  webhookUrl: string
  channel?:   string
}

export interface PagerdutyConfig {
  integrationKey: string
  severity?:      'critical' | 'error' | 'warning' | 'info'
}

export type ChannelConfig = WebhookConfig | SlackConfig | PagerdutyConfig

export interface DeliveryChannel {
  channelId:   string
  name:        string
  channelType: ChannelType
  enabled:     boolean
  config:      ChannelConfig
  createdAt:   string
  updatedAt:   string
}
```

### GET /v1/sessions/:id/state-history → StateHistory

```typescript
// types/session.ts
export interface StateHistoryEvent {
  eventId:       string
  eventType:     string    // checkpoint_write | interrupt_raised | interrupt_resumed
  emittedAt:     string
  sequenceIndex: number
  payload:       Record<string, unknown>
}

export interface StateHistory {
  sessionId: string
  events:    StateHistoryEvent[]
}
```

```typescript
export interface Paginated<T> {
  data:       T[]
  total:      number
  page:       number
  perPage:    number
  totalPages: number
}
```

### Security types (Zone 6) — `types/security.ts`

```typescript
export type RiskBand = 'clean' | 'low' | 'medium' | 'high' | 'critical'

export interface SessionRiskScore {
  sessionId:     string
  tenantId:      string
  agentId:       string | null
  riskScore:     number          // 0–100
  riskBand:      RiskBand
  signalCount:   number
  signalIds:     string[]        // ['INJ-001', 'PII-004']
  scorerVersion: string
  scoredAt:      string          // ISO 8601
}

export interface SecurityFinding {
  findingId:      string
  sessionId:      string
  eventId:        string
  eventType:      string
  signalId:       string         // INJ-001, OUT-001, PII-004, etc.
  sigType:        string         // injection | passthrough | pii | agency | tool_scope
  owaspId:        string         // LLM01 … LLM10
  severity:       'critical' | 'warning' | 'info'
  matchedText:    string | null  // always redacted before storage
  detail:         string | null
  scoreContrib:   number
  detectionPhase: 'online' | 'post_session'
  createdAt:      string
}

export interface SecurityOverview {
  window:            string
  sessionsScored:    number
  highCriticalCount: number
  avgRiskScore:      number
  topSignalId:       string | null
  topSignalCount:    number
  bandDistribution:  Record<RiskBand, number>
  owaspFrequency:    Array<{ owaspId: string; count: number }>
  highRiskSessions:  Array<{
    sessionId: string; agentId: string; riskScore: number
    riskBand: RiskBand; signalIds: string[]
  }>
}

export interface RemediationCard {
  signalId:    string
  owaspId:     string
  title:       string
  description: string
  fixSteps:    string[]
  sdkSnippet:  string | null
  frequency:   number           // how many times this signal fired in the window
}

export interface InjectionSignature {
  signatureId: string
  tenantId:    string | null   // null = platform-wide; non-null = tenant-specific
  signalId:    string          // INJ-001, PII-004, etc.
  sigType:     string          // injection | passthrough | pii | agency | tool_scope
  owaspId:     string          // LLM01 … LLM10
  pattern:     string          // regex or keyword pattern
  description: string | null
  enabled:     boolean
  createdAt:   string          // ISO 8601
}
```

Endpoint → response type mapping:
- `GET /v1/security/overview` → `SecurityOverview`
- `GET /v1/security/sessions/:id/score` → `SessionRiskScore` (404 if scorer has not yet run)
- `GET /v1/security/sessions/:id/findings` → `{ findings: SecurityFinding[] }`
- `GET /v1/security/remediation` → `{ remediation: RemediationCard[] }`
- `GET /v1/security/signatures` → `{ signatures: InjectionSignature[] }`

---

## 12. Query parameters — standard across all list endpoints

```typescript
// common.ts — used by /v1/sessions, /v1/alerts, /v1/rules
export interface ListParams {
  page?:       number    // default 1
  limit?:      number    // default 20, max 100
  sort?:       string    // field:asc or field:desc
  since?:      string    // ISO 8601 — filters started_at / triggered_at >= since
  until?:      string    // ISO 8601 — filters started_at / triggered_at < until
}

// Session-specific filters
export interface SessionListParams extends ListParams {
  status?:      SessionStatus
  agentId?:     string
  environment?: string
  q?:           string    // search session_id prefix or user_context_id
}

// Alert-specific filters
export interface AlertListParams extends ListParams {
  severity?: 'info' | 'warning' | 'medium' | 'critical'
  status?:   'open' | 'acknowledged' | 'resolved'
  ruleId?:   string
  agentId?:  string
}
```

---

## 13. Error responses

All error responses follow this shape:

```typescript
export interface ApiError {
  error: {
    code:    string     // machine-readable: 'NOT_FOUND', 'UNAUTHORIZED', etc.
    message: string     // human-readable
    details?: unknown   // optional structured detail
  }
}
```

HTTP status codes:
- `400` — invalid query params or request body
- `401` — missing or invalid JWT
- `403` — valid JWT but wrong tenant (cross-tenant access attempt)
- `404` — resource not found
- `429` — rate limited
- `500` — internal error (never expose DB details; log internally)

---

## 14. Technology stack

| Layer | Library | Version | Why |
|-------|---------|---------|-----|
| Runtime | Node.js | 22 LTS | Stable async, V8 |
| Framework | `hono` | ≥ 4.4 | Lightweight, native SSE, typed routing |
| Postgres | `postgres` (postgres.js) | ≥ 3.4 | Best-in-class Node.js PG driver, tagged templates |
| ClickHouse | `@clickhouse/client` | ≥ 1.4 | Official client, streaming, typed params |
| Redis | `ioredis` | ≥ 5.3 | Full-featured, pub/sub, typed |
| Kafka | `kafkajs` | ≥ 2.2 | Producer only — for control events |
| Validation | `zod` | ≥ 3.23 | Runtime validation + TypeScript inference |
| Env config | `zod` in `env.ts` | — | Validate env at startup, fail fast |
| Testing | `vitest` | ≥ 1.6 | Fast, native TS, no transform needed |
| HTTP testing | `supertest` or Hono's `testClient` | latest | Integration tests |
| Package manager | `pnpm` | ≥ 9 | Faster, strict hoisting |

---

## 15. Environment variables (validated via zod in `src/env.ts`)

```bash
# Postgres (same DB as dapplepot_pipeline writes to)
POSTGRES_URL=postgresql://dapplepot:dapplepot@localhost:5432/dapplepot_pipeline

# ClickHouse — combined at runtime as `https://${CLICKHOUSE_HOST}:${CLICKHOUSE_PORT}`
# CLICKHOUSE_HOST: hostname only, no scheme (e.g. abc.ap-south-1.aws.clickhouse.cloud)
CLICKHOUSE_HOST=your-host.clickhouse.cloud
CLICKHOUSE_PORT=8443
CLICKHOUSE_USER=dapplepot
CLICKHOUSE_PASSWORD=dapplepot

# Redis (same instance and DB as pipeline — DB 0, same as pipeline)
# API keys are prefixed dp:api: to avoid collision with pipeline's dp: keys.
# Must share DB 0 so the API can read dp:auth:*, dp:rules:*, and publish
# to dp:rule-invalidate on the same connection the pipeline workers subscribe to.
REDIS_URL=redis://localhost:6379

# Kafka (produce control events only)
KAFKA_BOOTSTRAP_SERVERS=localhost:9092

# Auth
DAPPLEPOT_JWT_SECRET=changeme_in_production

# Server
API_HOST=0.0.0.0
API_PORT=3000
API_CORS_ORIGIN=http://localhost:5173    # dapplepot_ui dev server

# Cache TTLs (seconds)
CACHE_TTL_OVERVIEW=30
CACHE_TTL_ANALYTICS=60
CACHE_TTL_COST=300
# Security cache TTLs — aligned with dapplepot_security scorer cadence
# CACHE_TTL_SECURITY_OVERVIEW: 120s matches UI staleTime: 2min
# CACHE_TTL_SESSION_SCORE: 300s matches UI staleTime: 5min; scores are immutable once written
CACHE_TTL_SECURITY_OVERVIEW=120
CACHE_TTL_SESSION_SCORE=300
CACHE_TTL_REMEDIATION=300
```

Note: Both this service and `dapplepot_pipeline` use Redis DB 0 on the same
instance. Key collision is prevented by namespace prefix only: pipeline uses
`dp:` and this API uses `dp:api:`. Sharing DB 0 is required so that cache
invalidation (`DEL dp:rules:{tenant_id}`, `PUBLISH dp:rule-invalidate`) and
SDK key auth lookups (`GET dp:auth:{key_hash}`) work across both services.

---

## 16. Local dev setup

```bash
# Uses the same docker-compose as dapplepot_pipeline
# Clone dapplepot_pipeline first and run: docker compose up -d

pnpm install
cp .env.example .env

pnpm dev       # starts API on port 3000 with hot reload

pnpm test:unit          # vitest unit tests, no infra
pnpm test:integration   # requires docker compose up from dapplepot_pipeline
pnpm test               # all tests
pnpm build              # tsc to dist/
pnpm start              # node dist/index.js (production)
pnpm lint               # eslint + tsc --noEmit
pnpm typecheck          # tsc --noEmit only
```

---

## 17. Build order

Build in this exact sequence. Each phase is independently testable.

### Phase 1 — Foundation
```
src/env.ts                         zod schema for all env vars, fail-fast on startup
src/types/common.ts                Paginated<T>, ApiError, DateRange, SortOrder, ListParams
src/types/session.ts               Session, SessionDetail, TracePage, TraceEvent
src/types/alert.ts                 Alert, AlertSummary, AlertDetail, AlertStatus
src/types/analytics.ts             OverviewMetrics, LlmUsagePoint, ErrorRatePoint, LatencyStat
src/types/rule.ts                  PolicyRule, RuleType, RuleCondition, AlertConfig
src/types/channel.ts               DeliveryChannel, ChannelType, ChannelConfig
src/types/security.ts              RiskBand, SessionRiskScore, SecurityFinding, SecurityOverview,
                                   RemediationCard, InjectionSignature  (Zone 6)
src/lib/postgres.ts                postgres.js pool, queryRow/queryRows/queryValue helpers
src/lib/clickhouse.ts              @clickhouse/client, query/queryRow helpers
src/lib/redis.ts                   ioredis pool, get/set/del/publish helpers
src/lib/kafka.ts                   kafkajs producer for obs.priority.v1
src/lib/cache.ts                   generic cached<T> wrapper using redis
```

### Phase 2 — Queries (pure DB functions, no HTTP)
```
src/queries/sessions.pg.ts         getSessionList, getSessionPg, getSessionAlerts
src/queries/sessions.ch.ts         getSessionTokens, getSessionEventStats, getTracePage, getStateHistory
src/queries/analytics.ch.ts        getOverviewMetrics, getLlmUsage, getErrorRates, getLatency, getCost
src/queries/alerts.pg.ts           getAlertList, getAlertDetail, updateAlertStatus, getAlertStats
src/queries/rules.pg.ts            getRuleList, createRule, updateRule, dryRunRule
src/queries/channels.pg.ts         getChannelList, createChannel, updateChannel
src/queries/security.pg.ts         getSecurityOverview, getSessionScore, getSessionFindings,
                                   getRemediationStats  (Zone 6 — reads tables written by dapplepot_security)
```

### Phase 3 — Stitchers (combine PG + CH, no HTTP)
```
src/stitchers/session-detail.ts    Promise.all([pgRow, chTokens, chStats]) → SessionDetail
src/stitchers/overview.ts          Promise.all([pgCounts, chMetrics]) → OverviewMetrics
```

### Phase 4 — Middleware + Auth
```
src/middleware/cors.ts
src/middleware/auth.ts             JWT verify, tenant extraction, c.set('tenantId', ...)
src/middleware/ratelimit.ts        Redis sliding window, 429 on limit
```

### Phase 5 — Routes
```
src/routes/sessions.ts             all 6 session endpoints + SSE live feed
src/routes/analytics.ts            all 6 analytics endpoints
src/routes/alerts.ts               4 alert endpoints
src/routes/control.ts              POST kill-switch, POST interrupt, GET SSE channel
src/routes/rules.ts                GET/POST/PUT rules
src/routes/channels.ts             GET/POST/PUT channels
src/routes/security.ts             5 security endpoints — read-only, JWT auth  (Zone 6)
src/routes/index.ts                mount all groups onto Hono app
src/index.ts                       Hono app factory, lifespan, startup validation
```

### Phase 6 — Tests
```
tests/setup.ts
tests/unit/session-stitch.test.ts
tests/unit/analytics-transform.test.ts
tests/unit/rule-validation.test.ts
tests/unit/auth-tokens.test.ts
tests/unit/authorize.test.ts
tests/integration/health.test.ts
tests/integration/auth.test.ts
tests/integration/users.test.ts
tests/integration/sessions.test.ts
tests/integration/analytics.test.ts
tests/integration/alerts.test.ts
tests/integration/rules.test.ts
tests/integration/not-found.test.ts
```

---

## 18. Locked architecture decisions — do not change

| # | Decision | Reason |
|---|----------|--------|
| 1 | `Promise.all` for all PG + CH fan-out | Never query Postgres and ClickHouse sequentially |
| 2 | Cursor pagination on `sequence_index` for trace | OFFSET grows with depth; cursor is O(1) regardless of page |
| 3 | Read from aggregate tables for analytics | Never scan `obs_events` for dashboard aggregate queries |
| 4 | `FINAL` on SummingMergeTree + AggregatingMergeTree queries | Forces dedup of unmerged parts; required for accuracy |
| 5 | No direct writes to pipeline tables from this service | Except `alerts.status`/`alerts.resolved_at` (operational) and `obs.priority.v1` (control) |
| 6 | Redis DB 0 shared with pipeline — prefix `dp:api:` for API keys | Must share DB 0 to invalidate pipeline caches and read `dp:auth:*` for SDK key auth |
| 7 | All API cache keys prefixed `dp:api:` | Namespaced from pipeline's `dp:` keys within the same DB |
| 8 | On rule PUT: DEL both `dp:rules:` and `dp:api:rules:` + PUBLISH | Both the pipeline evaluator and API cache must be invalidated together |
| 9 | Cache-Control header on finalised session + trace responses | CDN can absorb repeated trace fetches; immutable once finalised |
| 10 | JWT auth for dashboard; SDK key auth for `GET /v1/control/commands` only | SDK never receives a JWT; dashboard users never use SDK keys |
| 11 | Control commands use `dp:commands:{agent_id}` Redis list, LPOP on read | Matches pipeline's key pattern; consumed-once per sdk_contract.md |
| 12 | Kill-switch command type is `terminate_session` (not `kill_switch`) | SDK checks `type === 'terminate_session'` — wrong type is silently ignored |
| 13 | Security endpoints are read-only — no writes to `security_findings` or `session_risk_scores` | `dapplepot_security` (Zone 6) owns those tables; this service only reads them |
| 14 | Security cache keys use `dp:api:security:` prefix within the shared `dp:api:` namespace | Consistent with other API cache keys; won't collide with pipeline's `dp:sec:` prefix |

---

## 19. Missing query specs

All queries not covered in §5–§10.

### GET /v1/sessions — Postgres

```sql
-- queries/sessions.pg.ts
SELECT
  s.session_id,
  s.status,
  s.agent_id,
  s.agent_version,
  s.environment,
  s.deployment_id,
  s.user_context_id,
  s.started_at,
  s.ended_at,
  s.duration_ms,
  s.last_active_at,
  COUNT(a.alert_id)::int AS alert_count
FROM sessions s
LEFT JOIN alerts a ON a.session_id = s.session_id
WHERE s.tenant_id = $1
  AND ($2::text       IS NULL OR s.status       = $2)
  AND ($3::uuid       IS NULL OR s.agent_id      = $3)
  AND ($4::text       IS NULL OR s.environment   = $4)
  AND ($5::timestamptz IS NULL OR s.started_at   >= $5)
  AND ($6::timestamptz IS NULL OR s.started_at   < $6)
  AND ($7::text       IS NULL OR s.session_id::text LIKE $7 || '%'
                               OR s.user_context_id = $7)
GROUP BY s.session_id
ORDER BY s.started_at DESC NULLS LAST
LIMIT $8 OFFSET $9
```

Count query (for pagination total):
```sql
SELECT COUNT(DISTINCT s.session_id)
FROM sessions s
WHERE s.tenant_id = $1
  AND ($2::text        IS NULL OR s.status          = $2)
  AND ($3::uuid        IS NULL OR s.agent_id         = $3)
  AND ($4::text        IS NULL OR s.environment      = $4)
  AND ($5::timestamptz IS NULL OR s.started_at       >= $5)
  AND ($6::timestamptz IS NULL OR s.started_at       < $6)
  AND ($7::text        IS NULL OR s.session_id::text LIKE $7 || '%'
                                OR s.user_context_id = $7)
```

### GET /v1/sessions/:id/state-history — ClickHouse

```sql
-- queries/sessions.ch.ts
SELECT
  event_id,
  event_type,
  emitted_at,
  sequence_index,
  payload
FROM obs_events
WHERE tenant_id  = {tenantId: String}
  AND session_id = {sessionId: UUID}
  AND event_type IN (
    'checkpoint_write',
    'interrupt_raised',
    'interrupt_resumed'
  )
ORDER BY sequence_index ASC
```

### GET /v1/sessions/:id/alerts — Postgres

```sql
-- queries/sessions.pg.ts
SELECT
  a.alert_id,
  a.rule_id,
  a.rule_name,
  a.severity,
  a.triggered_at,
  a.status,
  a.resolved_at,
  a.payload->>'title'   AS title,
  a.payload->>'message' AS message,
  a.payload->>'rule_type' AS rule_type,
  s.agent_id
FROM alerts a
LEFT JOIN sessions s ON s.session_id = a.session_id
WHERE a.session_id = $1
  AND a.tenant_id  = $2
ORDER BY a.triggered_at DESC
```

### GET /v1/alerts — Postgres

```sql
-- queries/alerts.pg.ts
SELECT
  a.alert_id,
  a.rule_id,
  a.rule_name,
  a.severity,
  a.session_id,
  a.triggered_at,
  a.status,
  a.resolved_at,
  a.payload->>'title'     AS title,
  a.payload->>'message'   AS message,
  a.payload->>'rule_type' AS rule_type,
  s.agent_id
FROM alerts a
LEFT JOIN sessions s ON s.session_id = a.session_id
WHERE a.tenant_id    = $1
  AND ($2::text        IS NULL OR a.severity = $2)
  AND ($3::text        IS NULL OR a.status   = $3)
  AND ($4::uuid        IS NULL OR a.rule_id  = $4)
  AND ($5::uuid        IS NULL OR s.agent_id = $5)
  AND ($6::timestamptz IS NULL OR a.triggered_at >= $6)
  AND ($7::timestamptz IS NULL OR a.triggered_at <  $7)
ORDER BY a.triggered_at DESC
LIMIT $8 OFFSET $9
```

### GET /v1/alerts/stats — Postgres

```sql
-- queries/alerts.pg.ts — severity breakdown
SELECT
  severity,
  COUNT(*)                             AS total,
  COUNT(*) FILTER (WHERE status = 'open')         AS open,
  COUNT(*) FILTER (WHERE status = 'acknowledged') AS acknowledged,
  COUNT(*) FILTER (WHERE status = 'resolved')     AS resolved
FROM alerts
WHERE tenant_id    = $1
  AND triggered_at >= NOW() - $2::interval
GROUP BY severity

-- top rules (second query, combine in Promise.all)
SELECT rule_id, rule_name, COUNT(*) AS count
FROM alerts
WHERE tenant_id    = $1
  AND triggered_at >= NOW() - $2::interval
GROUP BY rule_id, rule_name
ORDER BY count DESC
LIMIT 10
```

### PUT /v1/alerts/:id/status — Postgres

```sql
-- queries/alerts.pg.ts
UPDATE alerts
SET
  status      = $3,
  resolved_at = CASE WHEN $3 = 'resolved' THEN NOW() ELSE resolved_at END,
  -- clear resolved_at when re-opening
  resolved_at = CASE WHEN $3 = 'open'     THEN NULL  ELSE resolved_at END
WHERE alert_id  = $1
  AND tenant_id = $2
RETURNING alert_id, status, resolved_at
```

Actually write this as two separate CASE steps to avoid duplicate column alias:
```sql
UPDATE alerts
SET
  status      = $3,
  resolved_at = CASE
                  WHEN $3 = 'resolved' THEN NOW()
                  WHEN $3 = 'open'     THEN NULL
                  ELSE resolved_at
                END
WHERE alert_id  = $1
  AND tenant_id = $2
RETURNING alert_id, status, resolved_at
```

### GET /v1/analytics/latency — ClickHouse

```sql
-- queries/analytics.ch.ts
SELECT
  toStartOfHour(hour)                     AS hour,
  llm_model,
  avgMerge(avg_latency_state)             AS avg_ms,
  quantileMerge(0.95)(p95_latency_state)  AS p95_ms,
  sum(llm_call_count)                     AS call_count
FROM obs_llm_hourly
FINAL
WHERE tenant_id = {tenantId: String}
  AND hour >= toStartOfHour(now() - INTERVAL {hours: UInt32} HOUR)
  AND ({agentId: String} = '' OR agent_id = {agentId: String})
GROUP BY hour, llm_model
ORDER BY hour ASC
```

### GET /v1/analytics/sessions/funnel — Postgres

```sql
-- queries/analytics.pg.ts (not ClickHouse — session status lives in PG)
SELECT
  COUNT(*)                                                          AS total_started,
  COUNT(*) FILTER (WHERE status != 'stub')                         AS reached_open,
  COUNT(*) FILTER (WHERE status IN ('finalised','killed','interrupted','error')) AS reached_terminal,
  COUNT(*) FILTER (WHERE status = 'finalised')                     AS completed,
  COUNT(*) FILTER (WHERE status = 'killed')                        AS killed,
  COUNT(*) FILTER (WHERE status = 'interrupted')                   AS interrupted,
  COUNT(*) FILTER (WHERE status = 'error')                         AS errored
FROM sessions
WHERE tenant_id  = $1
  AND started_at >= NOW() - $2::interval
```

### GET /v1/rules — Postgres

```sql
-- queries/rules.pg.ts
SELECT rule_id, tenant_id, name, rule_type, eval_type,
       enabled, config, dedup_window_s, created_at, updated_at
FROM policy_rules
WHERE tenant_id = $1
ORDER BY created_at DESC
```

### POST /v1/rules — Postgres

```sql
INSERT INTO policy_rules (tenant_id, name, rule_type, eval_type, enabled, config, dedup_window_s)
VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
RETURNING rule_id, tenant_id, name, rule_type, eval_type,
          enabled, config, dedup_window_s, created_at, updated_at
```

### PUT /v1/rules/:id — Postgres + Redis invalidation

```typescript
// routes/rules.ts
app.put('/v1/rules/:id', async (c) => {
  const tenantId = c.get('tenantId')
  const ruleId   = c.req.param('id')
  const body     = await c.req.json()   // { name?, enabled?, config?, dedupWindowS? }

  const updated = await db.queryRow(
    `UPDATE policy_rules
     SET name           = COALESCE($3, name),
         enabled        = COALESCE($4, enabled),
         config         = COALESCE($5::jsonb, config),
         dedup_window_s = COALESCE($6, dedup_window_s),
         updated_at     = NOW()
     WHERE rule_id  = $1
       AND tenant_id = $2
     RETURNING *`,
    [ruleId, tenantId, body.name ?? null, body.enabled ?? null,
     body.config ? JSON.stringify(body.config) : null, body.dedupWindowS ?? null]
  )
  if (!updated) throw new NotFoundError(`Rule ${ruleId} not found`)

  // Invalidate both the pipeline evaluator cache and the API read cache
  await Promise.all([
    redis.del(`dp:rules:${tenantId}`),          // pipeline evaluator cache
    redis.del(`dp:api:rules:${tenantId}`),       // API read cache
    redis.publish('dp:rule-invalidate', tenantId),
  ])

  return c.json(updated)
})
```

### GET /v1/channels — Postgres

```sql
-- queries/channels.pg.ts
SELECT channel_id, tenant_id, name, channel_type, enabled, config, created_at, updated_at
FROM channels
WHERE tenant_id = $1
ORDER BY created_at DESC
```

### POST /v1/channels — Postgres

```sql
INSERT INTO channels (tenant_id, name, channel_type, enabled, config)
VALUES ($1, $2, $3, $4, $5::jsonb)
RETURNING channel_id, tenant_id, name, channel_type, enabled, config, created_at, updated_at
```

### PUT /v1/channels/:id — Postgres

```sql
UPDATE channels
SET name         = COALESCE($3, name),
    enabled      = COALESCE($4, enabled),
    config       = COALESCE($5::jsonb, config),
    updated_at   = NOW()
WHERE channel_id = $1
  AND tenant_id  = $2
RETURNING channel_id, tenant_id, name, channel_type, enabled, config, created_at, updated_at
```

---

## 20. ClickHouse aggregate table schemas

These are the confirmed column lists for the three aggregate tables used by analytics
queries. The pipeline creates and populates them — the API only reads with `FINAL`.

### `obs_llm_hourly` (AggregatingMergeTree) — actual schema

```sql
CREATE TABLE obs_llm_hourly (
  tenant_id        LowCardinality(String),
  agent_id         LowCardinality(String),
  llm_model        LowCardinality(String),
  hour             DateTime,
  input_tokens_sum AggregateFunction(sum, UInt64),
  output_tokens_sum AggregateFunction(sum, UInt64),
  latency_avg      AggregateFunction(avg, Float64),
  latency_p95      AggregateFunction(quantile(0.95), Float64),
  call_count       AggregateFunction(count, UInt8)
) ENGINE = AggregatingMergeTree()
  ORDER BY (tenant_id, agent_id, llm_model, hour);

-- Read with (always add FINAL):
--   sumMerge(input_tokens_sum)       → total input tokens
--   sumMerge(output_tokens_sum)      → total output tokens
--   avgMerge(latency_avg)            → avg latency ms
--   quantileMerge(0.95)(latency_p95) → p95 latency ms
--   countMerge(call_count)           → total LLM calls
```

### `obs_error_hourly` (SummingMergeTree) — actual schema

```sql
CREATE TABLE obs_error_hourly (
  tenant_id   LowCardinality(String),
  agent_id    LowCardinality(String),
  node_name   LowCardinality(String),
  event_type  LowCardinality(String),
  hour        DateTime,
  error_count UInt64,
  total_count UInt64
) ENGINE = SummingMergeTree((error_count, total_count))
  ORDER BY (tenant_id, agent_id, node_name, hour);

-- Read with FINAL; use aliased sums (e.g. AS err_count) to avoid alias/column name conflicts
-- Compute error_rate = sum(error_count) / sum(total_count) in the SELECT
```

### `obs_session_tokens` (SummingMergeTree) — actual schema

```sql
CREATE TABLE obs_session_tokens (
  tenant_id    LowCardinality(String),
  session_id   UUID,
  input_tokens  UInt64,
  output_tokens UInt64,
  total_tokens  UInt64,
  created_at   DateTime DEFAULT now()
) ENGINE = SummingMergeTree((input_tokens, output_tokens, total_tokens))
  ORDER BY (tenant_id, session_id);

-- No agent_id or day column — filter by toDate(created_at) for date ranges
-- token totals query returns tok_in / tok_out aliases to avoid column name conflicts
```

---

## 21. Schema migrations

Run these once against the shared Postgres instance **before** starting this service.
The pipeline has already created the base tables — these add API-managed columns
and the `channels` table which the pipeline does not create.

Use the built-in migration runner (no `psql` required):

```bash
pnpm migrate
```

- Reads `POSTGRES_URL` from `.env` via `dotenv/config`
- Connects with `ssl: 'require'` (required for Aiven/cloud Postgres)
- Tracks applied files in a `_migrations` table
- Runs each `.sql` file in `migrations/` in filename order
- Idempotent — safe to re-run

```sql
-- migrations/001_api_alerts_columns.sql
-- Adds operational columns managed by dapplepot_api to the pipeline's alerts table.
ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS status      TEXT        NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_alerts_status
  ON alerts (tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_alerts_triggered_tenant
  ON alerts (tenant_id, triggered_at DESC);
```

```sql
-- migrations/002_channels_table.sql
-- Delivery channel config table — owned entirely by dapplepot_api.
-- alert_deliveries.channel is a plain text column (e.g. 'webhook', 'slack') — not a FK to this table.
CREATE TABLE IF NOT EXISTS channels (
  channel_id   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID        NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  channel_type TEXT        NOT NULL CHECK (channel_type IN ('webhook','slack','pagerduty')),
  enabled      BOOLEAN     NOT NULL DEFAULT true,
  config       JSONB       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_channels_tenant
  ON channels (tenant_id);
```

Run order: `001` → `002` → `003` → `004` → `005` → `006`. All are idempotent.

```sql
-- migrations/003_users_table.sql
CREATE TABLE IF NOT EXISTS users (
    user_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants(tenant_id),
    email         TEXT NOT NULL,
    name          TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','editor','viewer')),
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_users_tenant_email UNIQUE (tenant_id, email)
);
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users (tenant_id);
```

```sql
-- migrations/004_invites_table.sql
CREATE TABLE IF NOT EXISTS invites (
    invite_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants(tenant_id),
    email      TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','editor','viewer')),
    invited_by UUID NOT NULL REFERENCES users(user_id),
    token_hash TEXT NOT NULL UNIQUE,
    status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','expired','revoked')),
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One pending invite per email per tenant
CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_pending_email ON invites (tenant_id, email) WHERE status = 'pending';
```

```sql
-- migrations/005_password_resets_table.sql
CREATE TABLE IF NOT EXISTS password_resets (
    reset_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(user_id),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets (user_id);
```

```sql
-- migrations/006_refresh_tokens_table.sql
CREATE TABLE IF NOT EXISTS refresh_tokens (
    token_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(user_id),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens (user_id);
```

---

## 23. What done looks like

**Unit tests pass** (`pnpm test:unit`, no infra):
- Session stitch correctly merges null CH results (session with no LLM calls)
- Analytics transforms handle empty time windows
- Rule condition validation rejects invalid configs
- `generateAccessToken` / `verifyAccessToken` — correct payload, expired/wrong-secret/wrong-type all throw
- `generateRefreshToken` — 128-char hex raw, SHA-256 hash, different each call
- `requireRole` — viewer/editor/admin rank enforcement, unknown roles blocked (rank 0)

**Integration tests pass** (`pnpm test:integration`, requires real infra via `.env`):

Integration tests import `src/app.ts` directly and call `app.request()` — no server is started.
The `src/index.ts` entry point is only used for production (`pnpm dev` / `pnpm start`).

Auth middleware:
- Missing/invalid JWT → 401 `UNAUTHORIZED`
- JWT with `type: 'refresh'` rejected → 401
- Legacy JWT (no `type`) accepted → role defaults to `'viewer'`

Auth routes:
- `POST /v1/auth/login` valid → 200 with `accessToken`, `refreshToken`, `expiresIn: 900`, user shape
- `POST /v1/auth/login` wrong password or disabled user → 401 `INVALID_CREDENTIALS`
- `POST /v1/auth/refresh` → rotated tokens, old token rejected on replay → 401
- `POST /v1/auth/logout` → 200, token revoked, subsequent refresh → 401
- `POST /v1/auth/forgot-password` → always 200 regardless of email existence
- `POST /v1/auth/reset-password` valid token → 200, sessions revoked, old refresh rejected
- `POST /v1/auth/accept-invite` valid → 200 with login tokens, invite marked accepted

Users:
- `GET /v1/users` without token → 401; viewer/editor → 403; admin → 200 paginated
- `GET /v1/users/me` → 200, no `passwordHash` in response
- `PUT /v1/users/me` password change → revokes all refresh tokens (verified in DB)
- `POST /v1/users/invite` → 201; duplicate → 409 `INVITE_PENDING`
- `PUT /v1/users/:id/role` self-change → 400; other user → 200
- `PUT /v1/users/:id/status` disable → 200, refresh tokens revoked (verified in DB)

Other endpoints:
- `GET /health` → 200 with `postgres`, `clickhouse`, `redis` fields
- `GET /v1/sessions` → `{ data, total, page, perPage, totalPages }` shape
- `GET /v1/alerts` → paginated shape
- `GET /v1/rules` → array
- Unknown routes → 404 `NOT_FOUND`

---

*Single source of truth for `dapplepot_api`.
Build in phase order. Do not skip phases.*
