import { describe, it, expect } from 'vitest'
import { makeJwt } from './auth.test.js'
import app from '../../src/app.js'

const TENANT_ID = '00000000-0000-0000-0000-000000000001'

function authHeaders() {
  return { Authorization: `Bearer ${makeJwt(TENANT_ID)}` }
}

const endpoints = [
  '/v1/analytics/overview',
  '/v1/analytics/llm-usage',
  '/v1/analytics/error-rates',
  '/v1/analytics/latency',
  '/v1/analytics/cost',
  '/v1/analytics/sessions/funnel',
]

describe('analytics endpoints', () => {
  for (const path of endpoints) {
    it(`GET ${path} returns 200`, async () => {
      const res = await app.request(path, { headers: authHeaders() })
      expect(res.status).toBe(200)
    })
  }

  it('GET /v1/analytics/overview returns expected fields', async () => {
    const res = await app.request('/v1/analytics/overview', { headers: authHeaders() })
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('totalSessions')
    expect(body).toHaveProperty('liveSessions')
  })

  it('GET /v1/analytics/sessions/funnel returns completionRate', async () => {
    const res = await app.request('/v1/analytics/sessions/funnel', { headers: authHeaders() })
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('completionRate')
    expect(body).toHaveProperty('window')
  })
})
