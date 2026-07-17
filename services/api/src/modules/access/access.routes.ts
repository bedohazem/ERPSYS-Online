import { Router } from 'express'
import { db } from '../../db/pool'
import { getAuthContext, requirePermission } from '../auth/auth.middleware'
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
          ) AS roles,

          -- معرّفات الأدوار مطلوبة لتحديد الاختيارات
          -- الحالية عند فتح نموذج تعديل المستخدم.
          ARRAY(
            SELECT roles.id
            FROM user_roles
            JOIN roles
              ON roles.id = user_roles.role_id
            WHERE user_roles.user_id = users.id
            ORDER BY roles.code
          ) AS role_ids

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
// GET /api/users/options
//
// يرجع البيانات المطلوبة لإنشاء مستخدم جديد:
// - الفروع النشطة التابعة للشركة الحالية.
// - الأدوار التابعة للشركة أو الأدوار العامة.
//
// الحماية:
// - users.manage مطلوبة من requireBusinessPermission.
// - roles.manage مطلوبة لأن المستخدم سيمنح أدوارًا.
// ======================================================
accessRouter.get(
  '/api/users/options',

  requirePermission('roles.manage'),

  async (_req, res, next) => {
    try {
      const auth = getAuthContext(res)

      // تحميل الفروع والأدوار بالتوازي.
      const [branchesResult, rolesResult] = await Promise.all([
        db.query(
          `
            SELECT
              id,
              code,
              name
            FROM branches
            WHERE company_id = $1
              AND is_active = TRUE
            ORDER BY name;
          `,
          [auth.companyId],
        ),

        db.query(
          `
            SELECT
              id,
              name,
              code,
              is_system
            FROM roles
            WHERE company_id = $1
               OR company_id IS NULL
            ORDER BY
              is_system DESC,
              name;
          `,
          [auth.companyId],
        ),
      ])

      res.json({
        data: {
          branches: branchesResult.rows,
          roles: rolesResult.rows,
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

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
accessRouter.post(
  '/api/users',

  // ====================================================
  // إنشاء مستخدم يحتاج صلاحيتين:
  //
  // users.manage:
  // لإنشاء المستخدم نفسه.
  //
  // roles.manage:
  // لأن الطلب يختار الأدوار التي ستُمنح للمستخدم.
  //
  // requireBusinessPermission يتحقق من users.manage،
  // وهذا Middleware يضيف التحقق من roles.manage.
  // ====================================================
  requirePermission('roles.manage'),

  async (req, res, next) => {
    try {
      const auth = getAuthContext(res)

      const { fullName, username, email, password, branchId, roleIds } =
        req.body

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
            ) AS roles,

            -- معرّفات الأدوار مطلوبة لتحديد الاختيارات
            -- الحالية عند فتح نموذج تعديل المستخدم.
            ARRAY(
              SELECT roles.id
              FROM user_roles
              JOIN roles
                ON roles.id = user_roles.role_id
              WHERE user_roles.user_id = users.id
              ORDER BY roles.code
            ) AS role_ids

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
  },
)

// ======================================================
// PATCH /api/users/:userId/status
//
// تفعيل أو تعطيل مستخدم تابع للشركة الحالية.
//
// Body:
// {
//   isActive: boolean
// }
//
// الحماية:
// - لا يمكن تعديل مستخدم تابع لشركة أخرى.
// - لا يمكن للمستخدم تعطيل حسابه الحالي.
// - لا يمكن تعطيل آخر Admin نشط داخل الشركة.
// - يتم تسجيل العملية داخل Audit Log.
// ======================================================
accessRouter.patch(
  '/api/users/:userId/status',

  async (req, res, next) => {
    const client = await db.connect()

    try {
      const auth = getAuthContext(res)
      const userId = req.params.userId
      const { isActive } = req.body

      if (!UUID_PATTERN.test(userId)) {
        return res.status(400).json({
          error: 'userId is invalid',
        })
      }

      if (typeof isActive !== 'boolean') {
        return res.status(400).json({
          error: 'isActive must be a boolean',
        })
      }

      // لا نسمح للمستخدم بتعطيل الجلسة التي يعمل بها.
      if (userId === auth.userId && !isActive) {
        return res.status(400).json({
          error: 'You cannot deactivate your current account',
        })
      }

      await client.query('BEGIN')

      // توحيد عمليات تغيير حالة أو أدوار المستخدمين داخل الشركة.
      // يمنع عمليتين متزامنتين من إزالة آخر Admin.
      await client.query(
        `
          SELECT id
          FROM companies
          WHERE id = $1
          FOR UPDATE;
        `,
        [auth.companyId],
      )

      // ==================================================
      // قراءة المستخدم وقفل صفه حتى نهاية الـ Transaction.
      // ==================================================
      const targetUserResult = await client.query(
        `
          SELECT
            users.id,
            users.full_name,
            users.username,
            users.is_active,

            EXISTS (
              SELECT 1
              FROM user_roles
              JOIN roles
                ON roles.id = user_roles.role_id
              WHERE user_roles.user_id = users.id
                AND roles.code = 'admin'
            ) AS is_admin

          FROM users

          WHERE users.id = $1
            AND users.company_id = $2

          FOR UPDATE;
        `,
        [userId, auth.companyId],
      )

      if ((targetUserResult.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK')

        return res.status(404).json({
          error: 'User not found',
        })
      }

      const targetUser = targetUserResult.rows[0]

      // ==================================================
      // منع تعطيل آخر Admin نشط.
      //
      // نقفل كل حسابات Admin النشطة لمنع طلبين متزامنين
      // من تعطيل آخر مديرين في نفس اللحظة.
      // ==================================================
      if (!isActive && targetUser.is_active && targetUser.is_admin) {
        const activeAdminsResult = await client.query(
          `
            SELECT users.id

            FROM users

            WHERE users.company_id = $1
              AND users.is_active = TRUE

              AND EXISTS (
                SELECT 1
                FROM user_roles
                JOIN roles
                  ON roles.id = user_roles.role_id
                WHERE user_roles.user_id = users.id
                  AND roles.code = 'admin'
              )

            ORDER BY users.id

            FOR UPDATE OF users;
          `,
          [auth.companyId],
        )

        if ((activeAdminsResult.rowCount ?? 0) <= 1) {
          await client.query('ROLLBACK')

          return res.status(400).json({
            error: 'The last active admin cannot be deactivated',
          })
        }
      }

      // ==================================================
      // تحديث حالة المستخدم.
      // ==================================================
      await client.query(
        `
          UPDATE users
          SET
            is_active = $1,
            updated_at = NOW()
          WHERE id = $2
            AND company_id = $3;
        `,
        [isActive, userId, auth.companyId],
      )

      // ==================================================
      // تسجيل العملية للمراجعة.
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
            'user.status.update',
            'user',
            $4,
            jsonb_build_object(
              'isActive',
              $5::boolean
            ),
            jsonb_build_object(
              'isActive',
              $6::boolean
            ),
            $7,
            $8
          );
        `,
        [
          auth.companyId,
          auth.branchId,
          auth.userId,
          userId,
          targetUser.is_active,
          isActive,
          req.ip || null,
          req.get('user-agent')?.slice(0, 500) || null,
        ],
      )

      // ==================================================
      // إعادة المستخدم بعد التحديث بنفس شكل جدول الواجهة.
      // ==================================================
      const updatedUserResult = await client.query(
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
            ) AS roles,

            -- معرّفات الأدوار مطلوبة لتحديد الاختيارات
            -- الحالية عند فتح نموذج تعديل المستخدم.
            ARRAY(
              SELECT roles.id
              FROM user_roles
              JOIN roles
                ON roles.id = user_roles.role_id
              WHERE user_roles.user_id = users.id
              ORDER BY roles.code
            ) AS role_ids

          FROM users

          LEFT JOIN branches
            ON branches.id = users.branch_id
            AND branches.company_id = users.company_id

          WHERE users.id = $1
            AND users.company_id = $2;
        `,
        [userId, auth.companyId],
      )

      await client.query('COMMIT')

      return res.json({
        data: updatedUserResult.rows[0],
      })
    } catch (error) {
      await client.query('ROLLBACK')
      next(error)
    } finally {
      client.release()
    }
  },
)

// ======================================================
// PATCH /api/users/:userId
//
// تعديل بيانات مستخدم داخل الشركة الحالية.
//
// Body:
// {
//   fullName: string
//   email?: string | null
//   branchId?: string | null
//   roleIds: string[]
// }
//
// لا يتم تعديل Username أو Password من هذا الـ Route.
// ======================================================
accessRouter.patch(
  '/api/users/:userId',

  // تغيير الأدوار يحتاج roles.manage بالإضافة إلى
  // users.manage المفروضة من requireBusinessPermission.
  requirePermission('roles.manage'),

  async (req, res, next) => {
    const client = await db.connect()

    try {
      const auth = getAuthContext(res)
      // Express قد يعرّف Route Parameter كـ string أو string[].
      // نحوله أولًا إلى قيمة واحدة ثم نتحقق منها.
      const userIdParameter = req.params.userId

      const userId = Array.isArray(userIdParameter)
        ? userIdParameter[0]
        : userIdParameter

      const { fullName, email, branchId, roleIds } = req.body

      if (typeof userId !== 'string' || !UUID_PATTERN.test(userId)) {
        return res.status(400).json({
          error: 'userId is invalid',
        })
      }

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

      const normalizedEmail =
        typeof email === 'string' && email.trim()
          ? email.trim().toLowerCase()
          : null

      if (
        normalizedEmail &&
        (normalizedEmail.length > 254 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail))
      ) {
        return res.status(400).json({
          error: 'email is invalid',
        })
      }

      const normalizedBranchId =
        typeof branchId === 'string' && branchId.trim() ? branchId.trim() : null

      if (normalizedBranchId && !UUID_PATTERN.test(normalizedBranchId)) {
        return res.status(400).json({
          error: 'branchId is invalid',
        })
      }

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

      const normalizedRoleIds = Array.from(
        new Set(roleIds.map((roleId: string) => roleId.trim())),
      )

      await client.query('BEGIN')

      // كل تعديل أدوار أو حالات داخل الشركة يمر على نفس القفل.
      await client.query(
        `
          SELECT id
          FROM companies
          WHERE id = $1
          FOR UPDATE;
        `,
        [auth.companyId],
      )

      // قراءة المستخدم الحالي وقفل صفه حتى انتهاء العملية.
      const targetUserResult = await client.query(
        `
          SELECT
            users.id,
            users.full_name,
            users.email,
            users.branch_id,
            users.is_active,

            ARRAY(
              SELECT roles.id
              FROM user_roles
              JOIN roles
                ON roles.id = user_roles.role_id
              WHERE user_roles.user_id = users.id
              ORDER BY roles.code
            ) AS role_ids,

            EXISTS (
              SELECT 1
              FROM user_roles
              JOIN roles
                ON roles.id = user_roles.role_id
              WHERE user_roles.user_id = users.id
                AND roles.code = 'admin'
            ) AS is_admin

          FROM users

          WHERE users.id = $1
            AND users.company_id = $2

          FOR UPDATE;
        `,
        [userId, auth.companyId],
      )

      if ((targetUserResult.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK')

        return res.status(404).json({
          error: 'User not found',
        })
      }

      const targetUser = targetUserResult.rows[0]

      // التأكد أن الفرع تابع لنفس الشركة ونشط.
      if (normalizedBranchId) {
        const branchResult = await client.query(
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
          await client.query('ROLLBACK')

          return res.status(400).json({
            error: 'Selected branch does not belong to the current company',
          })
        }
      }

      // التأكد أن كل الأدوار تابعة للشركة أو أدوار عامة.
      const rolesResult = await client.query(
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
        await client.query('ROLLBACK')

        return res.status(400).json({
          error:
            'One or more selected roles do not belong to the current company',
        })
      }

      // منع استخدام بريد خاص بمستخدم آخر داخل نفس الشركة.
      if (normalizedEmail) {
        const duplicateEmailResult = await client.query(
          `
            SELECT id
            FROM users
            WHERE company_id = $1
              AND id <> $2
              AND LOWER(email) = LOWER($3)
            LIMIT 1;
          `,
          [auth.companyId, userId, normalizedEmail],
        )

        if ((duplicateEmailResult.rowCount ?? 0) > 0) {
          await client.query('ROLLBACK')

          return res.status(409).json({
            error: 'email already exists',
          })
        }
      }

      const newHasAdminRole = rolesResult.rows.some(
        (role) => role.code === 'admin',
      )

      // منع إزالة دور Admin من آخر Admin نشط.
      if (targetUser.is_active && targetUser.is_admin && !newHasAdminRole) {
        const activeAdminsResult = await client.query(
          `
            SELECT COUNT(*)::integer AS count

            FROM users

            WHERE users.company_id = $1
              AND users.is_active = TRUE

              AND EXISTS (
                SELECT 1
                FROM user_roles
                JOIN roles
                  ON roles.id = user_roles.role_id
                WHERE user_roles.user_id = users.id
                  AND roles.code = 'admin'
              );
          `,
          [auth.companyId],
        )

        const activeAdminsCount = activeAdminsResult.rows[0]?.count ?? 0

        if (activeAdminsCount <= 1) {
          await client.query('ROLLBACK')

          return res.status(400).json({
            error:
              'The admin role cannot be removed from the last active admin',
          })
        }
      }

      // تحديث البيانات الأساسية.
      await client.query(
        `
          UPDATE users
          SET
            full_name = $1,
            email = $2,
            branch_id = $3,
            updated_at = NOW()
          WHERE id = $4
            AND company_id = $5;
        `,
        [
          normalizedFullName,
          normalizedEmail,
          normalizedBranchId,
          userId,
          auth.companyId,
        ],
      )

      // استبدال الأدوار القديمة بالأدوار الجديدة.
      await client.query(
        `
          DELETE FROM user_roles
          WHERE user_id = $1;
        `,
        [userId],
      )

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
        [userId, normalizedRoleIds],
      )

      // تسجيل التعديل بدون بيانات سرية.
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
            'user.update',
            'user',
            $4,

            jsonb_build_object(
              'fullName', $5::text,
              'email', $6::text,
              'branchId', $7::text,
              'roleIds', $8::jsonb
            ),

            jsonb_build_object(
              'fullName', $9::text,
              'email', $10::text,
              'branchId', $11::text,
              'roleIds', $12::jsonb
            ),

            $13,
            $14
          );
        `,
        [
          auth.companyId,
          auth.branchId,
          auth.userId,
          userId,

          targetUser.full_name,
          targetUser.email,
          targetUser.branch_id,
          JSON.stringify(targetUser.role_ids),

          normalizedFullName,
          normalizedEmail,
          normalizedBranchId,
          JSON.stringify(normalizedRoleIds),

          req.ip || null,
          req.get('user-agent')?.slice(0, 500) || null,
        ],
      )

      // إعادة المستخدم بنفس شكل الجدول في Web Admin.
      const updatedUserResult = await client.query(
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
            ) AS roles,

            ARRAY(
              SELECT roles.id
              FROM user_roles
              JOIN roles
                ON roles.id = user_roles.role_id
              WHERE user_roles.user_id = users.id
              ORDER BY roles.code
            ) AS role_ids

          FROM users

          LEFT JOIN branches
            ON branches.id = users.branch_id
            AND branches.company_id = users.company_id

          WHERE users.id = $1
            AND users.company_id = $2;
        `,
        [userId, auth.companyId],
      )

      await client.query('COMMIT')

      return res.json({
        data: updatedUserResult.rows[0],
      })
    } catch (error) {
      await client.query('ROLLBACK')

      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === '23505'
      ) {
        return res.status(409).json({
          error: 'email already exists',
        })
      }

      next(error)
    } finally {
      client.release()
    }
  },
)
