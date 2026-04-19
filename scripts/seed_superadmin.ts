/**
 * Seeds the platform superadmin user (no tenant — platform-level operator).
 * Safe to run multiple times (upsert on email WHERE tenant_id IS NULL).
 *
 * Usage: pnpm seed-superadmin
 */
import bcrypt from 'bcryptjs'
const { hashSync } = bcrypt
import postgres from 'postgres'
import { config } from 'dotenv'

config()

const SUPERADMIN_EMAIL    = 'superadmin@dapplepot.dev'
const SUPERADMIN_PASSWORD = 'superadmin123'
const SUPERADMIN_NAME     = 'Platform Superadmin'

async function seed() {
    const ssl = process.env.POSTGRES_SSL === 'true' ? 'require' : false
    const sql = postgres(process.env.POSTGRES_URL!, { ssl })

    const passwordHash = hashSync(SUPERADMIN_PASSWORD, 12)

    // tenant_id is NULL — superadmin is not scoped to any tenant.
    // Conflict target uses the partial unique index: uq_users_superadmin_email
    // (created in db/postgres/004_users_table.sql)
    await sql`
        INSERT INTO users (tenant_id, email, name, password_hash, role, status)
        VALUES (NULL, ${SUPERADMIN_EMAIL}, ${SUPERADMIN_NAME}, ${passwordHash}, 'superadmin', 'active')
        ON CONFLICT (email) WHERE tenant_id IS NULL
        DO UPDATE SET
            password_hash = EXCLUDED.password_hash,
            name          = EXCLUDED.name,
            role          = 'superadmin',
            status        = 'active',
            updated_at    = now()
    `

    console.log('Seeded superadmin user:')
    console.log(`  tenant:   (none — platform-level)`)
    console.log(`  email:    ${SUPERADMIN_EMAIL}`)
    console.log(`  password: ${SUPERADMIN_PASSWORD}`)
    console.log(`  role:     superadmin`)

    await sql.end()
}

seed().catch((err) => { console.error(err); process.exit(1) })
