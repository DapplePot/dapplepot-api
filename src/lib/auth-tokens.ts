import jwt from 'jsonwebtoken'
const { sign, verify } = jwt
import { randomBytes, createHash } from 'crypto'
import { env } from '../env.js'

export type Role = 'admin' | 'editor' | 'viewer' | 'superadmin'

export interface AccessTokenPayload {
    sub: string
    tenant_id: string
    user_id: string
    role: Role
    type: 'access'
    iat?: number
    exp?: number
}

const ACCESS_EXPIRES_IN_SECONDS = 15 * 60 // 15 minutes

export function generateAccessToken(params: {
    userId: string
    tenantId: string
    role: Role
}): string {
    const payload: Omit<AccessTokenPayload, 'iat' | 'exp'> = {
        sub: params.userId,
        tenant_id: params.tenantId,
        user_id: params.userId,
        role: params.role,
        type: 'access',
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return sign(payload, env.DAPPLEPOT_JWT_SECRET, { expiresIn: env.DAPPLEPOT_JWT_ACCESS_EXPIRES_IN as any })
}

export function verifyAccessToken(token: string): AccessTokenPayload {
    const payload = verify(token, env.DAPPLEPOT_JWT_SECRET) as AccessTokenPayload
    if (payload.type !== 'access') {
        throw new Error('Not an access token')
    }
    return payload
}

export function generateRefreshToken(): { raw: string; hash: string } {
    const raw = randomBytes(64).toString('hex')
    const hash = createHash('sha256').update(raw).digest('hex')
    return { raw, hash }
}

export function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex')
}

export { ACCESS_EXPIRES_IN_SECONDS }
