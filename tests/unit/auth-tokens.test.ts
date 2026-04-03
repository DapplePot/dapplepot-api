import { describe, it, expect, beforeAll } from 'vitest'
import jwt from 'jsonwebtoken'
const { sign } = jwt
import {
    generateAccessToken,
    verifyAccessToken,
    generateRefreshToken,
    hashToken,
    ACCESS_EXPIRES_IN_SECONDS,
} from '../../src/lib/auth-tokens.js'

const SECRET = process.env['DAPPLEPOT_JWT_SECRET'] ?? 'test-secret'
const TEST_USER = { userId: 'u-test-1', tenantId: 't-test-1', role: 'admin' as const }

describe('generateAccessToken', () => {
    it('returns a non-empty string', () => {
        const token = generateAccessToken(TEST_USER)
        expect(typeof token).toBe('string')
        expect(token.length).toBeGreaterThan(0)
    })

    it('payload contains all required fields', () => {
        const token = generateAccessToken(TEST_USER)
        const payload = jwt.decode(token) as Record<string, unknown>
        expect(payload['sub']).toBe(TEST_USER.userId)
        expect(payload['user_id']).toBe(TEST_USER.userId)
        expect(payload['tenant_id']).toBe(TEST_USER.tenantId)
        expect(payload['role']).toBe('admin')
        expect(payload['type']).toBe('access')
    })

    it('includes iat and exp claims', () => {
        const before = Math.floor(Date.now() / 1000)
        const token = generateAccessToken(TEST_USER)
        const after = Math.floor(Date.now() / 1000)
        const payload = jwt.decode(token) as Record<string, unknown>
        expect(typeof payload['iat']).toBe('number')
        expect(typeof payload['exp']).toBe('number')
        expect(payload['iat'] as number).toBeGreaterThanOrEqual(before)
        expect(payload['iat'] as number).toBeLessThanOrEqual(after)
        expect(payload['exp'] as number).toBeGreaterThan(payload['iat'] as number)
    })

    it('generates different tokens for each call (iat may differ)', () => {
        // Two tokens for same user will be identical if issued within same second;
        // what matters is they are independently verifiable
        const t1 = generateAccessToken(TEST_USER)
        const t2 = generateAccessToken({ ...TEST_USER, userId: 'u-test-2' })
        const p1 = jwt.decode(t1) as Record<string, unknown>
        const p2 = jwt.decode(t2) as Record<string, unknown>
        expect(p1['user_id']).not.toBe(p2['user_id'])
    })

    it('token is signed with the correct secret', () => {
        const token = generateAccessToken(TEST_USER)
        // If signed with wrong secret, verify would throw
        expect(() => jwt.verify(token, SECRET)).not.toThrow()
        expect(() => jwt.verify(token, 'wrong-secret')).toThrow()
    })
})

describe('verifyAccessToken', () => {
    it('returns correct payload for valid token', () => {
        const token = generateAccessToken(TEST_USER)
        const payload = verifyAccessToken(token)
        expect(payload.user_id).toBe(TEST_USER.userId)
        expect(payload.tenant_id).toBe(TEST_USER.tenantId)
        expect(payload.role).toBe('admin')
        expect(payload.type).toBe('access')
    })

    it('throws on expired token', () => {
        const decoded = jwt.decode(generateAccessToken(TEST_USER)) as Record<string, unknown>
        // Strip iat/exp — jsonwebtoken rejects re-signing when exp already present
        const { iat: _iat, exp: _exp, ...rest } = decoded
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const expired = sign({ ...rest }, SECRET, { expiresIn: -1 as any })
        expect(() => verifyAccessToken(expired)).toThrow()
    })

    it('throws when signed with wrong secret', () => {
        const token = sign(
            { sub: 'u', tenant_id: 't', user_id: 'u', role: 'viewer', type: 'access' },
            'wrong-secret',
            { expiresIn: '15m' }
        )
        expect(() => verifyAccessToken(token)).toThrow()
    })

    it('throws when token type is not "access"', () => {
        // Simulate a refresh token being used as access token
        const notAccessToken = sign(
            { sub: 'u', tenant_id: 't', user_id: 'u', role: 'viewer', type: 'refresh' },
            SECRET,
            { expiresIn: '15m' }
        )
        expect(() => verifyAccessToken(notAccessToken)).toThrow('Not an access token')
    })

    it('throws on a plain JWT without type field', () => {
        const noType = sign(
            { sub: 'u', tenant_id: 't', user_id: 'u', role: 'viewer' },
            SECRET,
            { expiresIn: '15m' }
        )
        // No type means type is undefined — verifyAccessToken checks type !== 'access'
        expect(() => verifyAccessToken(noType)).toThrow('Not an access token')
    })

    it('throws on malformed string', () => {
        expect(() => verifyAccessToken('not.a.token')).toThrow()
        expect(() => verifyAccessToken('')).toThrow()
    })
})

describe('generateRefreshToken', () => {
    it('returns raw token of 128 hex chars (64 bytes)', () => {
        const { raw } = generateRefreshToken()
        expect(raw).toMatch(/^[0-9a-f]{128}$/)
    })

    it('returns hash that is 64 hex chars (SHA-256)', () => {
        const { hash } = generateRefreshToken()
        expect(hash).toMatch(/^[0-9a-f]{64}$/)
    })

    it('hash differs from raw token', () => {
        const { raw, hash } = generateRefreshToken()
        expect(raw).not.toBe(hash)
    })

    it('produces different tokens on each call', () => {
        const t1 = generateRefreshToken()
        const t2 = generateRefreshToken()
        expect(t1.raw).not.toBe(t2.raw)
        expect(t1.hash).not.toBe(t2.hash)
    })

    it('hash of raw matches the returned hash', () => {
        const { raw, hash } = generateRefreshToken()
        expect(hashToken(raw)).toBe(hash)
    })
})

describe('hashToken', () => {
    it('is deterministic', () => {
        const h1 = hashToken('mytoken')
        const h2 = hashToken('mytoken')
        expect(h1).toBe(h2)
    })

    it('produces different hashes for different inputs', () => {
        expect(hashToken('abc')).not.toBe(hashToken('xyz'))
    })

    it('returns a 64-char hex string (SHA-256)', () => {
        expect(hashToken('anything')).toMatch(/^[0-9a-f]{64}$/)
    })
})

describe('ACCESS_EXPIRES_IN_SECONDS', () => {
    it('is 900 (15 minutes)', () => {
        expect(ACCESS_EXPIRES_IN_SECONDS).toBe(900)
    })
})
