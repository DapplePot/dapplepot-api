-- Agent profile fields — declared agent behaviour used by the post-session scorer.
-- NULL = auto (scorer uses heuristic fallback).
-- Non-NULL = manual declaration; heuristic is bypassed.
ALTER TABLE agent_alert_config
  ADD COLUMN IF NOT EXISTS system_prompt       TEXT,
  ADD COLUMN IF NOT EXISTS environment         TEXT
      CHECK (environment IS NULL OR environment IN ('production', 'staging')),
  ADD COLUMN IF NOT EXISTS irreversible_tools  JSONB,
  ADD COLUMN IF NOT EXISTS network_allowlist   JSONB,
  ADD COLUMN IF NOT EXISTS working_directory   TEXT,
  ADD COLUMN IF NOT EXISTS write_namespace     TEXT,
  ADD COLUMN IF NOT EXISTS operating_hours     JSONB,
  ADD COLUMN IF NOT EXISTS sbom_allowlist      JSONB,
  ADD COLUMN IF NOT EXISTS mcp_endpoints       JSONB;
