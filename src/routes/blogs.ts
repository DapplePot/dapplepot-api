import { Hono } from 'hono'
import { z } from 'zod'
import { jwtAuth } from '../middleware/auth.js'
import { requireRole } from '../middleware/authorize.js'
import { uploadToGCS } from '../lib/gcs.js'
import {
  createBlog,
  updateBlog,
  deleteBlog,
  getBlogBySlug,
  getBlogById,
  listBlogs,
} from '../queries/blogs.pg.js'

type Variables = { tenantId: string; userId: string; role: string }

export const blogsRouter = new Hono<{ Variables: Variables }>()

const blogSchema = z.object({
  title: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, {
    message: 'Slug must contain only lowercase alphanumeric characters and hyphens',
  }),
  excerpt: z.string().min(1),
  contentMarkdown: z.string().min(1),
  authors: z.array(z.string()).min(1),
  tag: z.enum(['Research', 'Insights', 'Announcements', 'Product Updates']),
  bannerImageUrl: z.string().url(),
  metaTitle: z.string().optional().nullable(),
  metaDescription: z.string().optional().nullable(),
})

// Calculate reading time based on 200 words/min
function calculateReadTime(markdown: string): string {
  const words = markdown.trim().split(/\s+/).filter((w) => w.length > 0).length
  const minutes = Math.max(1, Math.round(words / 200))
  return `${minutes} min read`
}

// GET /v1/blogs — Public list blogs
blogsRouter.get('/', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') ?? '1', 10))
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') ?? '10', 10)))
  const search = c.req.query('search')
  const tag = c.req.query('tag')
  const queryParams: { page: number; limit: number; search?: string; tag?: string } = {
    page,
    limit,
  }
  if (search) queryParams.search = search
  if (tag) queryParams.tag = tag

  const { blogs, total } = await listBlogs(queryParams)
  return c.json({
    data: blogs,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  })
})

// GET /v1/blogs/id/:id — Public single blog by ID
blogsRouter.get('/id/:id', async (c) => {
  const id = c.req.param('id')
  const blog = await getBlogById(id)
  if (!blog) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Blog not found' } }, 404)
  }
  return c.json(blog)
})

// GET /v1/blogs/:slug — Public single blog by slug
blogsRouter.get('/:slug', async (c) => {
  const slug = c.req.param('slug')
  const blog = await getBlogBySlug(slug)
  if (!blog) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Blog not found' } }, 404)
  }
  return c.json(blog)
})

// POST /v1/blogs — Superadmin create blog
blogsRouter.post('/', jwtAuth, requireRole('superadmin'), async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const parsed = blogSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400)
  }

  // Check unique slug
  const existing = await getBlogBySlug(parsed.data.slug)
  if (existing) {
    return c.json({ error: { code: 'SLUG_EXISTS', message: 'Slug must be unique' } }, 409)
  }

  const readTime = calculateReadTime(parsed.data.contentMarkdown)
  const userId = c.get('userId') as string

  const blog = await createBlog({
    title: parsed.data.title,
    slug: parsed.data.slug,
    excerpt: parsed.data.excerpt,
    contentMarkdown: parsed.data.contentMarkdown,
    authors: parsed.data.authors,
    tag: parsed.data.tag,
    bannerImageUrl: parsed.data.bannerImageUrl,
    metaTitle: parsed.data.metaTitle ?? null,
    metaDescription: parsed.data.metaDescription ?? null,
    readTime,
    createdBy: userId,
  })

  return c.json(blog, 201)
})

// PUT /v1/blogs/:id — Superadmin update blog
blogsRouter.put('/:id', jwtAuth, requireRole('superadmin'), async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const parsed = blogSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } }, 400)
  }

  const existing = await getBlogById(id)
  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Blog not found' } }, 404)
  }

  // Check unique slug (if changed)
  if (parsed.data.slug !== existing.slug) {
    const duplicate = await getBlogBySlug(parsed.data.slug)
    if (duplicate) {
      return c.json({ error: { code: 'SLUG_EXISTS', message: 'Slug must be unique' } }, 409)
    }
  }

  const readTime = calculateReadTime(parsed.data.contentMarkdown)
  const userId = c.get('userId') as string

  const blog = await updateBlog(id, {
    title: parsed.data.title,
    slug: parsed.data.slug,
    excerpt: parsed.data.excerpt,
    contentMarkdown: parsed.data.contentMarkdown,
    authors: parsed.data.authors,
    tag: parsed.data.tag,
    bannerImageUrl: parsed.data.bannerImageUrl,
    metaTitle: parsed.data.metaTitle ?? null,
    metaDescription: parsed.data.metaDescription ?? null,
    readTime,
    updatedBy: userId,
  })

  return c.json(blog)
})

// DELETE /v1/blogs/:id — Superadmin delete blog
blogsRouter.delete('/:id', jwtAuth, requireRole('superadmin'), async (c) => {
  const id = c.req.param('id')
  const deleted = await deleteBlog(id)
  if (!deleted) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Blog not found' } }, 404)
  }
  return c.json({ ok: true })
})

// POST /v1/blogs/upload — Superadmin image upload to GCS
blogsRouter.post('/upload', jwtAuth, requireRole('superadmin'), async (c) => {
  const body = await c.req.parseBody()
  const file = body['file']

  if (!file || !(file instanceof File)) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'No file provided' } }, 400)
  }

  try {
    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    const url = await uploadToGCS(file.name, buffer, file.type)
    return c.json({ url })
  } catch (error: any) {
    console.error('[GCS Upload Error]', error)
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to upload asset to GCS' } }, 500)
  }
})
