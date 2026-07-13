import { Router } from 'express'
import { db } from '../../db/pool'

export const companiesRouter = Router()

// ======================================================
// GET /api/companies
//
// يرجع الشركة التابعة للجلسة الحالية فقط.
// companyId يتم وضعه تلقائيًا بواسطة Auth Middleware.
// ======================================================
companiesRouter.get('/api/companies', async (req, res, next) => {
  try {
    const companyId = req.query.companyId

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res.status(400).json({
        error: 'Authenticated company is missing',
      })
    }

    const result = await db.query(
      `
        SELECT
          id,
          code,
          name,
          legal_name,
          tax_number,
          is_active,
          created_at,
          updated_at
        FROM companies
        WHERE id = $1;
        `,
      [companyId],
    )

    if ((result.rowCount ?? 0) === 0) {
      return res.status(404).json({
        error: 'Company was not found',
      })
    }

    res.json({
      data: result.rows,
    })
  } catch (error) {
    next(error)
  }
})

// ======================================================
// إنشاء شركة جديدة
//
// مقفول مؤقتًا حتى إنشاء صلاحية Platform Administrator.
// مستخدم الشركة العادي أو Admin داخل الشركة لا يجب أن
// يستطيع إنشاء Tenant جديد.
// ======================================================
companiesRouter.post('/api/companies', (_req, res) => {
  res.status(403).json({
    error: 'Company creation requires platform administrator access',
  })
})
