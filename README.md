# dapplepot-api

Platform API for DapplePot. Ingests events from the SDK, persists to Postgres + ClickHouse, evaluates with the security service, and serves the dashboard. Also handles auth, billing (Lemon Squeezy), tenant lifecycle, audit archives, and email.

**Stack:** TypeScript (strict), Node.js 22, Hono 4, postgres.js, @clickhouse/client, ioredis, Zod, pnpm.

## Quick Start

```bash
pnpm install
cp .env.example .env       # fill in connection strings + secrets
pnpm migrate               # Postgres schema (db/postgres/*.sql)
pnpm migrate-clickhouse    # ClickHouse schema (db/clickhouse/*.sql)
pnpm seed-superadmin       # create the platform superadmin
pnpm dev                   # → http://localhost:3000
```

## Required env vars

See `.env.example` for the full set. The minimum to boot:

- `POSTGRES_URL` — `postgresql://user:pass@host:5432/db`
- `CLICKHOUSE_HOST` / `CLICKHOUSE_PORT` / `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD`
- `REDIS_URL` — `redis://localhost:6379`
- `DAPPLEPOT_JWT_SECRET`
- `INTERNAL_API_SECRET` — shared with `dapplepot-security`
- `AUDIT_S3_BUCKET` + AWS credentials (instance profile, env vars, or `AWS_ENDPOINT_URL` for MinIO)
- `GCS_*` — Google Cloud Storage credentials (blogs media)

To enable billing (Lemon Squeezy):
- `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_WEBHOOK_SECRET`
- `LEMONSQUEEZY_VARIANT_PRO_MONTHLY` / `PRO_ANNUAL` / `TEAM_MONTHLY` / `TEAM_ANNUAL` (variant IDs, not product IDs)

Email provider (`DAPPLEPOT_EMAIL_PROVIDER=console|smtp|resend`) plus the matching `SMTP_*` or `RESEND_API_KEY` envs.

Dev escape hatch: `DISABLE_AUTH_RATE_LIMIT=1` turns off auth rate limits.

## Layout

```
src/
  app.ts                 Hono app — middleware + route mount (src/routes/index.ts)
  index.ts               HTTP server entry
  env.ts                 Zod-validated env shape
  routes/                One file per /v1/* mount (auth, ingest, sessions, billing, …)
  queries/               DB query layer (*.pg.ts for Postgres, *.ch.ts for ClickHouse)
  lib/                   Cross-cutting: lemonsqueezy, planLimits, usageTracker,
                         session-writer, event-appender, auth-tokens, email/, …
  middleware/            jwtAuth, requireRole, requireWritableTenant, etc.
  stitchers/             Event → session correlation
  types/                 Shared types (copied into dapplepot-ui via `pnpm sync-types`)
db/
  postgres/              Versioned SQL migrations (NNN_name.sql)
  clickhouse/            Bulk-event table schemas
scripts/                 Operational scripts (see below)
```

## Mounted routes

All under `/v1` unless noted. See `src/routes/` for handlers.

```
auth   users   tenants   agents   sdk-keys   ingest   sessions   analytics
alerts   control   channels   security   sdk/security   sdk/seq   audit
llm-models   tools   mcp-servers   internal   blogs   me   leads   billing
/admin   (superadmin-only routes)
```

## Operational scripts

```bash
pnpm migrate                                        # apply pending Postgres migrations
pnpm migrate-clickhouse                             # apply ClickHouse migrations
pnpm seed-superadmin                                # create the platform superadmin user
pnpm tsx scripts/seed_test_tenants.ts --reset      # seed 10 test tenants covering every lifecycle state

# Daily cron candidates
pnpm tsx scripts/close_billing_period.ts           # close expired billing periods
pnpm tsx scripts/lifecycle_transitions.ts          # active → readonly → suspended → deleted
pnpm tsx scripts/delete_expired_tenants.ts         # wipe data for tenants in 'deleted' state (supports DRY_RUN=1)
pnpm tsx scripts/send_nudges.ts                    # trial / lifecycle / quota emails
```

## Scripts

```bash
pnpm dev          # tsx watch
pnpm build        # tsc -p tsconfig.build.json → dist/
pnpm start        # node dist/index.js
pnpm test         # vitest (unit + integration)
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint
```

## Docker

```bash
docker build -t dapplepot-api .
docker run -p 3000:3000 --env-file .env dapplepot-api
```

Or `docker-compose up` for the local dev stack.
