-- Tracks which migration version each service has applied to this shared database.
-- dapplepot_security reads this at startup to verify schema compatibility.
CREATE TABLE IF NOT EXISTS schema_version (
    service     TEXT        NOT NULL,
    version     INTEGER     NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (service)
);

INSERT INTO schema_version (service, version)
VALUES ('dapplepot_api', 21)
ON CONFLICT (service) DO UPDATE
    SET version    = EXCLUDED.version,
        applied_at = now();
