-- Target table must be created BEFORE the materialized view
CREATE TABLE IF NOT EXISTS obs_llm_hourly (
    tenant_id         LowCardinality(String),
    agent_id          LowCardinality(String),
    llm_model         LowCardinality(String),
    hour              DateTime,
    input_tokens_sum  AggregateFunction(sum, UInt64),
    output_tokens_sum AggregateFunction(sum, UInt64),
    latency_avg       AggregateFunction(avg, Float64),
    latency_p95       AggregateFunction(quantile(0.95), Float64),
    call_count        AggregateFunction(count, UInt8)
)
ENGINE = AggregatingMergeTree
ORDER BY (tenant_id, agent_id, llm_model, hour)
TTL hour + INTERVAL 365 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_obs_llm_hourly
TO obs_llm_hourly
AS
SELECT
    tenant_id,
    agent_id,
    llm_model,
    toStartOfHour(emitted_at)       AS hour,
    sumState(toUInt64(llm_input_tokens))   AS input_tokens_sum,
    sumState(toUInt64(llm_output_tokens))  AS output_tokens_sum,
    avgState(toFloat64(llm_latency_ms))    AS latency_avg,
    quantileState(0.95)(toFloat64(llm_latency_ms)) AS latency_p95,
    countState()                    AS call_count
FROM obs_events
WHERE event_type = 'llm_end'
GROUP BY tenant_id, agent_id, llm_model, hour;
