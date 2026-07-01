-- Drop the enterprise_leads table.
--
-- The public "Contact Sales" form and its /v1/leads/contact-sales endpoint
-- were removed — Enterprise interest is now handled by a link out to the
-- dapplepot.com marketing site instead of an in-app lead capture form.
--
-- Dropping the table also drops its indexes and the FK constraint added in
-- migration 049 (enterprise_leads_assigned_to_user_id_fkey). The sibling
-- upgrade_requests table (created in the same 046 migration) stays — it
-- backs the in-app "Request Upgrade" flow which is still live.
--
-- Idempotent — re-running is a no-op.

DROP TABLE IF EXISTS enterprise_leads;
