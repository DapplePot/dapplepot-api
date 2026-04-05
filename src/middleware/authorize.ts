import type { Context, Next } from 'hono'

type Role = 'superadmin' | 'admin' | 'editor' | 'viewer'

const ROLE_RANK: Record<Role, number> = { superadmin: 4, admin: 3, editor: 2, viewer: 1 }

/**
 * Returns middleware that allows access if user's role >= minimumRole.
 * Must run AFTER jwtAuth middleware (which sets 'role' on context).
 */
export function requireRole(minimumRole: Role) {
    return async (c: Context, next: Next) => {
        const userRole = c.get('role') as Role
        const rank = ROLE_RANK[userRole] ?? 0  // unknown role gets rank 0 → always blocked
        if (rank < ROLE_RANK[minimumRole]) {
            return c.json({ error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } }, 403)
        }
        await next()
    }
}
