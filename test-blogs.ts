import 'dotenv/config'
import app from './src/app.js'
import { queryRow } from './src/lib/postgres.js'

async function run() {
  console.log('🧪 Starting Blog Management System E2E Tests...')

  try {
    // 1. Get JWT token by logging in via /v1/auth/login
    console.log('\n[1] Logging in as Superadmin...')
    const loginRes = await app.request('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'superadmin@dapplepot.dev',
        password: 'superadmin123',
      }),
    })

    if (loginRes.status !== 200) {
      const errText = await loginRes.text()
      throw new Error(`Login failed with status ${loginRes.status}: ${errText}`)
    }

    const loginData = await loginRes.json()
    const token = loginData.accessToken
    console.log('🔑 Login successful. Token received.')

    // 2. Clear out any existing test blogs to avoid slug conflict
    console.log('\n[2] Cleaning up old test blogs...')
    await queryRow("DELETE FROM blogs WHERE slug = 'test-blog-slug'")

    // 3. Create a new blog post
    console.log('\n[3] Creating new blog post via POST /v1/blogs...')
    const createRes = await app.request('/v1/blogs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: 'Test Blog Post',
        slug: 'test-blog-slug',
        excerpt: 'This is a test excerpt for verification.',
        contentMarkdown: '## Introduction\n\nThis is a *test* markdown content for the blog post.',
        authors: ['Pushpendra Pal', 'Sayantan Gain'],
        tag: 'Research',
        bannerImageUrl: 'https://storage.googleapis.com/dapplepot-blogs/landing-website/blogs/test.png',
        metaTitle: 'SEO Test Blog',
        metaDescription: 'SEO description for verification.',
      }),
    })

    if (createRes.status !== 201) {
      const errText = await createRes.text()
      throw new Error(`Create blog failed with status ${createRes.status}: ${errText}`)
    }

    const createdBlog = await createRes.json()
    console.log('✅ Blog created successfully. ID:', createdBlog.id)
    console.log('⏱️ Calculated read time:', createdBlog.readTime)

    if (createdBlog.readTime !== '1 min read') {
      throw new Error(`Expected read time '1 min read', got '${createdBlog.readTime}'`)
    }

    // 4. Retrieve all blogs (paginated, with search and tag filters)
    console.log('\n[4] Querying blog list via GET /v1/blogs...')
    const listRes = await app.request('/v1/blogs?search=verification&tag=Research')
    if (listRes.status !== 200) {
      throw new Error(`List blogs failed with status ${listRes.status}`)
    }
    const listData = await listRes.json()
    console.log('✅ List blogs returned items count:', listData.data.length)
    if (listData.data.length === 0) {
      throw new Error('Expected at least 1 blog post in search results.')
    }

    // 5. Retrieve a single blog by slug
    console.log('\n[5] Fetching blog by slug via GET /v1/blogs/:slug...')
    const slugRes = await app.request('/v1/blogs/test-blog-slug')
    if (slugRes.status !== 200) {
      throw new Error(`Fetch by slug failed with status ${slugRes.status}`)
    }
    const slugData = await slugRes.json()
    console.log('✅ Fetched blog by slug successfully. Title:', slugData.title)

    // 6. Update the blog post
    console.log('\n[6] Updating blog post via PUT /v1/blogs/:id...')
    const updateRes = await app.request(`/v1/blogs/${createdBlog.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: 'Updated Test Blog Post',
        slug: 'test-blog-slug',
        excerpt: 'This is an updated test excerpt for verification.',
        contentMarkdown:
          '## Introduction\n\nThis is a *test* markdown content for the blog post.\n\nNow we add more words so that the read time updates. We need to write enough words to cross the 200 words mark to increase the read time calculation. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text. Let us repeat text.',
        authors: ['Pushpendra Pal', 'Sayantan Gain'],
        tag: 'Research',
        bannerImageUrl: 'https://storage.googleapis.com/dapplepot-blogs/landing-website/blogs/test.png',
        metaTitle: 'SEO Test Blog',
        metaDescription: 'SEO description for verification.',
      }),
    })

    if (updateRes.status !== 200) {
      const errText = await updateRes.text()
      throw new Error(`Update blog failed with status ${updateRes.status}: ${errText}`)
    }

    const updatedBlog = await updateRes.json()
    console.log('✅ Blog updated successfully.')
    console.log('⏱️ Recalculated read time:', updatedBlog.readTime)

    if (updatedBlog.readTime !== '4 min read') {
      throw new Error(`Expected read time '4 min read', got '${updatedBlog.readTime}'`)
    }

    // 7. Delete the blog post
    console.log('\n[7] Deleting blog post via DELETE /v1/blogs/:id...')
    const deleteRes = await app.request(`/v1/blogs/${createdBlog.id}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    if (deleteRes.status !== 200) {
      throw new Error(`Delete blog failed with status ${deleteRes.status}`)
    }
    console.log('✅ Blog deleted successfully.')

    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY!')
    process.exit(0)
  } catch (err) {
    console.error('❌ Tests failed with error:', err)
    process.exit(1)
  }
}

run()
