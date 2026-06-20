import { sql, queryRows } from '../lib/postgres.js'

export interface BlogRow extends Record<string, unknown> {
  id: string
  title: string
  slug: string
  excerpt: string
  content_markdown: string
  authors: any
  tag: string
  banner_image_url: string
  meta_title: string | null
  meta_description: string | null
  read_time: string | null
  created_at: Date | string
  updated_at: Date | string
  created_by: string | null
  updated_by: string | null
}

export interface BlogItem {
  id: string
  title: string
  slug: string
  excerpt: string
  contentMarkdown: string
  authors: string[]
  tag: string
  bannerImageUrl: string
  metaTitle: string | null
  metaDescription: string | null
  readTime: string | null
  createdAt: string
  updatedAt: string
  createdBy: string | null
  updatedBy: string | null
}

function toIso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : String(d)
}

function parseAuthors(authors: any): string[] {
  if (Array.isArray(authors)) return authors
  if (typeof authors === 'string') {
    try {
      return JSON.parse(authors)
    } catch {
      return []
    }
  }
  return []
}

function mapRow(r: BlogRow): BlogItem {
  return {
    id: r.id,
    title: r.title,
    slug: r.slug,
    excerpt: r.excerpt,
    contentMarkdown: r.content_markdown,
    authors: parseAuthors(r.authors),
    tag: r.tag,
    bannerImageUrl: r.banner_image_url,
    metaTitle: r.meta_title,
    metaDescription: r.meta_description,
    readTime: r.read_time,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
    createdBy: r.created_by,
    updatedBy: r.updated_by,
  }
}

export async function createBlog(params: {
  title: string
  slug: string
  excerpt: string
  contentMarkdown: string
  authors: string[]
  tag: string
  bannerImageUrl: string
  metaTitle?: string | null
  metaDescription?: string | null
  readTime: string
  createdBy: string
}): Promise<BlogItem> {
  const [row] = await sql<BlogRow[]>`
    INSERT INTO blogs (
      title, slug, excerpt, content_markdown, authors, tag,
      banner_image_url, meta_title, meta_description, read_time, created_by, updated_by
    ) VALUES (
      ${params.title}, ${params.slug}, ${params.excerpt}, ${params.contentMarkdown},
      ${sql.json(params.authors)}, ${params.tag}, ${params.bannerImageUrl},
      ${params.metaTitle || null}, ${params.metaDescription || null}, ${params.readTime},
      ${params.createdBy}, ${params.createdBy}
    )
    RETURNING *
  `
  if (!row) throw new Error('Failed to create blog post')
  return mapRow(row)
}

export async function updateBlog(
  id: string,
  params: {
    title: string
    slug: string
    excerpt: string
    contentMarkdown: string
    authors: string[]
    tag: string
    bannerImageUrl: string
    metaTitle?: string | null
    metaDescription?: string | null
    readTime: string
    updatedBy: string
  }
): Promise<BlogItem | null> {
  const [row] = await sql<BlogRow[]>`
    UPDATE blogs SET
      title = ${params.title},
      slug = ${params.slug},
      excerpt = ${params.excerpt},
      content_markdown = ${params.contentMarkdown},
      authors = ${sql.json(params.authors)},
      tag = ${params.tag},
      banner_image_url = ${params.bannerImageUrl},
      meta_title = ${params.metaTitle || null},
      meta_description = ${params.metaDescription || null},
      read_time = ${params.readTime},
      updated_by = ${params.updatedBy},
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}
    RETURNING *
  `
  if (!row) return null
  return mapRow(row)
}

export async function getBlogBySlug(slug: string): Promise<BlogItem | null> {
  const rows = await queryRows<BlogRow>(
    `SELECT * FROM blogs WHERE slug = $1 LIMIT 1`,
    [slug]
  )
  const r = rows[0]
  if (!r) return null
  return mapRow(r)
}

export async function getBlogById(id: string): Promise<BlogItem | null> {
  const rows = await queryRows<BlogRow>(
    `SELECT * FROM blogs WHERE id = $1 LIMIT 1`,
    [id]
  )
  const r = rows[0]
  if (!r) return null
  return mapRow(r)
}

export async function deleteBlog(id: string): Promise<boolean> {
  const result = await sql`
    DELETE FROM blogs WHERE id = ${id}
  `
  return result.count > 0
}

export async function listBlogs(params: {
  page: number
  limit: number
  search?: string
  tag?: string
}): Promise<{ blogs: BlogItem[]; total: number }> {
  const offset = (params.page - 1) * params.limit

  let whereClauses: string[] = []
  let queryParams: any[] = []

  if (params.tag) {
    queryParams.push(params.tag)
    whereClauses.push(`tag = $${queryParams.length}`)
  }

  if (params.search) {
    queryParams.push(`%${params.search}%`)
    const paramIndex = queryParams.length
    whereClauses.push(`(title ILIKE $${paramIndex} OR excerpt ILIKE $${paramIndex} OR content_markdown ILIKE $${paramIndex})`)
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''

  // Get total count
  const countRows = await queryRows<{ count: string }>(
    `SELECT COUNT(*) FROM blogs ${whereSql}`,
    queryParams
  )
  const total = parseInt(countRows[0]?.count || '0', 10)

  // Get paginated items
  queryParams.push(params.limit, offset)
  const limitIndex = queryParams.length - 1
  const offsetIndex = queryParams.length

  const rows = await queryRows<BlogRow>(
    `SELECT * FROM blogs ${whereSql}
     ORDER BY created_at DESC
     LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    queryParams
  )

  return {
    blogs: rows.map(mapRow),
    total,
  }
}
