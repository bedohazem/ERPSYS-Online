import { db } from '../../../services/api/src/db/pool'
import { hashPassword } from '../../../services/api/src/modules/auth/password'

// ======================================================
// الاستخدام:
//
// npm run auth:set-password -- DEMO admin "Password"
//
// لا يتم طباعة كلمة المرور أو حفظها في Git.
// ======================================================

async function main() {
  const companyCode = process.argv[2]
  const username = process.argv[3]
  const password = process.argv[4]

  if (!companyCode || !username || !password) {
    throw new Error(
      'Usage: npm run auth:set-password -- COMPANY_CODE USERNAME PASSWORD',
    )
  }

  const passwordHash = await hashPassword(password)

  const result = await db.query(
    `
    UPDATE users
    SET
      password_hash = $3,
      updated_at = NOW()
    FROM companies
    WHERE companies.id = users.company_id
      AND LOWER(companies.code) =
          LOWER($1)
      AND LOWER(users.username) =
          LOWER($2)
    RETURNING
      users.id,
      users.full_name,
      users.username,
      companies.code AS company_code;
    `,
    [companyCode.trim(), username.trim(), passwordHash],
  )

  if ((result.rowCount ?? 0) === 0) {
    throw new Error('User or company was not found')
  }

  const user = result.rows[0]

  console.log(`Password updated for ${user.company_code}/${user.username}`)
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)

    process.exitCode = 1
  })
  .finally(async () => {
    await db.end()
  })
