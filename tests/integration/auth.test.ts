import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import app from '../../src/app.js'

const SECRET = process.env['DAPPLEPOT_JWT_SECRET'] ?? 'test-secret'
const TENANT_ID = '00000000-0000-0000-0000-000000000001'

// ── JWT helper shared by other test files ────────────────────────────────────

export function makeJwt(tenantId = TENANT_ID, userId = 'user-1') {
  return jwt.sign({ tenant_id: tenantId, user_id: userId }, SECRET, { expiresIn: '1h' })
}

export function makeJwtWithRole(tenantId: string, userId: string, role: 'admin' | 'editor' | 'viewer') {
  return jwt.sign({ tenant_id: tenantId, user_id: userId, role, type: 'access' }, SECRET, { expiresIn: '1h' })
}

// ── Test user seeded into the DB for auth route tests ────────────────────────

const TEST_USER_ID = '00000000-0000-4000-8000-000000000099'
const TEST_EMAIL = 'auth-test@dapplepot.dev'
const TEST_PASSWORD = 'test-password-123'
let testPasswordHash = ''
let dbAvailable = false

async function seedTestUser() {
  try {
    const { sql } = await import('../../src/lib/postgres.js')
    testPasswordHash = bcrypt.hashSync(TEST_PASSWORD, 4) // cost 4 for test speed
    await sql`
      INSERT INTO users (user_id, tenant_id, email, name, password_hash, role, status)
      VALUES (
        ${TEST_USER_ID}::uuid,
        ${TENANT_ID}::uuid,
        ${TEST_EMAIL},
        ${'Auth Test User'},
        ${testPasswordHash},
        ${'admin'},
        ${'active'}
      )
      ON CONFLICT ON CONSTRAINT uq_users_tenant_email
      DO UPDATE SET password_hash = ${testPasswordHash}, role = 'admin', status = 'active'
    `
    dbAvailable = true
  } catch {
    dbAvailable = false
  }
}

async function cleanupTestUser() {
  if (!dbAvailable) return
  try {
    const { sql } = await import('../../src/lib/postgres.js')
    await sql`DELETE FROM refresh_tokens WHERE user_id = ${TEST_USER_ID}::uuid`
    await sql`DELETE FROM password_resets WHERE user_id = ${TEST_USER_ID}::uuid`
    await sql`DELETE FROM invites WHERE invited_by = ${TEST_USER_ID}::uuid`
    await sql`DELETE FROM users WHERE user_id = ${TEST_USER_ID}::uuid`
  } catch { /* best-effort */ }
}

beforeAll(seedTestUser)
afterAll(cleanupTestUser)

// ── Existing: Auth middleware tests ──────────────────────────────────────────

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

  it('passes auth with a valid JWT (no role/type — legacy shape)', async () => {
    const token = makeJwt()
    const res = await app.request('/v1/sessions', {
      headers: { Authorization: `Bearer ${token}` },
    })
    // 200 or infra error — but never 401
    expect(res.status).not.toBe(401)
  })

  it('rejects a JWT whose type field is "refresh"', async () => {
    const token = jwt.sign(
      { tenant_id: TENANT_ID, user_id: 'u1', role: 'viewer', type: 'refresh' },
      SECRET,
      { expiresIn: '1h' }
    )
    const res = await app.request('/v1/sessions', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(401)
  })

  it('accepts a JWT with type "access"', async () => {
    const token = makeJwtWithRole(TENANT_ID, 'u1', 'viewer')
    const res = await app.request('/v1/sessions', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).not.toBe(401)
  })
})

// ── POST /v1/auth/login ──────────────────────────────────────────────────────

describe('POST /v1/auth/login', () => {
  it('returns 401 for missing body fields', async () => {
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL }),
    })
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_CREDENTIALS')
  })

  it('returns 401 for wrong password', async () => {
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password: 'wrong-password' }),
    })
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_CREDENTIALS')
  })

  it('returns 401 for non-existent email (same error shape as wrong password)', async () => {
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@dapplepot.dev', password: 'anything' }),
    })
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_CREDENTIALS')
  })

  it('returns 200 with correct shape on valid credentials', async () => {
    if (!dbAvailable) return
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body['accessToken']).toBe('string')
    expect(typeof body['refreshToken']).toBe('string')
    expect(body['expiresIn']).toBe(900)
    const user = body['user'] as Record<string, unknown>
    expect(user['email']).toBe(TEST_EMAIL)
    expect(user['role']).toBe('admin')
    expect(user['userId']).toBeDefined()
    expect(user['tenantId']).toBe(TENANT_ID)
    expect(user['passwordHash']).toBeUndefined()  // never leak the hash
  })

  it('access token from login has correct JWT payload', async () => {
    if (!dbAvailable) return
    const res = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    })
    const body = await res.json() as { accessToken: string }
    const payload = jwt.decode(body.accessToken) as Record<string, unknown>
    expect(payload['type']).toBe('access')
    expect(payload['role']).toBe('admin')
    expect(payload['tenant_id']).toBe(TENANT_ID)
    expect(payload['user_id']).toBe(TEST_USER_ID)
  })

  it('login for disabled user returns 401', async () => {
    if (!dbAvailable) return
    const { sql } = await import('../../src/lib/postgres.js')
    const DISABLED_ID = '00000000-0000-4000-8000-000000000098'
    const DISABLED_EMAIL = 'disabled-user@dapplepot.dev'
    try {
      await sql`
        INSERT INTO users (user_id, tenant_id, email, name, password_hash, role, status)
        VALUES (
          ${DISABLED_ID}::uuid, ${TENANT_ID}::uuid, ${DISABLED_EMAIL},
          ${'Disabled'}, ${bcrypt.hashSync('pass1234', 4)}, ${'viewer'}, ${'disabled'}
        )
        ON CONFLICT ON CONSTRAINT uq_users_tenant_email DO NOTHING
      `
      const res = await app.request('/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: DISABLED_EMAIL, password: 'pass1234' }),
      })
      expect(res.status).toBe(401)
      expect((await res.json() as { error: { code: string } }).error.code).toBe('INVALID_CREDENTIALS')
    } finally {
      await sql`DELETE FROM users WHERE user_id = ${DISABLED_ID}::uuid`
    }
  })
})

// ── POST /v1/auth/refresh ────────────────────────────────────────────────────

describe('POST /v1/auth/refresh', () => {
  it('returns 401 for missing body', async () => {
    const res = await app.request('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_REFRESH_TOKEN')
  })

  it('returns 401 for unknown refresh token', async () => {
    const res = await app.request('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'a'.repeat(128) }),
    })
    expect(res.status).toBe(401)
  })

  it('refresh → get new tokens, old token rejected', async () => {
    if (!dbAvailable) return
    // Login to get a refresh token
    const loginRes = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    })
    const { refreshToken: original } = await loginRes.json() as { refreshToken: string }

    // Refresh — get a new pair
    const refreshRes = await app.request('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: original }),
    })
    expect(refreshRes.status).toBe(200)
    const refreshBody = await refreshRes.json() as { accessToken: string; refreshToken: string }
    expect(typeof refreshBody.accessToken).toBe('string')
    expect(typeof refreshBody.refreshToken).toBe('string')
    expect(refreshBody.refreshToken).not.toBe(original)  // rotated

    // Old token is now revoked — replay fails
    const replayRes = await app.request('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: original }),
    })
    expect(replayRes.status).toBe(401)
  })

  it('new access token from refresh is valid for protected routes', async () => {
    if (!dbAvailable) return
    const loginRes = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    })
    const { refreshToken } = await loginRes.json() as { refreshToken: string }

    const refreshRes = await app.request('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
    const { accessToken } = await refreshRes.json() as { accessToken: string }

    const protectedRes = await app.request('/v1/users/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    // 200 (user found) or infra error — never 401
    expect(protectedRes.status).not.toBe(401)
  })
})

// ── POST /v1/auth/logout ─────────────────────────────────────────────────────

describe('POST /v1/auth/logout', () => {
  it('returns 200 ok:true regardless of token validity', async () => {
    const res = await app.request('/v1/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'unknown-token' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json() as { ok: boolean }).ok).toBe(true)
  })

  it('returns 200 ok:true with empty body', async () => {
    const res = await app.request('/v1/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
  })

  it('after logout, refresh token is revoked', async () => {
    if (!dbAvailable) return
    const loginRes = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    })
    const { refreshToken } = await loginRes.json() as { refreshToken: string }

    // Logout
    await app.request('/v1/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })

    // Try to use the revoked refresh token
    const afterLogoutRes = await app.request('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
    expect(afterLogoutRes.status).toBe(401)
  })
})

// ── POST /v1/auth/forgot-password ────────────────────────────────────────────

describe('POST /v1/auth/forgot-password', () => {
  it('returns 200 ok:true for a valid email', async () => {
    if (!dbAvailable) return
    const res = await app.request('/v1/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; message: string }
    expect(body.ok).toBe(true)
    expect(typeof body.message).toBe('string')
  })

  it('returns the same 200 shape for a non-existent email (no enumeration)', async () => {
    const res = await app.request('/v1/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@nowhere.dev' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('returns 200 ok:true even for invalid email format', async () => {
    // The route returns ok even when zod parse fails (by design: don't leak info)
    const res = await app.request('/v1/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json() as { ok: boolean }).ok).toBe(true)
  })
})

// ── POST /v1/auth/reset-password ─────────────────────────────────────────────

describe('POST /v1/auth/reset-password', () => {
  it('returns 400 INVALID_RESET_TOKEN for unknown token', async () => {
    const res = await app.request('/v1/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'a'.repeat(64), password: 'newpassword123' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_RESET_TOKEN')
  })

  it('returns 400 when password is too short (< 8 chars)', async () => {
    const res = await app.request('/v1/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'a'.repeat(64), password: 'short' }),
    })
    expect(res.status).toBe(400)
  })

  it('full flow: request reset, use token, can login with new password, old sessions revoked', async () => {
    if (!dbAvailable) return
    const { sql } = await import('../../src/lib/postgres.js')
    const { createHash, randomBytes } = await import('crypto')

    // Issue a session we can verify is revoked after reset
    const loginRes = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    })
    const { refreshToken: sessionToken } = await loginRes.json() as { refreshToken: string }

    // Insert a known reset token directly (bypass email sending)
    const rawToken = randomBytes(32).toString('hex')
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    await sql`
      INSERT INTO password_resets (user_id, token_hash, expires_at)
      VALUES (${TEST_USER_ID}::uuid, ${tokenHash}, ${expiresAt})
    `

    // Use reset token
    const resetRes = await app.request('/v1/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: rawToken, password: 'NewPassword456!' }),
    })
    expect(resetRes.status).toBe(200)
    expect((await resetRes.json() as { ok: boolean }).ok).toBe(true)

    // Old session token is revoked
    const oldSessionRes = await app.request('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: sessionToken }),
    })
    expect(oldSessionRes.status).toBe(401)

    // Can login with new password
    const newLoginRes = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password: 'NewPassword456!' }),
    })
    expect(newLoginRes.status).toBe(200)

    // Restore original password for other tests
    const { hashSync } = bcrypt
    const restoredHash = hashSync(TEST_PASSWORD, 4)
    await sql`UPDATE users SET password_hash = ${restoredHash} WHERE user_id = ${TEST_USER_ID}::uuid`

    // Revoke the reset token used above (already marked used by the route)
  })

  it('reset token cannot be used twice', async () => {
    if (!dbAvailable) return
    const { sql } = await import('../../src/lib/postgres.js')
    const { createHash, randomBytes } = await import('crypto')

    const rawToken = randomBytes(32).toString('hex')
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    await sql`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (${TEST_USER_ID}::uuid, ${tokenHash}, ${expiresAt})`

    // First use succeeds
    const first = await app.request('/v1/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: rawToken, password: TEST_PASSWORD }),
    })
    expect(first.status).toBe(200)

    // Second use fails — token marked used
    const second = await app.request('/v1/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: rawToken, password: TEST_PASSWORD }),
    })
    expect(second.status).toBe(400)
    expect((await second.json() as { error: { code: string } }).error.code).toBe('INVALID_RESET_TOKEN')
  })
})

// ── POST /v1/auth/accept-invite ───────────────────────────────────────────────

describe('POST /v1/auth/accept-invite', () => {
  it('returns 400 INVALID_INVITE_TOKEN for unknown token', async () => {
    const res = await app.request('/v1/auth/accept-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'a'.repeat(64), name: 'Test User', password: 'password123' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_INVITE_TOKEN')
  })

  it('returns 400 when password is too short', async () => {
    const res = await app.request('/v1/auth/accept-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'a'.repeat(64), name: 'Test', password: 'short' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when name is empty', async () => {
    const res = await app.request('/v1/auth/accept-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'a'.repeat(64), name: '', password: 'password123' }),
    })
    expect(res.status).toBe(400)
  })

  it('full invite → accept flow: creates user and returns tokens', async () => {
    if (!dbAvailable) return
    const { sql } = await import('../../src/lib/postgres.js')
    const { createHash, randomBytes } = await import('crypto')

    const INVITE_EMAIL = 'invited-user-test@dapplepot.dev'
    const rawToken = randomBytes(32).toString('hex')
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    // Clean up any pre-existing user from a prior run
    await sql`DELETE FROM users WHERE email = ${INVITE_EMAIL} AND tenant_id = ${TENANT_ID}::uuid`

    await sql`
      INSERT INTO invites (tenant_id, email, role, invited_by, token_hash, expires_at)
      VALUES (${TENANT_ID}::uuid, ${INVITE_EMAIL}, ${'viewer'}, ${TEST_USER_ID}::uuid, ${tokenHash}, ${expiresAt})
      ON CONFLICT DO NOTHING
    `

    const res = await app.request('/v1/auth/accept-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: rawToken, name: 'Invited User', password: 'invited-pass-123' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body['accessToken']).toBe('string')
    expect(typeof body['refreshToken']).toBe('string')
    const user = body['user'] as Record<string, unknown>
    expect(user['email']).toBe(INVITE_EMAIL)
    expect(user['name']).toBe('Invited User')
    expect(user['role']).toBe('viewer')

    // Verify invite status updated
    const invite = await sql`SELECT status FROM invites WHERE token_hash = ${tokenHash}`
    expect(invite[0]?.status).toBe('accepted')

    // Cleanup
    await sql`DELETE FROM refresh_tokens WHERE user_id = (SELECT user_id FROM users WHERE email = ${INVITE_EMAIL})`
    await sql`DELETE FROM users WHERE email = ${INVITE_EMAIL} AND tenant_id = ${TENANT_ID}::uuid`
    await sql`DELETE FROM invites WHERE token_hash = ${tokenHash}`
  })

  it('returns 400 for expired invite', async () => {
    if (!dbAvailable) return
    const { sql } = await import('../../src/lib/postgres.js')
    const { createHash, randomBytes } = await import('crypto')

    const rawToken = randomBytes(32).toString('hex')
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')
    const expiresAt = new Date(Date.now() - 1000)  // already expired

    await sql`
      INSERT INTO invites (tenant_id, email, role, invited_by, token_hash, expires_at)
      VALUES (${TENANT_ID}::uuid, ${'expired-invite@dapplepot.dev'}, ${'viewer'}, ${TEST_USER_ID}::uuid, ${tokenHash}, ${expiresAt})
    `

    const res = await app.request('/v1/auth/accept-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: rawToken, name: 'Test', password: 'password123' }),
    })
    // findPendingInviteByToken only returns status='pending' invites;
    // an expired but pending invite is still returned and the expiry check fires
    expect(res.status).toBe(400)

    await sql`DELETE FROM invites WHERE token_hash = ${tokenHash}`
  })

  it('returns 409 EMAIL_EXISTS if user already in tenant', async () => {
    if (!dbAvailable) return
    const { sql } = await import('../../src/lib/postgres.js')
    const { createHash, randomBytes } = await import('crypto')

    // Invite for an email that already belongs to the tenant (TEST_EMAIL)
    const rawToken = randomBytes(32).toString('hex')
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    await sql`
      INSERT INTO invites (tenant_id, email, role, invited_by, token_hash, expires_at)
      VALUES (${TENANT_ID}::uuid, ${TEST_EMAIL}, ${'viewer'}, ${TEST_USER_ID}::uuid, ${tokenHash}, ${expiresAt})
      ON CONFLICT DO NOTHING
    `

    const res = await app.request('/v1/auth/accept-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: rawToken, name: 'Duplicate', password: 'password123' }),
    })
    expect(res.status).toBe(409)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('EMAIL_EXISTS')

    await sql`DELETE FROM invites WHERE token_hash = ${tokenHash}`
  })
})
