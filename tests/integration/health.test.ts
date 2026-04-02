import { describe, it, expect } from 'vitest'
import app from '../../src/app.js'

describe('GET /health', () => {
  it('returns 200 with service status fields', async () => {
    const res = await app.request('/health')
    const body = await res.json() as Record<string, unknown>

    expect(res.status).toBe(200)
    expect(body).toHaveProperty('status')
    expect(body).toHaveProperty('postgres')
    expect(body).toHaveProperty('clickhouse')
    expect(body).toHaveProperty('redis')
  })
})
