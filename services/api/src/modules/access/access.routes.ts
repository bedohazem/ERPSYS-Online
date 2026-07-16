import { Router } from 'express'
import { db } from '../../db/pool'
import { getAuthContext } from '../auth/auth.middleware'

export const accessRouter = Router()

// ======================================================
// GET /api/users
//
// يعرض مستخدمي الشركة الحالية فقط.
//
// الشركة لا تأتي من Query أو Body.
// يتم أخذها من Session الموثقة لمنع الوصول
// إلى مستخدمي شركة أخرى.
// ======================================================
accessRouter.get('/api/users', async (_req, res, next) => {
  try {
    const auth = getAuthContext(res)

    const result = await db.query(
      `
        SELECT
          users.id,
          users.company_id,
          users.branch_id,
          users.full_name,
          users.username,
          users.email,
          users.is_active,
          users.created_at,
          users.updated_at,

          branches.code AS branch_code,
          branches.name AS branch_name,

          ARRAY(
            SELECT roles.code
            FROM user_roles
            JOIN roles
              ON roles.id = user_roles.role_id
            WHERE user_roles.user_id = users.id
            ORDER BY roles.code
          ) AS roles

        FROM users

        LEFT JOIN branches
          ON branches.id = users.branch_id
          AND branches.company_id = users.company_id

        WHERE users.company_id = $1

        ORDER BY
          users.full_name,
          users.username;
      `,
      [auth.companyId],
    )

    res.json({
      data: result.rows,
    })
  } catch (error) {
    next(error)
  }
})

// ======================================================
// GET /api/roles
//
// يعرض أدوار الشركة الحالية، بالإضافة إلى أي أدوار
// عامة يكون company_id الخاص بها NULL.
//
// كل Role يرجع ومعه أكواد الصلاحيات المرتبطة به.
// ======================================================
accessRouter.get('/api/roles', async (_req, res, next) => {
  try {
    const auth = getAuthContext(res)

    const result = await db.query(
      `
        SELECT
          roles.id,
          roles.company_id,
          roles.name,
          roles.code,
          roles.is_system,
          roles.created_at,

          ARRAY(
            SELECT permissions.code
            FROM role_permissions
            JOIN permissions
              ON permissions.id =
                 role_permissions.permission_id
            WHERE role_permissions.role_id = roles.id
            ORDER BY permissions.code
          ) AS permissions

        FROM roles

        WHERE roles.company_id = $1
           OR roles.company_id IS NULL

        ORDER BY
          roles.is_system DESC,
          roles.name;
      `,
      [auth.companyId],
    )

    res.json({
      data: result.rows,
    })
  } catch (error) {
    next(error)
  }
})

// ======================================================
// GET /api/permissions
//
// يعرض كتالوج الصلاحيات الكامل.
//
// جدول permissions عام للنظام وليس مرتبطًا بشركة محددة.
// ======================================================
accessRouter.get('/api/permissions', async (_req, res, next) => {
  try {
    const result = await db.query(
      `
        SELECT
          id,
          code,
          description

        FROM permissions

        ORDER BY code;
      `,
    )

    res.json({
      data: result.rows,
    })
  } catch (error) {
    next(error)
  }
})
