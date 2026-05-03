import { createMiddleware } from 'hono/factory'

export const securityHeaders = createMiddleware(async (c, next) => {
  // HTTPS redirect in production
  if (process.env.NODE_ENV === 'production') {
    const proto = c.req.header('x-forwarded-proto')
    if (proto && proto !== 'https') {
      const url = new URL(c.req.url)
      url.protocol = 'https:'
      return c.redirect(url.toString(), 301)
    }
  }

  await next()

  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('X-XSS-Protection', '1; mode=block')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')

  if (process.env.NODE_ENV === 'production') {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
})
