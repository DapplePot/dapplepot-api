-- Remove 'killed' and 'interrupted' session statuses (kill-switch and HITL gate features dropped).
-- Migrate any existing rows to 'terminated'.
UPDATE sessions SET status = 'terminated' WHERE status IN ('killed', 'interrupted');

ALTER TABLE sessions
    DROP CONSTRAINT IF EXISTS sessions_status_check;

ALTER TABLE sessions
    ADD CONSTRAINT sessions_status_check
    CHECK (status IN ('stub', 'open', 'finalised', 'terminated'));
