CREATE TABLE IF NOT EXISTS alert_deliveries (
    delivery_id       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id          UUID        NOT NULL REFERENCES alerts(alert_id) ON DELETE CASCADE,
    channel           TEXT        NOT NULL CHECK (channel IN ('webhook', 'slack', 'pagerduty')),
    status            TEXT        NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending', 'delivered', 'failed')),
    attempt_count     INT         NOT NULL DEFAULT 0,
    last_attempted_at TIMESTAMPTZ,
    delivered_at      TIMESTAMPTZ,
    error_message     TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
