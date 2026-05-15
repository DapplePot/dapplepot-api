CREATE TABLE IF NOT EXISTS llm_models (
    model_id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              UUID        NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
    name                   TEXT        NOT NULL,
    provider               TEXT,
    context_window_tokens  INT,
    input_cost_per_1k      NUMERIC(10, 6),
    output_cost_per_1k     NUMERIC(10, 6),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);
