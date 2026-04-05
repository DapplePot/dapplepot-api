import { queryRows, queryRow } from '../lib/postgres.js'

interface SdkKeyRow extends Record<string, unknown> {
    key_id: string
    name: string | null
    masked_key: string | null
    enabled: boolean
    created_at: Date | string
    last_used_at: Date | string | null
}

interface SdkKeyRawRow extends Record<string, unknown> {
    raw_key: string | null
}

export interface SdkKeySummary {
    keyId: string
    name: string | null
    maskedKey: string
    enabled: boolean
    createdAt: string
    lastUsedAt: string | null
}

// Fallback for keys created before migration 009
const MASKED_KEY_FALLBACK = 'dp_sk_' + '•'.repeat(26)

function toIso(d: Date | string): string {
    return d instanceof Date ? d.toISOString() : String(d)
}

export async function listSdkKeys(tenantId: string): Promise<SdkKeySummary[]> {
    const rows = await queryRows<SdkKeyRow>(
        `SELECT key_id, name, masked_key, enabled, created_at, last_used_at
         FROM sdk_keys
         WHERE tenant_id = $1
         ORDER BY created_at DESC`,
        [tenantId]
    )
    return rows.map((r) => ({
        keyId: r.key_id,
        name: r.name,
        maskedKey: r.masked_key ?? MASKED_KEY_FALLBACK,
        enabled: r.enabled,
        createdAt: toIso(r.created_at),
        lastUsedAt: r.last_used_at ? toIso(r.last_used_at) : null,
    }))
}

export async function revealSdkKey(
    tenantId: string,
    keyId: string
): Promise<string | null | undefined> {
    const row = await queryRow<SdkKeyRawRow>(
        `SELECT raw_key
         FROM sdk_keys
         WHERE key_id = $1 AND tenant_id = $2`,
        [keyId, tenantId]
    )
    if (!row) return undefined       // not found / wrong tenant
    return row.raw_key ?? null       // null = key predates migration 009
}
