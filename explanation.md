# dapplepot-api — What is this and how does it work?

## The one-line version

This is the backend server that sits in the middle of everything. The SDK sends events to it, it stores them, and the UI reads from it. It's also the thing that forwards events to the security engine for analysis.

---

## Why does this exist?

The SDK running inside your agent can't write directly to ClickHouse or Postgres — that would mean every agent deployment needs database credentials, which is a security nightmare. Instead, the SDK sends events to this API over HTTP with just an SDK key, and this API handles all the database writes.

It also serves the React dashboard with all the data it needs — sessions, analytics, security findings, alerts, etc.

---

## How it actually works

### The write path (ingest)

When your agent does something, the SDK sends a batch of events to `POST /v1/ingest/events`. This is the most important endpoint in the whole system.

When that request comes in, three things happen in parallel:

1. **ClickHouse** — the full event batch gets bulk-inserted into `obs_events`. This is the raw event log, used for analytics and for the security engine to replay later.

2. **Postgres** — each event is checked to see if it should update the session state. A session goes `open → finalised` when a `session_end` event arrives, or `open → terminated` on `session_error`. This uses a `SELECT FOR UPDATE` lock so concurrent events don't corrupt the state.

3. **Security service** — a subset of events (`session_start`, `session_end`, `session_error`, and any `security_finding` events from the SDK's online checks) get forwarded to `dapplepot-security` via HTTP. This is fire-and-forget — if the security service is down, ingest still succeeds.

### The read path (dashboard)

The UI calls REST endpoints to get:
- Session lists and detail views
- Analytics (token usage, error rates, latency, cost)
- Security findings and risk scores
- Alerts and notification channels
- Agent registry and config

There's also a live session feed via SSE (`GET /v1/sessions/live`) that the Overview page uses to show sessions appearing in real time without polling.

---

## The two databases and why both exist

**ClickHouse** is used for everything that involves scanning large amounts of event data — analytics queries, the event timeline in session detail, and the raw event replay that the security engine uses for post-session scoring. It's fast at this because it's a columnar database built for analytics.

**Postgres** is used for everything that needs strong consistency — sessions, users, tenants, SDK keys, alerts, agent config. Things where you need transactions and foreign keys.

---

## The files and what they do

- `src/routes/ingest.ts` — the 3-way fanout. This is the most critical file.
- `src/lib/session-writer.ts` — the session state machine. Handles the `open → finalised/terminated` transitions with locking.
- `src/lib/event-appender.ts` — the ClickHouse bulk insert. Also has a rolling dedup window (60s) to handle duplicate events.
- `src/lib/security-client.ts` — the HTTP forward to `dapplepot-security`. Filters to only the relevant event types, 5s timeout, never fails the ingest request.
- `src/routes/` — one file per resource (sessions, analytics, security, alerts, agents, etc.)
- `src/middleware/auth.ts` — JWT verification for dashboard requests, SDK key lookup for ingest requests.
- `db/postgres/` — 21 migration files that define the full Postgres schema.
- `db/clickhouse/` — 4 migration files for the ClickHouse schema.

---

## Where this fits in the bigger picture

```
dapplepot-sdk          ← sends events here
    ↓ (HTTP POST /v1/ingest/events)
dapplepot-api          ← you are here
    ↓ (writes to)           ↓ (forwards to)
ClickHouse + Postgres   dapplepot-security
    ↑ (reads from)
dapplepot-ui
```

---

## A note on the security forwarding

The API doesn't do any security analysis itself — it just forwards events to `dapplepot-security`. The reason for this separation is that security analysis is computationally heavier and runs asynchronously after a session ends. Keeping it in a separate service means a slow scoring job doesn't affect ingest latency.
