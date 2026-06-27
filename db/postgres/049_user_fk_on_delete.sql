-- DELETE /v1/users/:id was failing with 500 because three tables added in
-- Phases 3, 5, and 7.5 hold FK references to users(user_id) without an
-- ON DELETE handler. Postgres defaults to NO ACTION, which blocks the
-- delete whenever any of these tables has a row pointing at the user.
--
-- The right semantics for each:
--   admin_audit_log         — forensic record, never cascade. Keep the row
--                              but null out the actor when their user is
--                              deleted. Requires actor_user_id to be nullable.
--   upgrade_requests        — created by a user but lives at tenant scope.
--                              Same logic: null out the requester reference,
--                              preserve the request history. fulfilled_by
--                              same logic.
--   enterprise_leads        — assigned_to_user_id is a soft pointer. SET NULL
--                              so deleting a sales rep doesn't lose the lead.
--
-- All three FKs are altered in-place by dropping + re-adding the constraint.

-- ── admin_audit_log.actor_user_id ────────────────────────────────────────
ALTER TABLE admin_audit_log
    ALTER COLUMN actor_user_id DROP NOT NULL;

ALTER TABLE admin_audit_log
    DROP CONSTRAINT IF EXISTS admin_audit_log_actor_user_id_fkey;

ALTER TABLE admin_audit_log
    ADD  CONSTRAINT admin_audit_log_actor_user_id_fkey
         FOREIGN KEY (actor_user_id) REFERENCES users(user_id) ON DELETE SET NULL;


-- ── upgrade_requests.requested_by_user_id ────────────────────────────────
ALTER TABLE upgrade_requests
    ALTER COLUMN requested_by_user_id DROP NOT NULL;

ALTER TABLE upgrade_requests
    DROP CONSTRAINT IF EXISTS upgrade_requests_requested_by_user_id_fkey;

ALTER TABLE upgrade_requests
    ADD  CONSTRAINT upgrade_requests_requested_by_user_id_fkey
         FOREIGN KEY (requested_by_user_id) REFERENCES users(user_id) ON DELETE SET NULL;


-- ── upgrade_requests.fulfilled_by_user_id (already nullable) ─────────────
ALTER TABLE upgrade_requests
    DROP CONSTRAINT IF EXISTS upgrade_requests_fulfilled_by_user_id_fkey;

ALTER TABLE upgrade_requests
    ADD  CONSTRAINT upgrade_requests_fulfilled_by_user_id_fkey
         FOREIGN KEY (fulfilled_by_user_id) REFERENCES users(user_id) ON DELETE SET NULL;


-- ── enterprise_leads.assigned_to_user_id (already nullable) ──────────────
ALTER TABLE enterprise_leads
    DROP CONSTRAINT IF EXISTS enterprise_leads_assigned_to_user_id_fkey;

ALTER TABLE enterprise_leads
    ADD  CONSTRAINT enterprise_leads_assigned_to_user_id_fkey
         FOREIGN KEY (assigned_to_user_id) REFERENCES users(user_id) ON DELETE SET NULL;
