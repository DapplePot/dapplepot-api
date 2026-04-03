import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import bcrypt from 'bcryptjs'
import app from '../../src/app.js'
import { makeJwtWithRole } from './auth.test.js'

const TENANT_ID = '00000000-0000-0000-0000-000000000001'

// ── Test users ───────────────────────────────────────────────────────────────

const ADMIN_ID  = '00000000-0000-4000-8001-000000000001'
const EDITOR_ID = '00000000-0000-4000-8001-000000000002'
const VIEWER_ID = '00000000-0000-4000-8001-000000000003'
const TARGET_ID = '00000000-0000-4000-8001-000000000004'

const ADMIN_EMAIL  = 'users-test-admin@dapplepot.dev'
const EDITOR_EMAIL = 'users-test-editor@dapplepot.dev'
const VIEWER_EMAIL = 'users-test-viewer@dapplepot.dev'
const TARGET_EMAIL = 'users-test-target@dapplepot.dev'

let dbAvailable = false

function auth(userId: string, role: 'admin' | 'editor' | 'viewer') {
  return { Authorization: `Bearer ${makeJwtWithRole(TENANT_ID, userId, role)}` }
}

async function seedUsers() {
  try {
    const { sql } = await import('../../src/lib/postgres.js')
    const hash = bcrypt.hashSync('test-pass-123', 4)

    for (const [id, email, role] of [
      [ADMIN_ID,  ADMIN_EMAIL,  'admin'],
      [EDITOR_ID, EDITOR_EMAIL, 'editor'],
      [VIEWER_ID, VIEWER_EMAIL, 'viewer'],
      [TARGET_ID, TARGET_EMAIL, 'viewer'],
    ] as [string, string, string][]) {
      await sql`
        INSERT INTO users (user_id, tenant_id, email, name, password_hash, role, status)
        VALUES (${id}::uuid, ${TENANT_ID}::uuid, ${email}, ${email}, ${hash}, ${role}, ${'active'})
        ON CONFLICT ON CONSTRAINT uq_users_tenant_email
        DO UPDATE SET role = ${role}, status = 'active', password_hash = ${hash}
      `
    }
    dbAvailable = true
  } catch {
    dbAvailable = false
  }
}

async function cleanupUsers() {
  if (!dbAvailable) return
  try {
    const { sql } = await import('../../src/lib/postgres.js')
    const ids = [ADMIN_ID, EDITOR_ID, VIEWER_ID, TARGET_ID]
    for (const id of ids) {
      await sql`DELETE FROM refresh_tokens WHERE user_id = ${id}::uuid`
      await sql`DELETE FROM invites WHERE invited_by = ${id}::uuid`
    }
    // also clean any invites TO test emails
    for (const email of [ADMIN_EMAIL, EDITOR_EMAIL, VIEWER_EMAIL, TARGET_EMAIL]) {
      await sql`DELETE FROM invites WHERE email = ${email} AND tenant_id = ${TENANT_ID}::uuid`
    }
    for (const id of ids) {
      await sql`DELETE FROM users WHERE user_id = ${id}::uuid`
    }
  } catch { /* best-effort */ }
}

beforeAll(seedUsers)
afterAll(cleanupUsers)

// ── GET /v1/users ─────────────────────────────────────────────────────────────

describe('GET /v1/users', () => {
  it('requires authentication (401 without token)', async () => {
    const res = await app.request('/v1/users')
    expect(res.status).toBe(401)
  })

  it('viewer is blocked with 403', async () => {
    const res = await app.request('/v1/users', { headers: auth(VIEWER_ID, 'viewer') })
    expect(res.status).toBe(403)
  })

  it('editor is blocked with 403', async () => {
    const res = await app.request('/v1/users', { headers: auth(EDITOR_ID, 'editor') })
    expect(res.status).toBe(403)
  })

  it('admin receives paginated user list', async () => {
    if (!dbAvailable) return
    const res = await app.request('/v1/users', { headers: auth(ADMIN_ID, 'admin') })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(Array.isArray(body['data'])).toBe(true)
    expect(typeof body['pagination']).toBe('object')
    const pagination = body['pagination'] as Record<string, unknown>
    expect(typeof pagination['total']).toBe('number')
    expect(typeof pagination['page']).toBe('number')
  })

  it('no user in the list has a passwordHash field', async () => {
    if (!dbAvailable) return
    const res = await app.request('/v1/users', { headers: auth(ADMIN_ID, 'admin') })
    const body = await res.json() as { data: Record<string, unknown>[] }
    for (const u of body.data) {
      expect(u['passwordHash']).toBeUndefined()
    }
  })

  it('page and limit query params are respected', async () => {
    if (!dbAvailable) return
    const res = await app.request('/v1/users?page=1&limit=2', { headers: auth(ADMIN_ID, 'admin') })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: unknown[]; pagination: { limit: number } }
    expect(body.data.length).toBeLessThanOrEqual(2)
    expect(body.pagination.limit).toBe(2)
  })
})

// ── GET /v1/users/me ──────────────────────────────────────────────────────────

describe('GET /v1/users/me', () => {
  it('returns 401 without token', async () => {
    const res = await app.request('/v1/users/me')
    expect(res.status).toBe(401)
  })

  it('viewer can access own profile', async () => {
    if (!dbAvailable) return
    const res = await app.request('/v1/users/me', { headers: auth(VIEWER_ID, 'viewer') })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body['userId']).toBe(VIEWER_ID)
    expect(body['email']).toBe(VIEWER_EMAIL)
    expect(body['passwordHash']).toBeUndefined()
  })

  it('editor can access own profile', async () => {
    if (!dbAvailable) return
    const res = await app.request('/v1/users/me', { headers: auth(EDITOR_ID, 'editor') })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body['userId']).toBe(EDITOR_ID)
  })

  it('admin can access own profile', async () => {
    if (!dbAvailable) return
    const res = await app.request('/v1/users/me', { headers: auth(ADMIN_ID, 'admin') })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body['role']).toBe('admin')
  })
})

// ── PUT /v1/users/me ──────────────────────────────────────────────────────────

describe('PUT /v1/users/me', () => {
  it('returns 401 without token', async () => {
    const res = await app.request('/v1/users/me', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Name' }),
    })
    expect(res.status).toBe(401)
  })

  it('any role can update their name', async () => {
    if (!dbAvailable) return
    const res = await app.request('/v1/users/me', {
      method: 'PUT',
      headers: { ...auth(EDITOR_ID, 'editor'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated Editor Name' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { name: string }
    expect(body.name).toBe('Updated Editor Name')
  })

  it('password change with correct currentPassword succeeds', async () => {
    if (!dbAvailable) return
    const { sql } = await import('../../src/lib/postgres.js')
    // Use VIEWER for this test to avoid disrupting ADMIN/EDITOR for other tests
    const res = await app.request('/v1/users/me', {
      method: 'PUT',
      headers: { ...auth(VIEWER_ID, 'viewer'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'test-pass-123', newPassword: 'new-pass-456' }),
    })
    expect(res.status).toBe(200)

    // Restore original hash
    await sql`UPDATE users SET password_hash = ${bcrypt.hashSync('test-pass-123', 4)} WHERE user_id = ${VIEWER_ID}::uuid`
  })

  it('password change with wrong currentPassword returns 400', async () => {
    if (!dbAvailable) return
    const res = await app.request('/v1/users/me', {
      method: 'PUT',
      headers: { ...auth(VIEWER_ID, 'viewer'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'wrong-password', newPassword: 'new-pass-456' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_CURRENT_PASSWORD')
  })

  it('providing newPassword without currentPassword returns 400', async () => {
    if (!dbAvailable) return
    const res = await app.request('/v1/users/me', {
      method: 'PUT',
      headers: { ...auth(VIEWER_ID, 'viewer'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword: 'new-pass-456' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
  })

  it('new password shorter than 8 chars returns 400', async () => {
    if (!dbAvailable) return
    const res = await app.request('/v1/users/me', {
      method: 'PUT',
      headers: { ...auth(VIEWER_ID, 'viewer'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'test-pass-123', newPassword: 'short' }),
    })
    expect(res.status).toBe(400)
  })

  it('password change revokes all refresh tokens', async () => {
    if (!dbAvailable) return
    const { sql } = await import('../../src/lib/postgres.js')
    const { createHash, randomBytes } = await import('crypto')

    // Insert a fake active refresh token for VIEWER
    const rawTok = randomBytes(64).toString('hex')
    const tokHash = createHash('sha256').update(rawTok).digest('hex')
    const exp = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await sql`INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (${VIEWER_ID}::uuid, ${tokHash}, ${exp})`

    // Change password
    await app.request('/v1/users/me', {
      method: 'PUT',
      headers: { ...auth(VIEWER_ID, 'viewer'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'test-pass-123', newPassword: 'NewValid789!' }),
    })

    // Token should now be revoked
    const [row] = await sql`SELECT revoked_at FROM refresh_tokens WHERE token_hash = ${tokHash}`
    expect(row?.revoked_at).not.toBeNull()

    // Restore
    await sql`UPDATE users SET password_hash = ${bcrypt.hashSync('test-pass-123', 4)} WHERE user_id = ${VIEWER_ID}::uuid`
  })
})

// ── POST /v1/users/invite ─────────────────────────────────────────────────────

describe('POST /v1/users/invite', () => {
  const INVITE_EMAIL = 'fresh-invite-test@dapplepot.dev'

  it('returns 401 without token', async () => {
    const res = await app.request('/v1/users/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: INVITE_EMAIL, role: 'viewer' }),
    })
    expect(res.status).toBe(401)
  })

  it('viewer is blocked with 403', async () => {
    const res = await app.request('/v1/users/invite', {
      method: 'POST',
      headers: { ...auth(VIEWER_ID, 'viewer'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: INVITE_EMAIL, role: 'viewer' }),
    })
    expect(res.status).toBe(403)
  })

  it('editor is blocked with 403', async () => {
    const res = await app.request('/v1/users/invite', {
      method: 'POST',
      headers: { ...auth(EDITOR_ID, 'editor'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: INVITE_EMAIL, role: 'viewer' }),
    })
    expect(res.status).toBe(403)
  })

  it('admin can invite a new user — 201 with inviteId', async () => {
    if (!dbAvailable) return
    const { sql } = await import('../../src/lib/postgres.js')
    // Ensure clean slate
    await sql`DELETE FROM invites WHERE email = ${INVITE_EMAIL} AND tenant_id = ${TENANT_ID}::uuid`

    const res = await app.request('/v1/users/invite', {
      method: 'POST',
      headers: { ...auth(ADMIN_ID, 'admin'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: INVITE_EMAIL, role: 'editor' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as Record<string, unknown>
    expect(typeof body['inviteId']).toBe('string')
    expect(body['email']).toBe(INVITE_EMAIL)
    expect(body['role']).toBe('editor')

    await sql`DELETE FROM invites WHERE email = ${INVITE_EMAIL} AND tenant_id = ${TENANT_ID}::uuid`
  })

  it('returns 409 INVITE_PENDING when pending invite already exists', async () => {
    if (!dbAvailable) return
    const { sql } = await import('../../src/lib/postgres.js')
    const { createHash, randomBytes } = await import('crypto')

    const tokenHash = createHash('sha256').update(randomBytes(32)).digest('hex')
    const exp = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await sql`INSERT INTO invites (tenant_id, email, role, invited_by, token_hash, expires_at) VALUES (${TENANT_ID}::uuid, ${INVITE_EMAIL}, ${'viewer'}, ${ADMIN_ID}::uuid, ${tokenHash}, ${exp})`

    const res = await app.request('/v1/users/invite', {
      method: 'POST',
      headers: { ...auth(ADMIN_ID, 'admin'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: INVITE_EMAIL, role: 'viewer' }),
    })
    expect(res.status).toBe(409)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('INVITE_PENDING')

    await sql`DELETE FROM invites WHERE token_hash = ${tokenHash}`
  })

  it('returns 409 EMAIL_EXISTS when user already exists in tenant', async () => {
    if (!dbAvailable) return
    const res = await app.request('/v1/users/invite', {
      method: 'POST',
      headers: { ...auth(ADMIN_ID, 'admin'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EDITOR_EMAIL, role: 'viewer' }),
    })
    expect(res.status).toBe(409)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('EMAIL_EXISTS')
  })

  it('returns 400 for invalid email format', async () => {
    const res = await app.request('/v1/users/invite', {
      method: 'POST',
      headers: { ...auth(ADMIN_ID, 'admin'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', role: 'viewer' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid role', async () => {
    const res = await app.request('/v1/users/invite', {
      method: 'POST',
      headers: { ...auth(ADMIN_ID, 'admin'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: INVITE_EMAIL, role: 'superuser' }),
    })
    expect(res.status).toBe(400)
  })
})

// ── GET /v1/users/invites ─────────────────────────────────────────────────────

describe('GET /v1/users/invites', () => {
  it('returns 401 without token', async () => {
    const res = await app.request('/v1/users/invites')
    expect(res.status).toBe(401)
  })

  it('viewer is blocked with 403', async () => {
    const res = await app.request('/v1/users/invites', { headers: auth(VIEWER_ID, 'viewer') })
    expect(res.status).toBe(403)
  })

  it('editor is blocked with 403', async () => {
    const res = await app.request('/v1/users/invites', { headers: auth(EDITOR_ID, 'editor') })
    expect(res.status).toBe(403)
  })

  it('admin receives invite list', async () => {
    if (!dbAvailable) return
    const res = await app.request('/v1/users/invites', { headers: auth(ADMIN_ID, 'admin') })
    expect(res.status).toBe(200)
    const body = await res.json() as { invites: unknown[] }
    expect(Array.isArray(body.invites)).toBe(true)
  })
})

// ── DELETE /v1/users/invites/:id ──────────────────────────────────────────────

describe('DELETE /v1/users/invites/:id', () => {
  it('returns 404 for non-existent invite', async () => {
    const res = await app.request(
      '/v1/users/invites/00000000-0000-0000-0000-000000000000',
      { method: 'DELETE', headers: auth(ADMIN_ID, 'admin') }
    )
    expect(res.status).toBe(404)
  })

  it('viewer is blocked with 403', async () => {
    const res = await app.request(
      '/v1/users/invites/00000000-0000-0000-0000-000000000000',
      { method: 'DELETE', headers: auth(VIEWER_ID, 'viewer') }
    )
    expect(res.status).toBe(403)
  })

  it('admin can revoke a pending invite', async () => {
    if (!dbAvailable) return
    const { sql } = await import('../../src/lib/postgres.js')
    const { createHash, randomBytes } = await import('crypto')

    const tokenHash = createHash('sha256').update(randomBytes(32)).digest('hex')
    const exp = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    const [row] = await sql`
      INSERT INTO invites (tenant_id, email, role, invited_by, token_hash, expires_at)
      VALUES (${TENANT_ID}::uuid, ${'revoke-test@dapplepot.dev'}, ${'viewer'}, ${ADMIN_ID}::uuid, ${tokenHash}, ${exp})
      RETURNING invite_id
    `
    const inviteId = row?.invite_id as string

    const res = await app.request(`/v1/users/invites/${inviteId}`, {
      method: 'DELETE',
      headers: auth(ADMIN_ID, 'admin'),
    })
    expect(res.status).toBe(200)
    expect((await res.json() as { ok: boolean }).ok).toBe(true)

    // Verify status is 'revoked'
    const [updated] = await sql`SELECT status FROM invites WHERE invite_id = ${inviteId}::uuid`
    expect(updated?.status).toBe('revoked')
  })
})

// ── PUT /v1/users/:id/role ────────────────────────────────────────────────────

describe('PUT /v1/users/:id/role', () => {
  it('returns 401 without token', async () => {
    const res = await app.request(`/v1/users/${TARGET_ID}/role`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'editor' }),
    })
    expect(res.status).toBe(401)
  })

  it('viewer is blocked with 403', async () => {
    const res = await app.request(`/v1/users/${TARGET_ID}/role`, {
      method: 'PUT',
      headers: { ...auth(VIEWER_ID, 'viewer'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'editor' }),
    })
    expect(res.status).toBe(403)
  })

  it('editor is blocked with 403', async () => {
    const res = await app.request(`/v1/users/${TARGET_ID}/role`, {
      method: 'PUT',
      headers: { ...auth(EDITOR_ID, 'editor'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'editor' }),
    })
    expect(res.status).toBe(403)
  })

  it('admin cannot change their own role', async () => {
    const res = await app.request(`/v1/users/${ADMIN_ID}/role`, {
      method: 'PUT',
      headers: { ...auth(ADMIN_ID, 'admin'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'viewer' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN')
  })

  it('admin can change another user\'s role', async () => {
    if (!dbAvailable) return
    const { sql } = await import('../../src/lib/postgres.js')

    const res = await app.request(`/v1/users/${TARGET_ID}/role`, {
      method: 'PUT',
      headers: { ...auth(ADMIN_ID, 'admin'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'editor' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { role: string }
    expect(body.role).toBe('editor')

    // Restore
    await sql`UPDATE users SET role = 'viewer' WHERE user_id = ${TARGET_ID}::uuid`
  })

  it('returns 404 for non-existent user', async () => {
    const res = await app.request('/v1/users/00000000-0000-0000-0000-000000000000/role', {
      method: 'PUT',
      headers: { ...auth(ADMIN_ID, 'admin'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'editor' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 400 for invalid role value', async () => {
    const res = await app.request(`/v1/users/${TARGET_ID}/role`, {
      method: 'PUT',
      headers: { ...auth(ADMIN_ID, 'admin'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'superuser' }),
    })
    expect(res.status).toBe(400)
  })
})

// ── PUT /v1/users/:id/status ──────────────────────────────────────────────────

describe('PUT /v1/users/:id/status', () => {
  it('returns 401 without token', async () => {
    const res = await app.request(`/v1/users/${TARGET_ID}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    })
    expect(res.status).toBe(401)
  })

  it('viewer is blocked with 403', async () => {
    const res = await app.request(`/v1/users/${TARGET_ID}/status`, {
      method: 'PUT',
      headers: { ...auth(VIEWER_ID, 'viewer'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    })
    expect(res.status).toBe(403)
  })

  it('admin cannot disable themselves', async () => {
    const res = await app.request(`/v1/users/${ADMIN_ID}/status`, {
      method: 'PUT',
      headers: { ...auth(ADMIN_ID, 'admin'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN')
  })

  it('admin can disable another user and their tokens are revoked', async () => {
    if (!dbAvailable) return
    const { sql } = await import('../../src/lib/postgres.js')
    const { createHash, randomBytes } = await import('crypto')

    // Give TARGET an active refresh token
    const rawTok = randomBytes(64).toString('hex')
    const tokHash = createHash('sha256').update(rawTok).digest('hex')
    const exp = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await sql`INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (${TARGET_ID}::uuid, ${tokHash}, ${exp})`

    const res = await app.request(`/v1/users/${TARGET_ID}/status`, {
      method: 'PUT',
      headers: { ...auth(ADMIN_ID, 'admin'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { status: string }
    expect(body.status).toBe('disabled')

    // Refresh token should be revoked
    const [row] = await sql`SELECT revoked_at FROM refresh_tokens WHERE token_hash = ${tokHash}`
    expect(row?.revoked_at).not.toBeNull()

    // Restore
    await sql`UPDATE users SET status = 'active' WHERE user_id = ${TARGET_ID}::uuid`
  })

  it('returns 404 for non-existent user', async () => {
    const res = await app.request('/v1/users/00000000-0000-0000-0000-000000000000/status', {
      method: 'PUT',
      headers: { ...auth(ADMIN_ID, 'admin'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    })
    expect(res.status).toBe(404)
  })
})
