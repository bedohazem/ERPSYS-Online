import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { db } from '../../db/pool'

export const suppliersRouter = Router()

function isPostgresUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  )
}

function parseSupplierLimit(value: unknown) {
  const numericValue = Number(value ?? 50)

  if (!Number.isFinite(numericValue)) {
    return 50
  }

  return Math.min(Math.max(Math.trunc(numericValue), 1), 100)
}

// ======================================================
// GET /api/suppliers
//
// عرض الموردين النشطين والبحث بالاسم أو الكود أو الهاتف.
// companyId يتم فرضه من Session.
// ======================================================
suppliersRouter.get('/api/suppliers', async (req, res, next) => {
  try {
    const companyId = req.query.companyId
    const query = req.query.q

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res.status(400).json({
        error: 'companyId query parameter is required',
      })
    }

    const searchText =
      typeof query === 'string' && query.trim() ? `%${query.trim()}%` : null

    const result = await db.query(
      `
        SELECT
          id,
          company_id,
          name,
          code,
          phone,
          email,
          address,
          tax_number,
          is_active,
          created_at,
          updated_at
        FROM suppliers
        WHERE company_id = $1
          AND is_active = TRUE
          AND (
            $2::text IS NULL
            OR name ILIKE $2
            OR code ILIKE $2
            OR phone ILIKE $2
            OR email ILIKE $2
          )
        ORDER BY name ASC
        LIMIT $3;
        `,
      [companyId.trim(), searchText, parseSupplierLimit(req.query.limit)],
    )

    return res.json({
      data: result.rows,
    })
  } catch (error) {
    return next(error)
  }
})

// ======================================================
// POST /api/suppliers
//
// إنشاء مورد جديد داخل الشركة الموثقة.
// ======================================================
suppliersRouter.post('/api/suppliers', async (req, res, next) => {
  try {
    const { companyId, name, code, phone, email, address, taxNumber } = req.body

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res.status(400).json({
        error: 'companyId is required',
      })
    }

    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({
        error: 'Supplier name is required',
      })
    }

    const supplierCode =
      typeof code === 'string' && code.trim()
        ? code.trim().toUpperCase()
        : `SUP-${randomUUID().slice(0, 8).toUpperCase()}`

    const result = await db.query(
      `
        INSERT INTO suppliers (
          company_id,
          name,
          code,
          phone,
          email,
          address,
          tax_number,
          is_active
        )
        VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, TRUE
        )
        RETURNING *;
        `,
      [
        companyId.trim(),
        name.trim(),
        supplierCode,
        typeof phone === 'string' && phone.trim() ? phone.trim() : null,
        typeof email === 'string' && email.trim() ? email.trim() : null,
        typeof address === 'string' && address.trim() ? address.trim() : null,
        typeof taxNumber === 'string' && taxNumber.trim()
          ? taxNumber.trim()
          : null,
      ],
    )

    return res.status(201).json({
      data: result.rows[0],
    })
  } catch (error) {
    if (isPostgresUniqueViolation(error)) {
      return res.status(409).json({
        error: 'كود المورد مستخدم بالفعل.',
      })
    }

    return next(error)
  }
})
