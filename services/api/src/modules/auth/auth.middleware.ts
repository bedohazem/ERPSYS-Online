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

// ======================================================
// applyAuthenticatedTenant
//
// تفرض الشركة والفرع والمستخدم من Session الموثقة.
//
// ممنوع الاعتماد على companyId أو branchId المرسلين
// من المتصفح لأن المستخدم يستطيع تغييرهما يدويًا.
// ======================================================
export function applyAuthenticatedTenant(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const auth = getAuthContext(res)

    // ====================================================
    // طلبات إدارة المستخدمين تختار فرع المستخدم المستهدف.
    //
    // لا نستخدم فرع المدير المسجل بدل الفرع المختار؛
    // لأن Access Routes تتحقق بنفسها أن الفرع تابع للشركة.
    // ====================================================
    const requestPath = req.originalUrl.split('?')[0]

    const isUserManagementRequest =
      requestPath === '/api/users' || requestPath.startsWith('/api/users/')

    // إدارة أجهزة POS تحتاج أن يختار مدير الشركة
    // الفرع الذي سيتم ربط الجهاز به.
    //
    // مستخدم الفرع لا يستطيع اختيار فرع آخر؛
    // سيتم فرض فرعه من Session.
    const isPosDeviceManagementRequest =
      requestPath === '/api/pos-devices' ||
      requestPath.startsWith('/api/pos-devices/')

    // ====================================================
    // Query الموثقة
    //
    // ننشئ نسخة جديدة بدل تعديل الكائن الراجع من req.query.
    // ثم نثبتها على نفس Request حتى تقرأ كل Routes
    // نفس البيانات الموثقة.
    // ====================================================
    const authenticatedQuery: Record<string, unknown> = {
      ...(req.query as Record<string, unknown>),

      // الشركة دائمًا من Session.
      companyId: auth.companyId,
    }

    if (auth.branchId) {
      // المستخدم المرتبط بفرع لا يستطيع تغيير الفرع.
      authenticatedQuery.branchId = auth.branchId
    } else {
      // المستخدم العام على مستوى الشركة يرى كل الفروع حاليًا.
      // اختيار فرع محدد سيُضاف لاحقًا بصلاحية مستقلة.
      delete authenticatedQuery.branchId
    }

    // Express يحتوي على Query Getter.
    // إنشاء خاصية على Request يضمن أن كل القراءات التالية
    // تستخدم النسخة الموثقة نفسها.
    Object.defineProperty(req, 'query', {
      value: authenticatedQuery,
      writable: false,
      enumerable: true,
      configurable: true,
    })

    // ====================================================
    // Body الموثقة
    //
    // نلغي أي companyId أو branchId أرسله Frontend
    // ونستبدلهما ببيانات Session.
    // ====================================================
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
      const authenticatedBody = req.body as Record<string, unknown>

      authenticatedBody.companyId = auth.companyId

      // ====================================================
      // فرع أجهزة POS
      //
      // مستخدم الفرع يتم فرض فرعه دائمًا.
      //
      // مدير الشركة غير المرتبط بفرع يستطيع اختيار
      // الفرع المستهدف من شاشة إدارة الأجهزة.
      // ====================================================
      if (isPosDeviceManagementRequest) {
        if (auth.branchId) {
          authenticatedBody.branchId = auth.branchId
        }

        // مدير الشركة يحتفظ بالفرع المختار من الواجهة.
      } else if (!isUserManagementRequest) {
        if (auth.branchId) {
          authenticatedBody.branchId = auth.branchId
        } else {
          // المستخدم غير المرتبط بفرع لا يفرض فرعًا
          // على بقية Business APIs.
          delete authenticatedBody.branchId
        }
      }

      // في /api/users نترك branchId كما أرسلته الواجهة.
      // Access Route تتحقق أن الفرع تابع للشركة الحالية.

      // المستخدم الحالي هو صاحب العملية.
      authenticatedBody.createdBy = auth.userId

      // المستخدم الحالي هو الكاشير في فاتورة Web Admin أو POS.
      if (req.method === 'POST' && req.originalUrl.startsWith('/api/sales')) {
        authenticatedBody.cashierId = auth.userId
      }
    }

    next()
  } catch (error) {
    next(error)
  }
}

// ======================================================
// requirePermission
//
// تمنع الوصول للـ Route إلا لو المستخدم يمتلك
// الصلاحية المطلوبة.
//
// دور admin مسموح له مؤقتًا بكل الصلاحيات
// كحماية إضافية أثناء تأسيس النظام.
// ======================================================
export function requirePermission(permissionCode: string) {
  return (_req: Request, res: Response, next: NextFunction) => {
    try {
      const auth = getAuthContext(res)

      const isAdmin = auth.roles.includes('admin')

      const hasPermission = auth.permissions.includes(permissionCode)

      if (!isAdmin && !hasPermission) {
        return res.status(403).json({
          error: `Permission required: ${permissionCode}`,
        })
      }

      next()
    } catch (error) {
      next(error)
    }
  }
}

// ======================================================
// requireBusinessPermission
//
// يربط كل مجموعة API بالصلاحية المناسبة.
// أي API جديدة غير موجودة بالقائمة يتم رفضها تلقائيًا.
// ======================================================
export function requireBusinessPermission(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const path = req.originalUrl.split('?')[0]

  const isReadRequest = ['GET', 'HEAD', 'OPTIONS'].includes(req.method)

  // ======================================================
  // منشئ المرتجع يحتاج قراءة الفاتورة الأصلية وأصنافها.
  //
  // لا نمنحه sales.create، بل قراءة الفواتير فقط
  // أثناء تنفيذ دورة المرتجع.
  // ======================================================
  if (
    isReadRequest &&
    (path === '/api/sales' || path.startsWith('/api/sales/'))
  ) {
    const auth = getAuthContext(res)

    const hasSalesReadAccess =
      auth.roles.includes('admin') ||
      auth.permissions.includes('sales.view') ||
      auth.permissions.includes('returns.create') ||
      auth.permissions.includes('exchanges.create')

    if (!hasSalesReadAccess) {
      return res.status(403).json({
        error:
          'Permission required: sales.view, returns.create or exchanges.create',
      })
    }

    return next()
  }

  // ======================================================
  // صلاحيات دورة تحويل المخزون.
  //
  // إنشاء التحويل يحتاج create.
  // الشحن يحتاج approve.
  // الاستلام يحتاج receive.
  //
  // أي مستخدم يمتلك واحدة من صلاحيات دورة التحويل
  // يستطيع قراءة التحويلات المرتبطة بفرعه حتى يتمكن
  // من تنفيذ وظيفته.
  // ======================================================
  const isTransferSetupRequest =
    path === '/api/transfers/locations' || path === '/api/transfers/lookup-item'

  // أماكن التخزين والبحث عن الأصناف يحتاجهما
  // مستخدم إنشاء التحويل فقط.
  if (isReadRequest && isTransferSetupRequest) {
    const auth = getAuthContext(res)

    const canCreateTransfer =
      auth.roles.includes('admin') ||
      auth.permissions.includes('inventory.transfer.create')

    if (!canCreateTransfer) {
      return res.status(403).json({
        error: 'Permission required: inventory.transfer.create',
      })
    }

    return next()
  }

  if (path === '/api/transfers' || path.startsWith('/api/transfers/')) {
    // قراءة سجل التحويلات وتفاصيلها متاحة
    // لأي موظف مشارك في دورة التحويل.
    if (isReadRequest) {
      const auth = getAuthContext(res)

      const transferReadPermissions = [
        'inventory.transfer.view',
        'inventory.transfer.create',
        'inventory.transfer.approve',
        'inventory.transfer.receive',
      ]

      const canReadTransfers =
        auth.roles.includes('admin') ||
        transferReadPermissions.some((permission) =>
          auth.permissions.includes(permission),
        )

      if (!canReadTransfers) {
        return res.status(403).json({
          error: 'A stock transfer permission is required',
        })
      }

      return next()
    }

    let requiredPermission = 'inventory.transfer.create'

    if (path.endsWith('/ship')) {
      requiredPermission = 'inventory.transfer.approve'
    } else if (path.endsWith('/receive')) {
      requiredPermission = 'inventory.transfer.receive'
    }

    return requirePermission(requiredPermission)(req, res, next)
  }

  // ======================================================
  // صلاحيات الموردين.
  //
  // منشئ المشتريات يحتاج قراءة الموردين لاختيار المورد،
  // لكنه لا يستطيع إنشاء مورد إلا بصلاحية suppliers.manage.
  // ======================================================
  if (path === '/api/suppliers' || path.startsWith('/api/suppliers/')) {
    if (isReadRequest) {
      const auth = getAuthContext(res)

      const canReadSuppliers =
        auth.roles.includes('admin') ||
        auth.permissions.includes('suppliers.view') ||
        auth.permissions.includes('suppliers.manage') ||
        auth.permissions.includes('purchases.create')

      if (!canReadSuppliers) {
        return res.status(403).json({
          error:
            'Permission required: suppliers.view, suppliers.manage or purchases.create',
        })
      }

      return next()
    }

    return requirePermission('suppliers.manage')(req, res, next)
  }

  // ======================================================
  // صلاحيات المشتريات.
  //
  // منشئ المشتريات يستطيع قراءة أذون الاستلام التي أنشأها
  // أو المرتبطة بفرعه دون اشتراط purchases.view.
  // ======================================================
  if (path === '/api/purchases' || path.startsWith('/api/purchases/')) {
    if (isReadRequest) {
      const auth = getAuthContext(res)

      const canReadPurchases =
        auth.roles.includes('admin') ||
        auth.permissions.includes('purchases.view') ||
        auth.permissions.includes('purchases.create')

      if (!canReadPurchases) {
        return res.status(403).json({
          error: 'Permission required: purchases.view or purchases.create',
        })
      }

      return next()
    }

    return requirePermission('purchases.create')(req, res, next)
  }

  // ======================================================
  // أوامر الشراء.
  //
  // القراءة متاحة لمن يملك purchases.view أو
  // purchases.create.
  //
  // الإنشاء والاستلام يحتاجان purchases.create.
  // ======================================================
  if (
    path === '/api/purchase-orders' ||
    path.startsWith('/api/purchase-orders/')
  ) {
    if (isReadRequest) {
      const auth = getAuthContext(res)

      const canReadPurchaseOrders =
        auth.roles.includes('admin') ||
        auth.permissions.includes('purchases.view') ||
        auth.permissions.includes('purchases.create')

      if (!canReadPurchaseOrders) {
        return res.status(403).json({
          error: 'Permission required: purchases.view or purchases.create',
        })
      }

      return next()
    }

    return requirePermission('purchases.create')(req, res, next)
  }

  // ======================================================
  // صلاحيات المرتجعات.
  //
  // القراءة متاحة لمن يملك view أو create أو void.
  // الإلغاء يحتاج returns.void.
  // باقي الكتابة تحتاج returns.create.
  // ======================================================
  if (path === '/api/returns' || path.startsWith('/api/returns/')) {
    if (isReadRequest) {
      const auth = getAuthContext(res)

      const canReadReturns =
        auth.roles.includes('admin') ||
        auth.permissions.includes('returns.view') ||
        auth.permissions.includes('returns.create') ||
        auth.permissions.includes('returns.void')

      if (!canReadReturns) {
        return res.status(403).json({
          error:
            'Permission required: returns.view, returns.create or returns.void',
        })
      }

      return next()
    }

    if (path.endsWith('/void')) {
      return requirePermission('returns.void')(req, res, next)
    }

    return requirePermission('returns.create')(req, res, next)
  }

  // ======================================================
  // صلاحيات الاستبدالات.
  //
  // القراءة متاحة لمن يملك exchanges.view أو
  // exchanges.create لأن منشئ الاستبدال يحتاج البحث
  // عن الفاتورة والأصناف قبل الحفظ.
  // ======================================================
  if (path === '/api/exchanges' || path.startsWith('/api/exchanges/')) {
    if (isReadRequest) {
      const auth = getAuthContext(res)

      const canReadExchanges =
        auth.roles.includes('admin') ||
        auth.permissions.includes('exchanges.view') ||
        auth.permissions.includes('exchanges.create') ||
        auth.permissions.includes('exchanges.void')

      if (!canReadExchanges) {
        return res.status(403).json({
          error:
            'Permission required: exchanges.view, exchanges.create or exchanges.void',
        })
      }

      return next()
    }

    if (path.endsWith('/void')) {
      return requirePermission('exchanges.void')(req, res, next)
    }

    return requirePermission('exchanges.create')(req, res, next)
  }

  // ======================================================
  // إدارة أجهزة POS.
  //
  // القراءة تحتاج view أو manage.
  // الإنشاء والحظر وتدوير المفتاح تحتاج manage.
  // ======================================================
  if (path === '/api/pos-devices' || path.startsWith('/api/pos-devices/')) {
    if (isReadRequest) {
      const auth = getAuthContext(res)

      const canReadPosDevices =
        auth.roles.includes('admin') ||
        auth.permissions.includes('pos.devices.view') ||
        auth.permissions.includes('pos.devices.manage')

      if (!canReadPosDevices) {
        return res.status(403).json({
          error: 'Permission required: pos.devices.view or pos.devices.manage',
        })
      }

      return next()
    }

    return requirePermission('pos.devices.manage')(req, res, next)
  }

  // ======================================================
  // إدارة ومتابعة Offline POS Sync.
  //
  // القراءة تحتاج pos.sync.view أو pos.sync.manage.
  // تغيير حالة التعارض يحتاج pos.sync.manage.
  // ======================================================
  if (
    path === '/api/pos-sync-admin' ||
    path.startsWith('/api/pos-sync-admin/')
  ) {
    if (isReadRequest) {
      const auth = getAuthContext(res)

      const canReadPosSync =
        auth.roles.includes('admin') ||
        auth.permissions.includes('pos.sync.view') ||
        auth.permissions.includes('pos.sync.manage')

      if (!canReadPosSync) {
        return res.status(403).json({
          error: 'Permission required: pos.sync.view or pos.sync.manage',
        })
      }

      return next()
    }

    return requirePermission('pos.sync.manage')(req, res, next)
  }

  const rules = [
    {
      prefix: '/api/demo',
      read: 'dashboard.view',
    },
    {
      prefix: '/api/companies',
      read: 'dashboard.view',
    },
    {
      prefix: '/api/branches',
      read: 'dashboard.view',
      write: 'users.manage',
    },
    {
      prefix: '/api/catalog',
      read: 'products.view',
      write: 'products.manage',
    },
    {
      prefix: '/api/customers',
      read: 'customers.view',
      write: 'customers.manage',
    },
    {
      prefix: '/api/inventory',
      read: 'inventory.view',
      write: 'inventory.adjust',
    },
    {
      prefix: '/api/sales',
      read: 'sales.view',
      write: 'sales.create',
    },
    {
      prefix: '/api/reports',
      read: 'reports.view',
    },
    {
      // عرض وإدارة مستخدمي الشركة.
      prefix: '/api/users',
      read: 'users.manage',
      write: 'users.manage',
    },
    {
      // عرض وإدارة الأدوار.
      prefix: '/api/roles',
      read: 'roles.manage',
      write: 'roles.manage',
    },
    {
      // كتالوج الصلاحيات يتحكم فيه مدير الأدوار.
      prefix: '/api/permissions',
      read: 'roles.manage',
      write: 'roles.manage',
    },
    {
      // البحث عن صنف داخل POS جزء من إنشاء البيع.
      prefix: '/api/pos',
      read: 'sales.create',
      write: 'sales.create',
    },
  ]

  const rule = rules.find(
    (currentRule) =>
      path === currentRule.prefix || path.startsWith(`${currentRule.prefix}/`),
  )

  // سياسة آمنة: أي Business API غير مسجلة تُرفض.
  if (!rule) {
    return res.status(403).json({
      error: 'Permission policy is missing for this API',
    })
  }

  const permissionCode = isReadRequest ? rule.read : rule.write || rule.read

  return requirePermission(permissionCode)(req, res, next)
}
