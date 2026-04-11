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
  └── GET  /v1/security/agents          top agents by composite risk score
  └── GET  /v1/security/agents/:id      full security profile for a single agent
  └── GET  /v1/security/signals         full signal registry (121 non-excluded sub-checks)
  └── GET  /v1/security/agents/:id/subcheck-config    per-subcheck online detection toggle map
  └── PUT  /v1/security/agents/:id/subcheck-config    upsert one sub-check online override
  └── GET  /v1/security/agents/:id/alert-config       composite + per-signal threshold overrides
  └── PUT  /v1/security/agents/:id/alert-config       update composite or per-signal threshold
  └── GET  /v1/tenants                   list all tenants with admin user + user count (superadmin only)
  └── GET  /v1/tenants/:id              get tenant by ID (superadmin or own tenant)
  └── POST /v1/tenants/onboard          create tenant + admin user atomically (superadmin only)
  └── GET  /v1/agents                   list agents for caller's tenant
  └── POST /v1/agents                   create agent (admin only)
  └── GET  /v1/sdk-keys                 list SDK keys for tenant (masked)
  └── GET  /v1/sdk-keys/:id/reveal      reveal full key (admin only)

dapplepot_langgraph SDK
  └── GET  /v1/control/commands         SDK polls every 5s for pending commands (JSON)

Reads from:
  ├── Postgres     (sessions, agents, alerts, policy_rules, channels, alert_deliveries,
  │                 session_risk_scores, security_findings, injection_signatures)
  └── ClickHouse   (obs_events, obs_llm_hourly, obs_error_hourly, obs_session_tokens)

Writes to:
  ├── Postgres     (alerts.status, alerts.resolved_at — acknowledge/resolve only;
  │                 tenants + users + sdk_keys — onboarding, in a single transaction)
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
├── AGENT.md                        ← full IDE agent context (read before coding)
├── README.md                       ← this file
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json                   ← strict mode
├── tsconfig.build.json
├── .env.example
├── vitest.config.ts
│
├── scripts/
│   ├── migrate.ts                  ← Node.js migration runner (no psql needed)
│   ├── seed_superadmin.ts          ← seeds platform superadmin user (tenant_id = NULL)
│   └── seed_admin.ts               ← seeds dapplepot_dev tenant + scoped admin user
│
├── migrations/                     ← ordered SQL files applied by scripts/migrate.ts
│   ├── 001_tenants.sql
│   ├── 002_agents.sql
│   ├── 003_channels_table.sql
│   ├── 004_users_table.sql
│   ├── 005_invites_table.sql
│   ├── 006_password_resets_table.sql
│   ├── 007_refresh_tokens_table.sql
│   ├── 008_sdk_keys_raw.sql
│   ├── 009_agent_subcheck_overrides.sql
│   ├── 010_agent_alert_config.sql
│   └── 011_split_composite_thresholds.sql
│
└── src/
    ├── index.ts                    ← server entry: serve() + SIGTERM handler
    ├── app.ts                      ← Hono app, middleware, routes, error handlers
    ├── env.ts                      ← zod-validated env vars (dotenv loaded here)
    │
    ├── types/                      ← exported as @dapplepot/types for dapplepot_ui
    │   ├── index.ts                ← barrel re-export of all type modules
    │   ├── session.ts              ← SessionStatus, SessionSummary, SessionDetail, TracePage
    │   ├── alert.ts                ← AlertSummary, AlertDetail, AlertStatus, AlertStats
    │   ├── analytics.ts            ← OverviewMetrics, LlmUsagePoint, ErrorRatePoint, LatencyStat
    │   ├── rule.ts                 ← PolicyRule, RuleType, EvalType
    │   ├── channel.ts              ← DeliveryChannel, ChannelType, ChannelConfig
    │   ├── common.ts               ← Paginated<T>, ApiError, ListParams
    │   ├── security.ts             ← RiskBand, SessionRiskScore, SecurityFinding, SecurityOverview  (Zone 6)
    │   └── auth.ts                 ← LoginRequest/Response, UserSummary, InviteSummary, etc.
    │
    ├── lib/                        ← infra clients + auth helpers
    │   ├── postgres.ts             ← postgres.js pool + queryRow/queryRows/queryValue
    │   ├── clickhouse.ts           ← @clickhouse/client + stream/batch helpers
    │   ├── redis.ts                ← ioredis + pub/sub helpers
    │   ├── kafka.ts                ← kafkajs producer (control events only)
    │   ├── cache.ts                ← generic Redis cache wrapper (dp:api: prefix)
    │   ├── auth-tokens.ts          ← generateAccessToken, generateRefreshToken, hashToken
    │   └── email/
    │       ├── index.ts            ← createEmailProvider factory (console/smtp/resend)
    │       ├── console.ts          ← ConsoleEmailProvider — logs to stdout in dev
    │       ├── smtp.ts             ← SmtpEmailProvider (nodemailer)
    │       ├── resend.ts           ← ResendEmailProvider (@resend/node)
    │       └── templates.ts        ← inviteEmail(), resetEmail() HTML + text templates
    │
    ├── middleware/
    │   ├── auth.ts                 ← JWT (dashboard, now with role) + SDK key auth
    │   ├── authorize.ts            ← requireRole('superadmin'|'admin'|'editor'|'viewer') rank check
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
    │   ├── security.pg.ts          ← overview, session score, findings, remediation, agents, signal registry,
│   │                               subcheck overrides, alert config (Zone 6)
    │   ├── tenants.pg.ts           ← listTenants(), onboardTenant() — transaction: tenant + admin user + sdk_key
    │   ├── agents.pg.ts            ← listAgents, createAgent
    │   ├── sdk-keys.pg.ts          ← listSdkKeys (masked_key from DB), revealSdkKey → raw_key (admin)
    │   ├── users.pg.ts             ← findByEmail, create, updateRole, updateStatus, updateProfile
    │   ├── invites.pg.ts           ← createInvite, listInvites, acceptInvite, revokeInvite
    │   ├── refresh-tokens.pg.ts    ← create, findActive, revoke, revokeAll
    │   └── password-resets.pg.ts   ← create, findValid, markUsed
    │
    ├── stitchers/                  ← combines PG + CH results, no HTTP
    │   ├── session-detail.ts       ← Promise.all([pgRow, chTokens, chStats])
    │   └── overview.ts             ← Promise.all([pgCounts, chMetrics])
    │
    └── routes/
        ├── index.ts                ← mounts all groups
        ├── auth.ts                 ← POST /v1/auth/login|refresh|logout|forgot-password|reset-password|accept-invite
        ├── users.ts                ← GET/POST /v1/users, /me, /invites, /:id/role, /:id/status
        ├── tenants.ts              ← GET /v1/tenants, POST /v1/tenants/onboard (superadmin only)
        ├── agents.ts               ← GET /v1/agents, POST /v1/agents
        ├── sdk-keys.ts             ← GET /v1/sdk-keys, GET /v1/sdk-keys/:keyId/reveal
        ├── sessions.ts             ← 6 session endpoints + SSE live feed
        ├── analytics.ts            ← 6 analytics endpoints
        ├── alerts.ts               ← 4 alert endpoints
        ├── control.ts              ← kill-switch, interrupt, SDK command poll
        ├── rules.ts                ← GET/POST/PUT rules
        ├── channels.ts             ← GET/POST/PUT channels
        └── security.ts             ← 12 security endpoints (Zone 6)
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
| `POSTGRES_URL` | `postgresql://user:pass@host/db` | Local Docker or Aiven/cloud |
| `POSTGRES_SSL` | `true` | Set to `true` for cloud/Aiven; omit for local Docker |
| `CLICKHOUSE_HOST` | `abc.clickhouse.cloud` | Hostname only, no `https://` |
| `CLICKHOUSE_PORT` | `8443` | Default for ClickHouse Cloud |
| `REDIS_URL` | `redis://localhost:6379` | |
| `DAPPLEPOT_JWT_SECRET` | `changeme` | Min 1 char — used to sign access tokens |
| `DAPPLEPOT_JWT_ACCESS_EXPIRES_IN` | `15m` | Access token lifetime, default `15m` |
| `DAPPLEPOT_JWT_REFRESH_EXPIRES_IN` | `7d` | Refresh token lifetime, default `7d` |
| `DAPPLEPOT_EMAIL_PROVIDER` | `console` | `console` (dev) \| `smtp` \| `resend` |
| `DAPPLEPOT_EMAIL_FROM` | `noreply@dapplepot.io` | From address for invite/reset emails |
| `DAPPLEPOT_APP_URL` | `http://localhost:5173` | Base URL for email links |

### 3. Run schema migrations

```bash
pnpm migrate
```

Reads `POSTGRES_URL` from `.env` and tracks applied files in a `_migrations`
table. SSL is enabled only when `POSTGRES_SSL=true` — omit it for local Docker.
All files are idempotent — safe to re-run.

> Ensure `dapplepot_pipeline` has run its own migrations first so the `alerts` table exists before this service's routes query it.

### 4. Seed dev users

```bash
pnpm seed-superadmin
# → email:    superadmin@dapplepot.dev
# → password: superadmin123
# → role:     superadmin
# → tenant:   (none — platform-level)

pnpm seed-admin
# → email:    admin@dapplepot.dev
# → password: changeme123
# → role:     admin
# → tenant:   dapplepot_dev (00000000-0000-0000-0000-000000000001)
```

Both are safe to re-run (upserts). Require the `users` table from migrations above.

### 5. Start

```bash
# From dapplepot_pipeline repo, if not already running:
# docker compose up -d

pnpm dev     # hot-reload dev server on port 3000
```

### 6. Verify

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

Three auth paths:

**Public — auth routes (`/v1/auth/*`):**
No token required. These endpoints issue and revoke tokens.

**Dashboard endpoints (all `/v1/*` except `/v1/auth/*` and `/v1/control/commands`):**
`Authorization: Bearer <access_token>` — short-lived JWT (15 min) issued by `POST /v1/auth/login`.
Payload: `{ tenant_id, user_id, role, type: "access" }`.
Four roles — `superadmin`, `admin`, `editor`, `viewer` — enforced per-route by `requireRole()`.

**SDK polling endpoint (`GET /v1/control/commands` only):**
`Authorization: Bearer <sdk_key>` — the write-only SDK key issued per tenant.
The API verifies via `dp:auth:{key_hash}` Redis cache (same mechanism as the pipeline).

> Refresh tokens (opaque hex strings) are never accepted as access tokens.
> The middleware rejects any JWT whose `type` field is not `"access"`.

### Role permission matrix

| Action | superadmin | admin | editor | viewer |
|--------|------------|-------|--------|--------|
| All read endpoints (sessions, analytics, alerts, security, rules, channels) | yes | yes | yes | yes |
| `PUT /v1/alerts/:id/status` — acknowledge / resolve | yes | yes | yes | no |
| `POST /v1/control/kill-switch` — `POST /v1/control/interrupt` | yes | yes | yes | no |
| `POST/PUT /v1/rules` — create/edit rules | yes | yes | yes | no |
| `POST/PUT /v1/channels` — create/edit channels | yes | yes | no | no |
| `GET /v1/users` — list users | yes | yes | no | no |
| `POST /v1/users/invite` — invite/role/disable | yes | yes | no | no |
| `GET/PUT /v1/users/me` — own profile | yes | yes | yes | yes |
| `GET /v1/tenants` — list all tenants | yes | no | no | no |
| `POST /v1/tenants/onboard` — onboard new client | yes | no | no | no |
| `GET /v1/agents` — list agents | yes | yes | yes | yes |
| `POST /v1/agents` — create agent | yes | yes | no | no |
| `GET /v1/sdk-keys` — list SDK keys | yes | yes | yes | yes |
| `GET /v1/sdk-keys/:id/reveal` — reveal key prefix | yes | yes | no | no |

---

### Auth

All auth routes are public — no JWT required.

#### `POST /v1/auth/login`

```
Body:     { "email": "...", "password": "..." }
Response: { accessToken, refreshToken, expiresIn: 900, user: { userId, tenantId, email, name, role } }
Errors:   401 INVALID_CREDENTIALS (wrong password or disabled account — same shape, timing-safe)
          429 RATE_LIMITED (10 attempts per email per 15 min)
```

#### `POST /v1/auth/refresh`

```
Body:     { "refreshToken": "<hex>" }
Response: same shape as /login — rotated tokens
Behavior: old refresh token revoked on use. Replaying a consumed token → 401.
Errors:   401 INVALID_REFRESH_TOKEN
```

#### `POST /v1/auth/logout`

```
Body:     { "refreshToken": "<hex>" }
Response: { "ok": true }
Note:     Always 200 — never leaks whether token was valid.
```

#### `POST /v1/auth/forgot-password`

```
Body:     { "email": "..." }
Response: { "ok": true, "message": "If that email exists..." }
Note:     Always 200 — never leaks whether email exists.
Rate:     5 requests per email per hour.
```

#### `POST /v1/auth/reset-password`

```
Body:     { "token": "<hex>", "password": "<min 8 chars>" }
Response: { "ok": true }
Behavior: Revokes all active sessions in the same transaction.
Errors:   400 INVALID_RESET_TOKEN (bad/expired/already-used token)
```

#### `POST /v1/auth/accept-invite`

```
Body:     { "token": "<hex>", "name": "...", "password": "<min 8 chars>" }
Response: same shape as /login (auto-logged in after accepting)
Errors:   400 INVALID_INVITE_TOKEN, 409 EMAIL_EXISTS
```

---

### Users

All user routes require a valid access token.

#### `GET /v1/users` — admin only

```
Query: page, limit (max 100), status ('active'|'disabled')
Response: { data: UserSummary[], pagination: { page, limit, total, pages } }
```

#### `GET /v1/users/me` — any role

```
Response: UserSummary (no passwordHash)
```

#### `PUT /v1/users/me` — any role

```
Body: { name?, currentPassword?, newPassword? }
Note: Password change requires both fields; revokes all refresh tokens.
Errors: 400 INVALID_CURRENT_PASSWORD
```

#### `POST /v1/users/invite` — admin only

```
Body:     { "email": "...", "role": "editor" }
Response: 201 InviteSummary
Errors:   409 EMAIL_EXISTS | INVITE_PENDING
```

#### `GET /v1/users/invites` — admin only

```
Response: { invites: InviteSummary[] }
```

#### `DELETE /v1/users/invites/:id` — admin only

```
Response: { "ok": true }
Errors:   404 if invite not found or not pending
```

#### `PUT /v1/users/:id/role` — admin only

```
Body:     { "role": "admin"|"editor"|"viewer" }
Response: UserSummary
Errors:   400 FORBIDDEN (cannot change own role), 404 user not found
```

#### `PUT /v1/users/:id/status` — admin only

```
Body:     { "status": "active"|"disabled" }
Response: UserSummary
Behavior: Disabling revokes all refresh tokens for the user.
Errors:   400 FORBIDDEN (cannot disable self), 404 user not found
```

---

### Agents

#### `GET /v1/agents` — viewer+

```
Response: AgentSummary[]
  [ { agentId, tenantId, name, latestVersion, createdAt, updatedAt } ]
  Returns [] if no agents exist. Always scoped to caller's tenant from JWT.
```

#### `POST /v1/agents` — admin only

```
Body:     { "name": "support-bot", "latestVersion": "1.0.0" }
Response: 201 AgentSummary
Errors:   400 name missing, 403 not admin, 409 name already exists for tenant
```

---

### SDK Keys

#### `GET /v1/sdk-keys` — viewer+

```
Response: SdkKeySummary[]
  [ { keyId, name, maskedKey: "dp_sk_••••••••••••••••", enabled, createdAt, lastUsedAt } ]
  maskedKey is always fully masked — prefix is never exposed here.
  Returns [] if no keys exist.
```

#### `GET /v1/sdk-keys/:keyId/reveal` — admin only

```
Response: { "key": "dp_sk_a1b2c3d4..." }
  Returns the full plaintext key (raw_key) stored at creation time.
  Viewer/editor → 403. Key predating migration 009 → { "key": null }.
Errors:   403 not admin, 404 key not found or not in tenant
```

---

### Tenants

#### `GET /v1/tenants/:id` — superadmin or own tenant

```
Response: TenantListItem (same shape as list items)
Errors:   403 if caller is not superadmin and :id != caller's own tenant_id
          404 if tenant not found
```

#### `GET /v1/tenants` — superadmin only

```
Response: TenantListItem[]
  [ { tenantId, name, enabled, tokenBudget, rateLimit, createdAt, updatedAt,
      adminUser: { name, email } | null, userCount: number } ]
  adminUser is null if no active admin exists for the tenant.
  Returns [] if no tenants exist.
```

#### `POST /v1/tenants/onboard` — superadmin only

Creates a new tenant and its first admin user atomically. Both inserts are wrapped in a single transaction — if either fails, both are rolled back.

```
Body:
  {
    "tenant": { "name": "Acme Corp", "tokenBudget": 1000000, "rateLimit": 60 },
    "admin":  { "email": "admin@acme.com", "name": "Jane Smith", "password": "s3cur3P@ss!" }
  }

Response 201:
  { "tenant": { tenantId, name, enabled, tokenBudget, rateLimit, createdAt, updatedAt },
    "admin":  { userId, email, name, role: "admin", createdAt },
    "sdkKey": "dp_live_a1b2c3..." }

Errors:
  400  Validation error (missing/invalid fields)
  401  Missing or expired token
  403  Caller is not superadmin
  409  Tenant name already exists
  500  Unexpected server error
```

All three operations (tenant, admin user, SDK key) are wrapped in a single transaction — any failure rolls back all three.

`sdkKey` is the raw key — shown **once only**. Only the SHA-256 hash is stored in `sdk_keys`. `tokenBudget` and `rateLimit` are optional — `null` means unlimited.

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
Query params: page, limit, severity, status, ruleId, agentId, since, until,
              source ('security' | 'policy')
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

#### OWASP LLM Top 10 findings surfaced

| Signal(s) | OWASP ID | Threat | Detection phase |
|---|---|---|---|
| INJ-001 – INJ-005 | LLM01 | Prompt injection | Online — regex + tenant blocklist |
| OUT-001 | LLM02 | Insecure output handling | Online — LCS passthrough ratio |
| L-10 | LLM04 | Model denial of service | Post-session — token spike (>4σ) |
| PII-001 – PII-006 | LLM06 | Sensitive info disclosure | Online — PII scanner |
| L-06 | LLM07 | Insecure plugin design | Post-session — tool scope check |
| L-05, L-06, L-07 | LLM08 | Excessive agency | Post-session |
| L-08 | LLM09 | Overreliance | Post-session — HITL gap |
| L-09 | LLM10 | Model theft | Post-session — cross-session probe |

#### Risk score model

10 signals, additive, capped at 100. Scoring runs within ~30s of `graph_end`.

| Signal | Max pts | Trigger |
|--------|---------|---------|
| L-01 | 40 | Confirmed injection (INJ-001/002) |
| L-02 | 20 | Indirect injection vector (INJ-004) |
| L-03 | 30 | Output passthrough to tool (OUT-001) |
| L-04 | 35 | PII in LLM or tool output |
| L-05 | 20 | Tool call count > p90 baseline |
| L-06 | 25 | Tool invoked outside declared manifest |
| L-07 | 30 | Write/delete tool on read-only intent session |
| L-08 | 15 | High-stakes action without HITL interrupt |
| L-09 | 10 | Cross-session model theft probe |
| L-10 | 10 | Token count > 4σ above agent baseline |

| Band | Score | Alert behaviour |
|------|-------|-----------------|
| `clean` | 0–19 | Logged only |
| `low` | 20–39 | Logged only |
| `medium` | 40–64 | Warning alert (platform inbox) |
| `high` | 65–84 | Critical alert → webhook / Slack / PD |
| `critical` | 85–100 | Critical alert → all channels |

#### TypeScript types (`src/types/security.ts`)

```typescript
type RiskBand = 'clean' | 'low' | 'medium' | 'high' | 'critical'

interface SessionRiskScore {
  sessionId: string; tenantId: string; agentId: string | null
  riskScore: number          // 0–100
  riskBand: RiskBand
  signalCount: number
  signalIds: string[]        // ["L-01", "L-03", "L-04"]
  scorerVersion: string; scoredAt: string
}

interface SecurityFinding {
  findingId: string; sessionId: string; eventId: string; eventType: string
  signalId: string           // INJ-001, OUT-001, PII-004, L-06, etc.
  sigType: string            // injection | passthrough | pii | agency | tool_scope
  owaspId: string            // LLM01 … LLM10
  severity: 'critical' | 'warning' | 'info'
  matchedText: string | null // always redacted before storage
  detail: string | null
  scoreContrib: number
  detectionPhase: 'online' | 'post_session'
  createdAt: string
}

interface SecurityOverview {
  window: string; sessionsScored: number; highCriticalCount: number
  avgRiskScore: number; topSignalId: string | null; topSignalCount: number
  bandDistribution: Record<RiskBand, number>
  owaspFrequency: Array<{ owaspId: string; count: number }>
  highRiskSessions: Array<{ sessionId: string; agentId: string; riskScore: number; riskBand: RiskBand; signalIds: string[] }>
}

interface RemediationCard {
  signalId: string; owaspId: string; title: string; description: string
  fixSteps: string[]; sdkSnippet: string | null
  frequency: number   // how many times this signal fired in the window
}
```

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

#### `GET /v1/security/agents`

```
Response: { agents: AgentSecuritySummary[] }
  Top agents ranked by composite risk score. Cached 120s.
```

#### `GET /v1/security/agents/:id`

```
Response: AgentSecurityProfile — full security profile for a single agent
          404 if no security data exists for this agent yet
Cached: 300s
```

#### `GET /v1/security/signals`

```
Response: { signals: SignalRegistryEntry[] }
  Full signal registry (121 non-excluded sub-checks). Cached 300s.
```

#### `GET /v1/security/agents/:id/subcheck-config`

```
Response: { overrides: Record<subCheckId, { online_detection: boolean }> }
  Per-subcheck online detection toggle map for this agent.
  Empty object if no overrides set.
```

#### `PUT /v1/security/agents/:id/subcheck-config`

```
Body:     { "subCheckId": "INJ-001.1", "online_detection": true }
Response: { ok: true, subCheckId, online_detection }
Side effects: invalidates dp:sec:{tenantId}:agent:{agentId}:cfg in Redis
```

#### `GET /v1/security/agents/:id/alert-config`

```
Response: { composite_threshold, llm_composite_threshold, asi_composite_threshold,
            signal_thresholds: Record<signalId, number> }
  Composite and per-signal alert thresholds. NULL = use platform default (60).
```

#### `PUT /v1/security/agents/:id/alert-config`

```
Accepted body shapes (one per request):
  { composite_threshold: number }                    — shared fallback (1–100)
  { llm_composite_threshold: number | null }         — LLM-only (null = reset to default)
  { asi_composite_threshold: number | null }         — ASI-only (null = reset to default)
  { signal_id: string, threshold: number | null }    — per-signal (null = reset)

Response: { ok: true }
Side effects: invalidates dp:sec:{tenantId}:agent:{agentId}:cfg in Redis
Errors:   400 if body shape is invalid or threshold out of range
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

All migrations are idempotent (`IF NOT EXISTS`). Run with `pnpm migrate` in order.

| File | What it does |
|------|-------------|
| `migrations/001_tenants.sql` | Creates `tenants` + `sdk_keys` tables |
| `migrations/002_agents.sql` | Creates `agents` table |
| `migrations/003_channels_table.sql` | Creates the `channels` config table (API-owned) |
| `migrations/004_users_table.sql` | Creates `users` with role (`superadmin`\|`admin`\|`editor`\|`viewer`), nullable `tenant_id` for superadmin users |
| `migrations/005_invites_table.sql` | Creates `invites` with partial unique index for pending invites |
| `migrations/006_password_resets_table.sql` | Creates `password_resets` for 1-hour reset tokens |
| `migrations/007_refresh_tokens_table.sql` | Creates `refresh_tokens` for revocable refresh tokens |
| `migrations/008_sdk_keys_raw.sql` | Adds `masked_key` + `raw_key` to `sdk_keys` for Settings page key management |

> The `alerts` table and its `status`/`resolved_at` columns are owned by `dapplepot_pipeline` — that migration lives there.
> Superadmin users have `tenant_id = NULL` — they are platform-level operators, not scoped to any tenant.

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
pnpm seed-superadmin    # seed platform superadmin (superadmin@dapplepot.dev / superadmin123)
pnpm seed-admin         # seed dapplepot_dev tenant + admin user (admin@dapplepot.dev / changeme123)
```

---

## For IDE agents

Read `AGENT.md` in full before writing any code. It contains:
- All endpoint definitions with exact query parameter specs (sessions, analytics, alerts, control, rules, channels, security, auth, users)
- Full SQL for every query (stitch, analytics, trace cursor, sessions list, rules, channels, users, invites, refresh tokens)
- All TypeScript response types with field-level comments
- The stitcher pattern for parallel PG + CH fan-out
- SSE implementation for the live session feed
- SDK command poll implementation (`GET /v1/control/commands`)
- Kill-switch and interrupt control flows
- Auth system: JWT structure, refresh token rotation, role permission matrix, email abstraction
- Build order across all source files
- Locked architecture decisions with reasons
- ClickHouse aggregate table schemas
- All schema migration SQL (001–006)
