import { describe, it, expect } from 'vitest'
import jwt from 'jsonwebtoken'
import app from '../../src/app.js'

const SECRET = process.env['DAPPLEPOT_JWT_SECRET'] ?? 'test-secret'
const TENANT_ID = '00000000-0000-0000-0000-000000000001'

export function makeJwt(tenantId = TENANT_ID, userId = 'user-1') {
  return jwt.sign({ tenant_id: tenantId, user_id: userId }, SECRET, { expiresIn: '1h' })
}

describe('auth middleware', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await app.request('/v1/sessions')
    const body = await res.json() as Record<string, unknown>
    expect(res.status).toBe(401)
    expect((body['error'] as Record<string, unknown>)['code']).toBe('UNAUTHORIZED')
  })

  it('returns 401 when token is malformed', async () => {
    const res = await app.request('/v1/sessions', {
      headers: { Authorization: 'Bearer not-a-valid-jwt' },
    })
    expect(res.status).toBe(401)
  })

  it('returns 401 when token is signed with wrong secret', async () => {
    const token = jwt.sign({ tenant_id: TENANT_ID, user_id: 'u1' }, 'wrong-secret')
    const res = await app.request('/v1/sessions', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(401)
  })

  it('passes auth with a valid JWT', async () => {
    const token = makeJwt()
    const res = await app.request('/v1/sessions', {
      headers: { Authorization: `Bearer ${token}` },
    })
    // 200 or 500 (infra down) — but not 401
    expect(res.status).not.toBe(401)
  })
})
