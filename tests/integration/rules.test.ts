import { describe, it, expect } from 'vitest'
import { makeJwt } from './auth.test.js'
import app from '../../src/app.js'

const TENANT_ID = '00000000-0000-0000-0000-000000000001'

function authHeaders() {
  return { Authorization: `Bearer ${makeJwt(TENANT_ID)}` }
}

describe('GET /v1/rules', () => {
  it('returns an array', async () => {
    const res = await app.request('/v1/rules', { headers: authHeaders() })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })
})

describe('PUT /v1/rules/:id', () => {
  it('returns 404 for non-existent rule', async () => {
    const res = await app.request(
      '/v1/rules/00000000-0000-0000-0000-000000000000',
      {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }
    )
    expect(res.status).toBe(404)
  })
})
