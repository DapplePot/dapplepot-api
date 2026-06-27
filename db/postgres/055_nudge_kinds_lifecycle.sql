-- Expand the nudge_dispatch_log.nudge_kind allowlist with the new lifecycle
-- nudges added by Phase-7.5 cleanup + lifecycle redesign. Also keeps old
-- legacy kinds for backwards-compat — historical rows shouldn't break.

ALTER TABLE nudge_dispatch_log
    DROP CONSTRAINT IF EXISTS nudge_dispatch_log_nudge_kind_check;

ALTER TABLE nudge_dispatch_log
    ADD  CONSTRAINT nudge_dispatch_log_nudge_kind_check
         CHECK (nudge_kind IN (
            -- quota nudges
            'quota_80', 'quota_100',
            -- trial milestones (active set)
            'trial_day_25', 'trial_day_30',
            -- trial milestones (legacy — for historical rows only; no longer dispatched)
            'trial_day_7', 'trial_day_37',
            -- new lifecycle nudges (readonly / suspension / deletion)
            'lifecycle_readonly_warning_30d',
            'lifecycle_suspension_warning',
            'lifecycle_deletion_warning_30d',
            'lifecycle_deletion_imminent'
         ));
