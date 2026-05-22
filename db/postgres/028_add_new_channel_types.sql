-- Drop legacy constraints
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_channel_type_check;
ALTER TABLE alert_deliveries DROP CONSTRAINT IF EXISTS alert_deliveries_channel_check;
ALTER TABLE tenant_notification_channels DROP CONSTRAINT IF EXISTS tenant_notification_channels_channel_type_check;

-- Add updated constraints supporting new channel types
ALTER TABLE channels ADD CONSTRAINT channels_channel_type_check CHECK (channel_type IN ('webhook', 'slack', 'pagerduty', 'msteams', 'email', 'mobile'));
ALTER TABLE alert_deliveries ADD CONSTRAINT alert_deliveries_channel_check CHECK (channel IN ('webhook', 'slack', 'pagerduty', 'msteams', 'email', 'mobile'));
ALTER TABLE tenant_notification_channels ADD CONSTRAINT tenant_notification_channels_channel_type_check CHECK (channel_type IN ('webhook', 'slack', 'pagerduty', 'msteams', 'email', 'mobile'));
