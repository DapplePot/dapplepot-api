-- Tool version for ASCV-01c suppression.
-- When set, a schema change accompanied by a version bump is treated as a
-- declared update and ASCV-01c is suppressed. NULL = strict mode (every
-- schema change fires regardless).

ALTER TABLE tools
  ADD COLUMN IF NOT EXISTS version TEXT;
