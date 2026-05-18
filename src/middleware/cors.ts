import { cors } from 'hono/cors'
import { env } from '../env.js'

export const corsMiddleware = cors({
  origin: env.API_CORS_ORIGIN,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type'],
  exposeHeaders: ['X-Total-Count'],
  credentials: true,
})
