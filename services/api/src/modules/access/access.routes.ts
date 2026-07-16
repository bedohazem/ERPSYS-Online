import { Router } from 'express'
import { db } from '../../db/pool'
import { getAuthContext } from '../auth/auth.middleware'
// تشفير كلمة المرور قبل حفظ المستخدم.
import { hashPassword } from '../auth/password'

export const accessRouter = Router()

// ======================================================
// UUID_PATTERN
//
// يمنع إرسال قيم غير صالحة إلى أعمدة UUID داخل PostgreSQL.
// ======================================================
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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

// ======================================================
// POST /api/users
//
// ينشئ مستخدمًا جديدًا داخل شركة المستخدم المسجل.
//
// Body:
// {
//   fullName: string
//   username: string
//   email?: string | null
//   password: string
//   branchId?: string | null
//   roleIds: string[]
// }
//
// الحماية:
// - companyId يؤخذ من Session فقط.
// - يتم التأكد أن الفرع تابع لنفس الشركة.
// - يتم التأكد أن الأدوار مسموحة لنفس الشركة.
// - كلمة المرور تُحفظ Hash فقط.
// - إنشاء المستخدم وربط الأدوار يتم داخل Transaction.
// ======================================================
accessRouter.post('/api/users', async (req, res, next) => {
  try {
    const auth = getAuthContext(res)

    const { fullName, username, email, password, branchId, roleIds } = req.body

    // ====================================================
    // التحقق من الاسم الكامل
    // ====================================================
    if (typeof fullName !== 'string' || !fullName.trim()) {
      return res.status(400).json({
        error: 'fullName is required',
      })
    }

    const normalizedFullName = fullName.trim()

    if (normalizedFullName.length > 150) {
      return res.status(400).json({
        error: 'fullName must not exceed 150 characters',
      })
    }

    // ====================================================
    // التحقق من اسم المستخدم
    //
    // نحفظه بحروف صغيرة لمنع وجود:
    // admin
    // Admin
    // كاسمين مختلفين لنفس الشركة.
    // ====================================================
    if (typeof username !== 'string' || !username.trim()) {
      return res.status(400).json({
        error: 'username is required',
      })
    }

    const normalizedUsername = username.trim().toLowerCase()

    if (normalizedUsername.length < 3 || normalizedUsername.length > 50) {
      return res.status(400).json({
        error: 'username must contain between 3 and 50 characters',
      })
    }

    if (!/^[a-z0-9._-]+$/.test(normalizedUsername)) {
      return res.status(400).json({
        error:
          'username may contain lowercase letters, numbers, dot, underscore and hyphen only',
      })
    }

    // ====================================================
    // التحقق من البريد الإلكتروني الاختياري
    // ====================================================
    const normalizedEmail =
      typeof email === 'string' && email.trim()
        ? email.trim().toLowerCase()
        : null

    if (
      normalizedEmail &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
    ) {
      return res.status(400).json({
        error: 'email is invalid',
      })
    }

    // ====================================================
    // التحقق من كلمة المرور
    // ====================================================
    if (typeof password !== 'string') {
      return res.status(400).json({
        error: 'password is required',
      })
    }

    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({
        error: 'password must contain between 8 and 128 characters',
      })
    }

    // ====================================================
    // التحقق من الفرع الاختياري
    //
    // null يعني أن المستخدم يعمل على مستوى الشركة.
    // ====================================================
    const normalizedBranchId =
      typeof branchId === 'string' && branchId.trim() ? branchId.trim() : null

    if (normalizedBranchId && !UUID_PATTERN.test(normalizedBranchId)) {
      return res.status(400).json({
        error: 'branchId is invalid',
      })
    }

    if (normalizedBranchId) {
      const branchResult = await db.query(
        `
          SELECT id
          FROM branches
          WHERE id = $1
            AND company_id = $2
            AND is_active = TRUE
          LIMIT 1;
        `,
        [normalizedBranchId, auth.companyId],
      )

      if ((branchResult.rowCount ?? 0) === 0) {
        return res.status(400).json({
          error: 'Selected branch does not belong to the current company',
        })
      }
    }

    // ====================================================
    // التحقق من الأدوار
    //
    // يجب اختيار دور واحد على الأقل.
    // ولا نسمح باستخدام Role تابع لشركة أخرى.
    // ====================================================
    if (!Array.isArray(roleIds) || roleIds.length === 0) {
      return res.status(400).json({
        error: 'At least one role is required',
      })
    }

    if (
      roleIds.some(
        (roleId) =>
          typeof roleId !== 'string' || !UUID_PATTERN.test(roleId.trim()),
      )
    ) {
      return res.status(400).json({
        error: 'One or more roleIds are invalid',
      })
    }

    // إزالة أي Role مكرر قبل الحفظ.
    const normalizedRoleIds = Array.from(
      new Set(roleIds.map((roleId: string) => roleId.trim())),
    )

    const rolesResult = await db.query(
      `
        SELECT
          id,
          code
        FROM roles
        WHERE id = ANY($1::uuid[])
          AND (
            company_id = $2
            OR company_id IS NULL
          );
      `,
      [normalizedRoleIds, auth.companyId],
    )

    if ((rolesResult.rowCount ?? 0) !== normalizedRoleIds.length) {
      return res.status(400).json({
        error:
          'One or more selected roles do not belong to the current company',
      })
    }

    // ====================================================
    // منع تكرار اسم المستخدم أو البريد داخل الشركة
    // ====================================================
    const duplicateResult = await db.query(
      `
        SELECT
          username,
          email
        FROM users
        WHERE company_id = $1
          AND (
            LOWER(username) = LOWER($2)
            OR (
              $3::text IS NOT NULL
              AND LOWER(email) = LOWER($3)
            )
          )
        LIMIT 1;
      `,
      [auth.companyId, normalizedUsername, normalizedEmail],
    )

    if ((duplicateResult.rowCount ?? 0) > 0) {
      const duplicateUser = duplicateResult.rows[0]

      if (duplicateUser.username?.toLowerCase() === normalizedUsername) {
        return res.status(409).json({
          error: 'username already exists',
        })
      }

      return res.status(409).json({
        error: 'email already exists',
      })
    }

    // تشفير كلمة المرور خارج الـ Transaction لتقليل مدة القفل.
    const passwordHash = await hashPassword(password)

    const client = await db.connect()

    try {
      await client.query('BEGIN')

      // ==================================================
      // إنشاء المستخدم
      // ==================================================
      const userResult = await client.query(
        `
          INSERT INTO users (
            company_id,
            branch_id,
            full_name,
            username,
            email,
            password_hash
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6
          )
          RETURNING
            id,
            company_id,
            branch_id,
            full_name,
            username,
            email,
            is_active,
            created_at,
            updated_at;
        `,
        [
          auth.companyId,
          normalizedBranchId,
          normalizedFullName,
          normalizedUsername,
          normalizedEmail,
          passwordHash,
        ],
      )

      const createdUser = userResult.rows[0]

      // ==================================================
      // ربط المستخدم بالأدوار المختارة
      // ==================================================
      await client.query(
        `
          INSERT INTO user_roles (
            user_id,
            role_id
          )
          SELECT
            $1,
            UNNEST($2::uuid[]);
        `,
        [createdUser.id, normalizedRoleIds],
      )

      // ==================================================
      // Audit Log
      //
      // لا يتم تسجيل password أو password_hash.
      // ==================================================
      await client.query(
        `
          INSERT INTO audit_logs (
            company_id,
            branch_id,
            user_id,
            action,
            entity_type,
            entity_id,
            old_data,
            new_data,
            ip_address,
            user_agent
          )
          VALUES (
            $1,
            $2,
            $3,
            'user.create',
            'user',
            $4,
            NULL,
            jsonb_build_object(
              'fullName', $5::text,
              'username', $6::text,
              'email', $7::text,
              'branchId', $8::text,
              'roleIds', $9::jsonb
            ),
            $10,
            $11
          );
        `,
        [
          auth.companyId,
          auth.branchId,
          auth.userId,
          createdUser.id,
          normalizedFullName,
          normalizedUsername,
          normalizedEmail,
          normalizedBranchId,
          JSON.stringify(normalizedRoleIds),
          req.ip || null,
          req.get('user-agent')?.slice(0, 500) || null,
        ],
      )

      // ==================================================
      // إعادة المستخدم بالفرع والأدوار لواجهة الإدارة
      // ==================================================
      const createdUserResult = await client.query(
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

          WHERE users.id = $1
            AND users.company_id = $2;
        `,
        [createdUser.id, auth.companyId],
      )

      await client.query('COMMIT')

      return res.status(201).json({
        data: createdUserResult.rows[0],
      })
    } catch (error) {
      await client.query('ROLLBACK')

      // حماية إضافية من طلبين متزامنين بنفس البيانات.
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === '23505'
      ) {
        return res.status(409).json({
          error: 'username or email already exists',
        })
      }

      throw error
    } finally {
      client.release()
    }
  } catch (error) {
    next(error)
  }
})
