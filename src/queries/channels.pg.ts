import { queryRow, queryRows } from '../lib/postgres.js'
import type { DeliveryChannel } from '../types/channel.js'

function mapChannel(r: Record<string, unknown>): DeliveryChannel {
  return {
    channelId: r['channel_id'] as string,
    name: r['name'] as string,
    channelType: r['channel_type'] as DeliveryChannel['channelType'],
    enabled: r['enabled'] as boolean,
    config: r['config'] as DeliveryChannel['config'],
    createdAt: r['created_at'] instanceof Date
      ? (r['created_at'] as Date).toISOString()
      : String(r['created_at']),
    updatedAt: r['updated_at'] instanceof Date
      ? (r['updated_at'] as Date).toISOString()
      : String(r['updated_at']),
  }
}

export async function getChannelList(tenantId: string): Promise<DeliveryChannel[]> {
  const rows = await queryRows<Record<string, unknown>>(
    `SELECT channel_id, tenant_id, name, channel_type, enabled, config, created_at, updated_at
    FROM channels
    WHERE tenant_id = $1
    ORDER BY created_at DESC`,
    [tenantId]
  )
  return rows.map(mapChannel)
}

export async function createChannel(
  tenantId: string,
  data: {
    name: string
    channelType: string
    enabled: boolean
    config: Record<string, unknown>
  }
): Promise<DeliveryChannel> {
  const row = await queryRow<Record<string, unknown>>(
    `INSERT INTO channels (tenant_id, name, channel_type, enabled, config)
    VALUES ($1, $2, $3, $4, $5::jsonb)
    RETURNING channel_id, tenant_id, name, channel_type, enabled, config, created_at, updated_at`,
    [tenantId, data.name, data.channelType, data.enabled, JSON.stringify(data.config)]
  )
  if (!row) throw new Error('Failed to create channel')
  return mapChannel(row)
}

export async function updateChannel(
  tenantId: string,
  channelId: string,
  data: {
    name?: string
    enabled?: boolean
    config?: Record<string, unknown>
  }
): Promise<DeliveryChannel | undefined> {
  const row = await queryRow<Record<string, unknown>>(
    `UPDATE channels
    SET name       = COALESCE($3, name),
        enabled    = COALESCE($4, enabled),
        config     = COALESCE($5::jsonb, config),
        updated_at = NOW()
    WHERE channel_id = $1
      AND tenant_id  = $2
    RETURNING channel_id, tenant_id, name, channel_type, enabled, config, created_at, updated_at`,
    [
      channelId,
      tenantId,
      data.name ?? null,
      data.enabled ?? null,
      data.config ? JSON.stringify(data.config) : null,
    ]
  )
  if (!row) return undefined
  return mapChannel(row)
}
