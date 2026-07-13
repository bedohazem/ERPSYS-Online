import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import { db } from '../../db/pool'
import { env } from '../../config/env'
import {
  getAuthContext,
  hashSessionToken,
  requireAuth,
} from './auth.middleware'
import { verifyPassword } from './password'

export const authRouter = Router()

// ======================================================
// Dummy Password Hash
//
// حتى اسم الشركة أو المستخدم غير الصحيح يمر بعملية
// Password Hash أيضًا، لتقليل فرق التوقيت بين الحالات.
// ======================================================

const DUMMY_PASSWORD_HASH =
  'scrypt$16384$8$1$00112233445566778899aabbccddeeff$441bda633ba4f8b7081f0e2cc236c167fe9803a601c55988c41eeabee38ee452d86236fcdccac8c53f93e04b52c7d0959d4ec235d57222c7fb1e4c8c6e7e6405'

// ======================================================
// POST /api/auth/login
//
// Body:
// {
//   companyCode,
//   username,
//   password,
//   sessionName?
// }
// ======================================================
authRouter.post('/api/auth/login', async (req, res, next) => {
  try {
    const { companyCode, username, password, sessionName } = req.body

    if (typeof companyCode !== 'string' || !companyCode.trim()) {
      return res.status(400).json({
        error: 'companyCode is required',
      })
    }

    if (typeof username !== 'string' || !username.trim()) {
      return res.status(400).json({
        error: 'username is required',
      })
    }

    if (typeof password !== 'string' || !password) {
      return res.status(400).json({
        error: 'password is required',
      })
    }

    const normalizedCompanyCode = companyCode.trim()

    const normalizedUsername = username.trim()

    const userResult = await db.query(
      `
        SELECT
          users.id,
          users.company_id,
          users.branch_id,
          users.full_name,
          users.username,
          users.password_hash,
          users.is_active,

          companies.code AS company_code,
          companies.name AS company_name,
          companies.is_active AS company_is_active,

          branches.name AS branch_name,

          ARRAY(
            SELECT DISTINCT roles.code
            FROM user_roles
            JOIN roles
              ON roles.id = user_roles.role_id
            WHERE user_roles.user_id = users.id
            ORDER BY roles.code
          ) AS roles,

          ARRAY(
            SELECT DISTINCT permissions.code
            FROM user_roles
            JOIN role_permissions
              ON role_permissions.role_id =
                 user_roles.role_id
            JOIN permissions
              ON permissions.id =
                 role_permissions.permission_id
            WHERE user_roles.user_id = users.id
            ORDER BY permissions.code
          ) AS permissions

        FROM users

        JOIN companies
          ON companies.id = users.company_id

        LEFT JOIN branches
          ON branches.id = users.branch_id
          AND branches.company_id =
              users.company_id

        WHERE LOWER(companies.code) =
              LOWER($1)
          AND LOWER(users.username) =
              LOWER($2)

        LIMIT 1;
        `,
      [normalizedCompanyCode, normalizedUsername],
    )

    const user = (userResult.rowCount ?? 0) > 0 ? userResult.rows[0] : null

    // عند عدم وجود المستخدم نستخدم Dummy Hash
    // بدل إنهاء الطلب فورًا.
    const selectedPasswordHash = user?.password_hash || DUMMY_PASSWORD_HASH

    const passwordIsValid = await verifyPassword(password, selectedPasswordHash)

    if (
      !user ||
      !passwordIsValid ||
      !user.is_active ||
      !user.company_is_active
    ) {
      return res.status(401).json({
        error: 'Invalid company code, username, or password',
      })
    }

    // التوكن الخام يرجع للمستخدم فقط.
    const token = randomBytes(32).toString('hex')
    const tokenHash = hashSessionToken(token)

    const expiresAt = new Date(
      Date.now() + env.authSessionHours * 60 * 60 * 1000,
    )

    const normalizedSessionName =
      typeof sessionName === 'string' && sessionName.trim()
        ? sessionName.trim().slice(0, 100)
        : 'ERPSYS Session'

    const sessionResult = await db.query(
      `
        INSERT INTO auth_sessions (
          company_id,
          user_id,
          token_hash,
          session_name,
          expires_at,
          ip_address,
          user_agent
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7
        )
        RETURNING
          id,
          expires_at,
          created_at;
        `,
      [
        user.company_id,
        user.id,
        tokenHash,
        normalizedSessionName,
        expiresAt,
        req.ip || null,
        req.get('user-agent')?.slice(0, 500) || null,
      ],
    )

    const session = sessionResult.rows[0]

    res.json({
      data: {
        token,
        tokenType: 'Bearer',
        expiresAt: session.expires_at,

        user: {
          id: user.id,
          fullName: user.full_name,
          username: user.username,

          companyId: user.company_id,
          companyCode: user.company_code,
          companyName: user.company_name,

          branchId: user.branch_id,
          branchName: user.branch_name,

          roles: Array.isArray(user.roles) ? user.roles : [],

          permissions: Array.isArray(user.permissions) ? user.permissions : [],
        },
      },
    })
  } catch (error) {
    next(error)
  }
})

// ======================================================
// GET /api/auth/me
//
// يرجع بيانات المستخدم صاحب Session الحالية.
// ======================================================
authRouter.get('/api/auth/me', requireAuth, (_req, res) => {
  const auth = getAuthContext(res)

  res.json({
    data: {
      userId: auth.userId,
      fullName: auth.fullName,
      username: auth.username,

      companyId: auth.companyId,
      companyCode: auth.companyCode,

      branchId: auth.branchId,
      branchName: auth.branchName,

      roles: auth.roles,
      permissions: auth.permissions,

      expiresAt: auth.expiresAt,
    },
  })
})

// ======================================================
// POST /api/auth/logout
//
// لا نحذف الجلسة.
// نسجل revoked_at للحفاظ على سجل المراجعة.
// ======================================================
authRouter.post('/api/auth/logout', requireAuth, async (_req, res, next) => {
  try {
    const auth = getAuthContext(res)

    await db.query(
      `
        UPDATE auth_sessions
        SET revoked_at = COALESCE(
          revoked_at,
          NOW()
        )
        WHERE id = $1;
        `,
      [auth.sessionId],
    )

    res.status(204).send()
  } catch (error) {
    next(error)
  }
})
