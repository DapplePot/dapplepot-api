import { describe, it, expect } from 'vitest'
import { makeJwt } from './auth.test.js'
import app from '../../src/app.js'

const TENANT_ID = '00000000-0000-0000-0000-000000000001'

function authHeaders() {
  return { Authorization: `Bearer ${makeJwt(TENANT_ID)}` }
}

describe('GET /v1/alerts', () => {
  it('returns paginated shape', async () => {
    const res = await app.request('/v1/alerts', { headers: authHeaders() })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('data')
    expect(body).toHaveProperty('total')
    expect(Array.isArray(body['data'])).toBe(true)
  })
})

describe('GET /v1/alerts/stats', () => {
  it('returns stats shape', async () => {
    const res = await app.request('/v1/alerts/stats', { headers: authHeaders() })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('window')
  })
})

describe('GET /v1/alerts/:id', () => {
  it('returns 404 for non-existent alert', async () => {
    const res = await app.request(
      '/v1/alerts/00000000-0000-0000-0000-000000000000',
      { headers: authHeaders() }
    )
    expect(res.status).toBe(404)
  })
})

describe('PUT /v1/alerts/:id/status', () => {
  it('returns 400 for invalid status value', async () => {
    const res = await app.request(
      '/v1/alerts/00000000-0000-0000-0000-000000000000/status',
      {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'invalid-status' }),
      }
    )
    expect(res.status).toBe(400)
  })
})
