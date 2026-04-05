/**
 * Seeds the dapplepot_dev tenant and its admin user.
 * Safe to run multiple times (upserts throughout).
 *
 * Usage: pnpm seed-admin
 */
import bcrypt from 'bcryptjs'
const { hashSync } = bcrypt
import postgres from 'postgres'
import { config } from 'dotenv'

config()

const TENANT_ID    = '00000000-0000-0000-0000-000000000001'  // must match pipeline seed
const TENANT_NAME  = 'dapplepot_dev'

const ADMIN_EMAIL    = 'admin@dapplepot.dev'
const ADMIN_PASSWORD = 'changeme123'
const ADMIN_NAME     = 'Dev Admin'

async function seed() {
    const sql = postgres(process.env.POSTGRES_URL!, { ssl: 'require' })

    // 1. Dev tenant
    await sql`
        INSERT INTO tenants (tenant_id, name, enabled)
        VALUES (${TENANT_ID}, ${TENANT_NAME}, true)
        ON CONFLICT (tenant_id)
        DO UPDATE SET
            name       = EXCLUDED.name,
            enabled    = true,
            updated_at = now()
    `

    console.log('Seeded tenant:')
    console.log(`  id:   ${TENANT_ID}`)
    console.log(`  name: ${TENANT_NAME}`)
    console.log()

    // 2. Admin user scoped to dev tenant
    const passwordHash = hashSync(ADMIN_PASSWORD, 12)
    await sql`
        INSERT INTO users (tenant_id, email, name, password_hash, role, status)
        VALUES (${TENANT_ID}, ${ADMIN_EMAIL}, ${ADMIN_NAME}, ${passwordHash}, 'admin', 'active')
        ON CONFLICT ON CONSTRAINT uq_users_tenant_email
        DO UPDATE SET
            password_hash = EXCLUDED.password_hash,
            name          = EXCLUDED.name,
            role          = 'admin',
            status        = 'active',
            updated_at    = now()
    `

    console.log('Seeded tenant admin user:')
    console.log(`  tenant:   ${TENANT_NAME} (${TENANT_ID})`)
    console.log(`  email:    ${ADMIN_EMAIL}`)
    console.log(`  password: ${ADMIN_PASSWORD}`)
    console.log(`  role:     admin`)

    await sql.end()
}

seed().catch((err) => { console.error(err); process.exit(1) })
