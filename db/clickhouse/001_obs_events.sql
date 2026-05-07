CREATE TABLE IF NOT EXISTS obs_events (
    event_id          UUID,
    session_id        UUID,
    run_id            UUID,
    node_run_id       UUID,
    llm_run_id        UUID,
    tool_run_id       UUID,
    tenant_id         LowCardinality(String),
    agent_id          LowCardinality(String),
    agent_version     LowCardinality(String),
    environment       LowCardinality(String),
    deployment_id     LowCardinality(String),
    user_context_id   LowCardinality(String),
    event_type        LowCardinality(String),
    event_category    LowCardinality(String),
    schema_version    LowCardinality(String),
    sdk_version       LowCardinality(String),
    emitted_at        DateTime64(3, 'UTC'),
    hook_fired_at     DateTime64(3, 'UTC'),
    buffer_wait_ms    UInt32,
    sequence_index    UInt32,
    batch_id          UUID,
    batch_index       UInt16,
    retry_attempt     UInt8,
    payload           String    CODEC(ZSTD(3)),
    -- hot fields extracted from payload (never NULL — use '' or 0)
    node_name         LowCardinality(String),
    node_status       LowCardinality(String),
    llm_model         LowCardinality(String),
    llm_input_tokens  UInt32,
    llm_output_tokens UInt32,
    llm_latency_ms    UInt32,
    tool_name         LowCardinality(String),
    tool_status       LowCardinality(String),
    tool_latency_ms   UInt32,
    error_code        LowCardinality(String),
    error_message     String    CODEC(ZSTD(1))
)
ENGINE = ReplacingMergeTree()
ORDER BY   (tenant_id, toStartOfHour(emitted_at), session_id, sequence_index)
PARTITION BY (tenant_id, toYYYYMM(emitted_at))
TTL        toDateTime(emitted_at) + INTERVAL 90 DAY
SETTINGS   index_granularity = 8192, merge_with_ttl_timeout = 3600;

ALTER TABLE obs_events ADD INDEX IF NOT EXISTS idx_session_bloom session_id TYPE bloom_filter(0.01) GRANULARITY 4;
ALTER TABLE obs_events ADD INDEX IF NOT EXISTS idx_event_type_set event_type TYPE set(25) GRANULARITY 1;
ALTER TABLE obs_events ADD INDEX IF NOT EXISTS idx_emitted_minmax emitted_at TYPE minmax GRANULARITY 1;
