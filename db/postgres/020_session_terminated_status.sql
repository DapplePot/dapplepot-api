-- Add 'terminated' as a valid session status.
-- Used when a session ends due to a security violation (online sub-check with action = terminate_session).
ALTER TABLE sessions
    DROP CONSTRAINT IF EXISTS sessions_status_check;

ALTER TABLE sessions
    ADD CONSTRAINT sessions_status_check
    CHECK (status IN ('stub', 'open', 'finalised', 'terminated'));
