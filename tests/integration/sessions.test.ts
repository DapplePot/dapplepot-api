import { describe, it, expect } from 'vitest'
import { makeJwt } from './auth.test.js'
import app from '../../src/app.js'

const TENANT_ID = '00000000-0000-0000-0000-000000000001'

function authHeaders() {
  return { Authorization: `Bearer ${makeJwt(TENANT_ID)}` }
}

describe('GET /v1/sessions', () => {
  it('returns paginated shape', async () => {
    const res = await app.request('/v1/sessions', { headers: authHeaders() })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('data')
    expect(body).toHaveProperty('total')
    expect(body).toHaveProperty('page')
    expect(body).toHaveProperty('perPage')
    expect(body).toHaveProperty('totalPages')
    expect(Array.isArray(body['data'])).toBe(true)
  })

  it('respects limit query param', async () => {
    const res = await app.request('/v1/sessions?limit=5', { headers: authHeaders() })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body['perPage']).toBe(5)
  })
})

describe('GET /v1/sessions/:id', () => {
  it('returns 404 for non-existent session', async () => {
    const res = await app.request(
      '/v1/sessions/00000000-0000-0000-0000-000000000000',
      { headers: authHeaders() }
    )
    expect(res.status).toBe(404)
  })
})

describe('GET /v1/sessions/:id/trace', () => {
  it('returns 404 for non-existent session', async () => {
    const res = await app.request(
      '/v1/sessions/00000000-0000-0000-0000-000000000000/trace',
      { headers: authHeaders() }
    )
    expect(res.status).toBe(404)
  })
})
