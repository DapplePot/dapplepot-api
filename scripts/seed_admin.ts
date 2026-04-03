/**
 * Seeds a default admin user for the dapplepot_dev tenant.
 * Safe to run multiple times (upsert on tenant_id + email).
 *
 * Usage: pnpm seed-admin
 */
import bcrypt from 'bcryptjs'
const { hashSync } = bcrypt
import postgres from 'postgres'
import { config } from 'dotenv'

config()

const TENANT_ID = '00000000-0000-0000-0000-000000000001'  // must match pipeline seed
const ADMIN_EMAIL = 'admin@dapplepot.dev'
const ADMIN_PASSWORD = 'changeme123'
const ADMIN_NAME = 'Dev Admin'

async function seed() {
    const sql = postgres(process.env.POSTGRES_URL!)

    const passwordHash = hashSync(ADMIN_PASSWORD, 12)

    await sql`
        INSERT INTO users (tenant_id, email, name, password_hash, role, status)
        VALUES (${TENANT_ID}, ${ADMIN_EMAIL}, ${ADMIN_NAME}, ${passwordHash}, 'admin', 'active')
        ON CONFLICT ON CONSTRAINT uq_users_tenant_email
        DO UPDATE SET
            password_hash = EXCLUDED.password_hash,
            role = 'admin',
            status = 'active',
            updated_at = now()
    `

    console.log('Seeded admin user:')
    console.log(`  tenant:   dapplepot_dev (${TENANT_ID})`)
    console.log(`  email:    ${ADMIN_EMAIL}`)
    console.log(`  password: ${ADMIN_PASSWORD}`)
    console.log(`  role:     admin`)

    await sql.end()
}

seed().catch((err) => { console.error(err); process.exit(1) })
