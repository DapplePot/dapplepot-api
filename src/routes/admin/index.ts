/**
 * Superadmin Dashboard backend.
 *
 * Mounted at /admin. Every route below is gated by:
 *   - jwtAuth                  (must be authenticated)
 *   - requireRole('superadmin') (must have global superadmin role)
 *
 * This module deliberately bypasses tenant-scoping (no requireOrganizationTenant
 * etc.) because superadmin actions operate across all tenants by definition.
 */

import { Hono } from 'hono'
import { jwtAuth } from '../../middleware/auth.js'
import { requireRole } from '../../middleware/authorize.js'
import { adminTenantsRouter } from './tenants.js'
import { adminUsersRouter } from './users.js'
import { adminUsageRouter } from './usage.js'
import { adminAuditLogRouter } from './audit-log.js'

type Variables = { tenantId: string; userId: string; role: string }

export const adminRouter = new Hono<{ Variables: Variables }>()

adminRouter.use('*', jwtAuth)
adminRouter.use('*', requireRole('superadmin'))

adminRouter.route('/tenants',   adminTenantsRouter)
adminRouter.route('/users',     adminUsersRouter)
adminRouter.route('/usage',     adminUsageRouter)
adminRouter.route('/audit-log', adminAuditLogRouter)
