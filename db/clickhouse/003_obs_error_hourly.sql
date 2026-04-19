CREATE TABLE IF NOT EXISTS obs_error_hourly (
    tenant_id    LowCardinality(String),
    agent_id     LowCardinality(String),
    node_name    LowCardinality(String),
    event_type   LowCardinality(String),
    hour         DateTime,
    error_count  UInt64,
    total_count  UInt64
)
ENGINE = SummingMergeTree((error_count, total_count))
ORDER BY (tenant_id, agent_id, node_name, event_type, hour)
TTL hour + INTERVAL 365 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_obs_error_hourly
TO obs_error_hourly
AS
SELECT
    tenant_id,
    agent_id,
    node_name,
    event_type,
    toStartOfHour(emitted_at) AS hour,
    countIf(event_type IN ('node_error', 'llm_error', 'tool_error')) AS error_count,
    count()                   AS total_count
FROM obs_events
WHERE event_type IN ('node_start', 'node_error', 'llm_start', 'llm_error', 'tool_start', 'tool_error')
GROUP BY tenant_id, agent_id, node_name, event_type, hour;
