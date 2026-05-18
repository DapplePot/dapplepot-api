import { Hono } from 'hono'
import { sessionsRouter } from './sessions.js'
import { analyticsRouter } from './analytics.js'
import { alertsRouter } from './alerts.js'
import { controlRouter } from './control.js'
import { channelsRouter } from './channels.js'
import { securityRouter, sdkSecurityRouter } from './security.js'
import { authRouter } from './auth.js'
import { usersRouter } from './users.js'
import { tenantsRouter } from './tenants.js'
import { agentsRouter } from './agents.js'
import { sdkKeysRouter } from './sdk-keys.js'
import { ingestRouter } from './ingest.js'
import { auditRouter } from './audit.js'
import { llmModelsRouter } from './llm-models.js'
import { toolsRouter } from './tools.js'

type Variables = { tenantId: string; userId: string; role: string }

export function mountRoutes(app: Hono<{ Variables: Variables }>) {
  app.route('/v1/auth', authRouter)
  app.route('/v1/users', usersRouter)
  app.route('/v1/tenants', tenantsRouter)
  app.route('/v1/agents', agentsRouter)
  app.route('/v1/sdk-keys', sdkKeysRouter)
  app.route('/v1/ingest', ingestRouter)
  app.route('/v1/sessions', sessionsRouter)
  app.route('/v1/analytics', analyticsRouter)
  app.route('/v1/alerts', alertsRouter)
  app.route('/v1/control', controlRouter)
  app.route('/v1/channels', channelsRouter)
  app.route('/v1/security', securityRouter)
  app.route('/v1/sdk/security', sdkSecurityRouter)
  app.route('/v1/audit', auditRouter)
  app.route('/v1/llm-models', llmModelsRouter)
  app.route('/v1/tools', toolsRouter)
}
