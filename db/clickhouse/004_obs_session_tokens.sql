CREATE TABLE IF NOT EXISTS obs_session_tokens (
    tenant_id         LowCardinality(String),
    session_id        UUID,
    input_tokens      UInt64,
    output_tokens     UInt64,
    total_tokens      UInt64,
    created_at        DateTime DEFAULT now()
)
ENGINE = SummingMergeTree((input_tokens, output_tokens, total_tokens))
ORDER BY (tenant_id, session_id)
TTL created_at + INTERVAL 90 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_obs_session_tokens
TO obs_session_tokens
AS
SELECT
    tenant_id,
    session_id,
    toUInt64(llm_input_tokens)  AS input_tokens,
    toUInt64(llm_output_tokens) AS output_tokens,
    toUInt64(llm_input_tokens + llm_output_tokens) AS total_tokens
FROM obs_events
WHERE event_type = 'llm_end';
