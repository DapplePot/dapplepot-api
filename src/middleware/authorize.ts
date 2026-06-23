import type { Context, Next } from 'hono'
import { queryRow } from '../lib/postgres.js'

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

/**
 * Blocks the route when the caller's tenant is a personal workspace.
 * Used to prevent personal-tenant owners from using team-only features
 * like teammate invites. Superadmin bypasses.
 */
export function requireOrganizationTenant() {
    return async (c: Context, next: Next) => {
        const role = c.get('role') as Role
        if (role === 'superadmin') {
            await next()
            return
        }
        const tenantId = c.get('tenantId') as string | undefined
        if (!tenantId) {
            return c.json({ error: { code: 'FORBIDDEN' } }, 403)
        }
        const row = await queryRow<{ kind: string }>(
            'SELECT kind FROM tenants WHERE tenant_id = $1 LIMIT 1',
            [tenantId]
        )
        if (row?.kind === 'personal') {
            return c.json(
                { error: { code: 'PERSONAL_TENANT_FORBIDDEN', message: 'Not available on personal workspaces' } },
                403
            )
        }
        await next()
    }
}
