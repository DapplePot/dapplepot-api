ALTER TABLE audit_archives
    ADD COLUMN IF NOT EXISTS s3_bucket TEXT,
    ADD COLUMN IF NOT EXISTS s3_key    TEXT;

ALTER TABLE audit_archives
    DROP COLUMN IF EXISTS payload;
