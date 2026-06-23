import 'dotenv/config'
import { sql } from '../src/lib/postgres.js'

const TARGET_EMAIL = 'pushpendrapal9516@gmail.com'

async function run() {
  console.log(`Inspecting state for: ${TARGET_EMAIL}\n`)

  const users = await sql`
    SELECT user_id, tenant_id, email, name, role, email_verified_at, created_at
    FROM users WHERE LOWER(email) = LOWER(${TARGET_EMAIL})
  `
  console.log(`users: ${users.length}`)
  if (users.length) console.log(users)

  const pendingTable = await sql`
    SELECT to_regclass('pending_signups') AS exists
  `
  const hasPending = pendingTable[0]?.exists != null
  const pending = hasPending ? await sql`
    SELECT signup_id, email, name, created_at, used_at, expires_at
    FROM pending_signups WHERE LOWER(email) = LOWER(${TARGET_EMAIL})
  ` : []
  console.log(`\npending_signups: ${hasPending ? pending.length : '(table not yet migrated)'}`)
  if (pending.length) console.log(pending)

  const evTable = await sql`SELECT to_regclass('email_verifications') AS exists`
  const hasEv = evTable[0]?.exists != null

  if (!users.length && !pending.length) {
    console.log('\nNothing to delete.')
    await sql.end()
    return
  }

  console.log('\n--- Deleting ---\n')

  await sql.begin(async (tx) => {
    if (hasPending) {
      const deletedPending = await tx`
        DELETE FROM pending_signups WHERE LOWER(email) = LOWER(${TARGET_EMAIL}) RETURNING signup_id
      `
      console.log(`Deleted pending_signups: ${deletedPending.length}`)
    }

    // Clear any open invites for this email so a fresh invite can be sent.
    const deletedInvites = await tx`
      DELETE FROM invites WHERE LOWER(email) = LOWER(${TARGET_EMAIL}) RETURNING invite_id
    `
    console.log(`Deleted invites: ${deletedInvites.length}`)

    for (const u of users) {
      const userId = u.user_id as string
      const tenantId = u.tenant_id as string | null

      if (hasEv) {
        const ev = await tx`
          DELETE FROM email_verifications WHERE user_id = ${userId} RETURNING verification_id
        `
        console.log(`Deleted email_verifications for ${userId}: ${ev.length}`)
      }

      const rt = await tx`
        DELETE FROM refresh_tokens WHERE user_id = ${userId} RETURNING token_id
      `
      console.log(`Deleted refresh_tokens for ${userId}: ${rt.length}`)

      const pr = await tx`
        DELETE FROM password_resets WHERE user_id = ${userId} RETURNING reset_id
      `
      console.log(`Deleted password_resets for ${userId}: ${pr.length}`)

      // 4. Find any tenant owned by this user (personal tenants only)
      if (tenantId) {
        const ownedPersonalTenant = await tx`
          SELECT tenant_id, name, kind FROM tenants
          WHERE tenant_id = ${tenantId} AND owner_user_id = ${userId} AND kind = 'personal'
        `
        if (ownedPersonalTenant.length) {
          // Unlink user from tenant so we can drop the tenant cleanly
          await tx`UPDATE users SET tenant_id = NULL WHERE user_id = ${userId}`
          await tx`UPDATE tenants SET owner_user_id = NULL WHERE tenant_id = ${tenantId}`
          // Drop tenant — sdk_keys CASCADEs from tenant
          const t = await tx`DELETE FROM tenants WHERE tenant_id = ${tenantId} RETURNING tenant_id, name`
          console.log(`Deleted personal tenant:`, t)
        }
      }

      // 5. Finally delete the user
      const ud = await tx`DELETE FROM users WHERE user_id = ${userId} RETURNING user_id, email`
      console.log(`Deleted user:`, ud)
    }
  })

  console.log('\nDone.')
  await sql.end()
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
