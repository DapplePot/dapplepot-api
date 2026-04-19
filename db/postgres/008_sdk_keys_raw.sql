-- Adds masked_key + raw_key to sdk_keys for the Settings page SDK key management.
-- masked_key: pre-built masked string shown to all roles (e.g. "dp_sk_••••••••••••••••••••••••••")
-- raw_key:    full plaintext key returned to admin on reveal — stored since key_hash is one-way
ALTER TABLE sdk_keys
  ADD COLUMN IF NOT EXISTS masked_key TEXT,
  ADD COLUMN IF NOT EXISTS raw_key    TEXT;
