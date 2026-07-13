import { createHash } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { db } from '../../db/pool'

// ======================================================
// AuthContext
//
// البيانات الموثوقة الخاصة بالمستخدم الحالي.
// لاحقًا كل Routes ستأخذ companyId وuserId من هنا.
// ======================================================

export type AuthContext = {
  sessionId: string

  userId: string
  companyId: string
  companyCode: string

  branchId: string | null
  branchName: string | null

  fullName: string
  username: string

  roles: string[]
  permissions: string[]

  expiresAt: string
}

// ======================================================
// hashSessionToken
//
// نخزن ونبحث باستخدام SHA-256 فقط.
// التوكن الخام لا يتم تخزينه داخل PostgreSQL.
// ======================================================
export function hashSessionToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

// ======================================================
// requireAuth
//
// يقرأ:
//
// Authorization: Bearer TOKEN
//
// ثم يتأكد أن:
// - الجلسة موجودة.
// - لم يتم إلغاؤها.
// - لم تنتهِ.
// - المستخدم والشركة نشطان.
// ======================================================
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const authorization = req.get('authorization')

    if (!authorization || !authorization.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Authentication is required',
      })
    }

    const token = authorization.slice('Bearer '.length).trim()

    // التوكن يتكون من 32 Byte ممثلة في 64 Hex Character.
    if (!/^[0-9a-f]{64}$/i.test(token)) {
      return res.status(401).json({
        error: 'Invalid authentication token',
      })
    }

    const tokenHash = hashSessionToken(token)

    const result = await db.query(
      `
      SELECT
        auth_sessions.id AS session_id,
        auth_sessions.expires_at,

        users.id AS user_id,
        users.company_id,
        users.branch_id,
        users.full_name,
        users.username,

        companies.code AS company_code,

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

      FROM auth_sessions

      JOIN users
        ON users.id = auth_sessions.user_id
        AND users.company_id =
            auth_sessions.company_id

      JOIN companies
        ON companies.id = auth_sessions.company_id

      LEFT JOIN branches
        ON branches.id = users.branch_id
        AND branches.company_id =
            users.company_id

      WHERE auth_sessions.token_hash = $1
        AND auth_sessions.revoked_at IS NULL
        AND auth_sessions.expires_at > NOW()
        AND users.is_active = TRUE
        AND companies.is_active = TRUE

      LIMIT 1;
      `,
      [tokenHash],
    )

    if ((result.rowCount ?? 0) === 0) {
      return res.status(401).json({
        error: 'Session is invalid or expired',
      })
    }

    const row = result.rows[0]

    const authContext: AuthContext = {
      sessionId: row.session_id,

      userId: row.user_id,
      companyId: row.company_id,
      companyCode: row.company_code,

      branchId: row.branch_id,
      branchName: row.branch_name,

      fullName: row.full_name,
      username: row.username,

      roles: Array.isArray(row.roles) ? row.roles : [],

      permissions: Array.isArray(row.permissions) ? row.permissions : [],

      expiresAt: row.expires_at,
    }

    // نحفظ السياق داخل res.locals.
    // لا نعتمد على companyId القادم من Body أو Query.
    res.locals.auth = authContext

    // تحديث آخر استخدام مرة كل خمس دقائق فقط
    // لتجنب كتابة قاعدة البيانات مع كل Request.
    await db.query(
      `
      UPDATE auth_sessions
      SET last_seen_at = NOW()
      WHERE id = $1
        AND last_seen_at <
            NOW() - INTERVAL '5 minutes';
      `,
      [authContext.sessionId],
    )

    next()
  } catch (error) {
    next(error)
  }
}

// ======================================================
// getAuthContext
//
// تستخرج المستخدم الموثق من Route محمي.
// ======================================================
export function getAuthContext(res: Response): AuthContext {
  const authContext = res.locals.auth as AuthContext | undefined

  if (!authContext) {
    throw new Error('Authenticated user context is missing')
  }

  return authContext
}
