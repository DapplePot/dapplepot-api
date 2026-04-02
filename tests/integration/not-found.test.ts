import { describe, it, expect } from 'vitest'
import app from '../../src/app.js'

describe('unknown routes', () => {
  it('returns 404 with NOT_FOUND code', async () => {
    const res = await app.request('/v1/does-not-exist')
    const body = await res.json() as Record<string, unknown>
    expect(res.status).toBe(404)
    expect((body['error'] as Record<string, unknown>)['code']).toBe('NOT_FOUND')
  })
})
