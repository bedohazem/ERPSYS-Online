import { Router } from 'express'
import { db } from '../../db/pool'
import { getAuthContext } from '../auth/auth.middleware'
export const posRouter = Router()

const posUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isPosUuid(value: string) {
  return posUuidPattern.test(value)
}

// ======================================================
// GET /api/pos/stock-locations
//
// يعرض أماكن البيع والمخازن الصالحة لإنشاء فاتورة.
//
// المسار موجود تحت /api/pos حتى يحتاج sales.create
// بدل منح الكاشير صلاحية inventory.view.
//
// companyId وbranchId يتم فرضهما من Session الموثقة.
// ======================================================
posRouter.get('/api/pos/stock-locations', async (_req, res, next) => {
  try {
    const auth = getAuthContext(res)

    // إنشاء فاتورة البيع يتطلب مستخدمًا مرتبطًا بفرع.
    if (!auth.branchId) {
      return res.status(409).json({
        error: 'المستخدم الحالي غير مرتبط بفرع ولا يمكنه إنشاء فاتورة بيع.',
      })
    }

    const result = await db.query(
      `
      SELECT
        sl.id,
        sl.branch_id,
        b.name AS branch_name,
        sl.code,
        sl.name,
        sl.location_type
      FROM stock_locations sl

      LEFT JOIN branches b
        ON b.id = sl.branch_id
        AND b.company_id = sl.company_id

      WHERE sl.company_id = $1
        AND sl.is_active = TRUE

        -- أماكن مسموح بإجراء البيع منها فقط.
        AND sl.location_type IN (
          'sales_floor',
          'branch_warehouse',
          'main_warehouse'
        )

        -- المخزن المركزي مسموح، أو مكان تابع لفرع المستخدم.
        AND (
          sl.branch_id IS NULL
          OR (
            sl.branch_id::text = $2
            AND b.is_active = TRUE
          )
        )

      ORDER BY
        CASE sl.location_type
          WHEN 'sales_floor' THEN 1
          WHEN 'branch_warehouse' THEN 2
          WHEN 'main_warehouse' THEN 3
          ELSE 4
        END,
        sl.name ASC;
      `,
      [auth.companyId, auth.branchId],
    )

    res.json({ data: result.rows })
  } catch (error) {
    next(error)
  }
})

// ======================================================
// GET /api/pos/customers
//
// بحث محدود عن العملاء النشطين أثناء إنشاء فاتورة بيع.
//
// وضعناه تحت /api/pos حتى يحتاج sales.create فقط،
// ولا نضطر لمنح الكاشير صلاحية customers.view.
//
// companyId يتم فرضه من Session الموثقة.
// ======================================================
posRouter.get('/api/pos/customers', async (req, res, next) => {
  try {
    const auth = getAuthContext(res)
    const query = req.query.q

    const searchText =
      typeof query === 'string' && query.trim() ? `%${query.trim()}%` : null

    // حد صغير مناسب لقائمة الاختيار داخل شاشة البيع.
    const result = await db.query(
      `
      SELECT
        id,
        name,
        phone,
        email,
        address,
        is_active
      FROM customers
      WHERE company_id = $1
        AND is_active = TRUE
        AND (
          $2::text IS NULL
          OR name ILIKE $2
          OR phone ILIKE $2
          OR email ILIKE $2
        )
      ORDER BY name ASC
      LIMIT 20;
      `,
      [auth.companyId, searchText],
    )

    res.json({
      data: result.rows,
    })
  } catch (error) {
    next(error)
  }
})

// ======================================================
// GET /api/pos/lookup-item
//
// بحث آمن بالباركود أو SKU.
//
// لا نثق في stockLocationId القادم من المتصفح؛
// يجب أن يكون تابعًا لنفس الشركة ومسموحًا لفرع المستخدم.
// ======================================================
posRouter.get('/api/pos/lookup-item', async (req, res, next) => {
  try {
    const auth = getAuthContext(res)

    const stockLocationId = req.query.stockLocationId

    const code = req.query.code

    if (
      typeof stockLocationId !== 'string' ||
      !isPosUuid(stockLocationId.trim())
    ) {
      return res.status(400).json({
        error: 'stockLocationId is invalid',
      })
    }

    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({
        error: 'code query parameter is required',
      })
    }

    const result = await db.query(
      `
        SELECT
          pv.id AS variant_id,
          pv.product_id,

          p.name AS product_name,

          pv.sku,
          pv.style_code,
          pv.primary_barcode,

          fs.name AS size_name,
          fs.code AS size_code,

          fc.name AS color_name,
          fc.code AS color_code,

          pv.cost_price,
          pv.selling_price,

          COALESCE(
            sb.quantity,
            0
          ) AS available_quantity,

          sl.id AS stock_location_id,
          sl.name AS stock_location_name,
          sl.code AS stock_location_code

        FROM stock_locations sl

        JOIN product_variants pv
          ON pv.company_id = sl.company_id
          AND pv.status = 'active'

        JOIN products p
          ON p.id = pv.product_id
          AND p.company_id = pv.company_id

        LEFT JOIN fashion_sizes fs
          ON fs.id = pv.size_id

        LEFT JOIN fashion_colors fc
          ON fc.id = pv.color_id

        LEFT JOIN variant_barcodes vb
          ON vb.variant_id = pv.id
          AND vb.company_id = pv.company_id

        LEFT JOIN stock_balances sb
          ON sb.variant_id = pv.id
          AND sb.company_id = pv.company_id
          AND sb.stock_location_id = sl.id

        WHERE sl.company_id = $1
          AND sl.id = $2
          AND sl.is_active = TRUE

          -- مدير الشركة يرى كل الأماكن المسموحة.
          -- مستخدم الفرع يرى المركزي أو فرعه فقط.
          AND (
            $4::uuid IS NULL
            OR sl.branch_id IS NULL
            OR sl.branch_id = $4::uuid
          )

          AND sl.location_type IN (
            'sales_floor',
            'branch_warehouse',
            'main_warehouse'
          )

          AND (
            pv.primary_barcode = $3
            OR pv.sku = $3
            OR vb.barcode = $3
          )

        LIMIT 1;
        `,
      [auth.companyId, stockLocationId.trim(), code.trim(), auth.branchId],
    )

    if ((result.rowCount ?? 0) === 0) {
      return res.status(404).json({
        error: 'الصنف غير موجود أو مكان التخزين غير مسموح.',
      })
    }

    return res.json({
      data: result.rows[0],
    })
  } catch (error) {
    return next(error)
  }
})

// ======================================================
// GET /api/pos/search-items
//
// بحث آمن بالاسم أو SKU أو الباركود داخل مكان بيع موثوق.
// ======================================================
posRouter.get('/api/pos/search-items', async (req, res, next) => {
  try {
    const companyId = req.query.companyId
    const branchId = req.query.branchId

    const stockLocationId = req.query.stockLocationId

    const query = req.query.q

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res.status(400).json({
        error: 'companyId query parameter is required',
      })
    }

    if (
      typeof stockLocationId !== 'string' ||
      !isPosUuid(stockLocationId.trim())
    ) {
      return res.status(400).json({
        error: 'stockLocationId is invalid',
      })
    }

    if (typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({
        error: 'q query parameter is required',
      })
    }

    const authenticatedBranchId =
      typeof branchId === 'string' && branchId.trim() ? branchId.trim() : null

    const searchText = `%${query.trim()}%`

    const result = await db.query(
      `
        SELECT DISTINCT
          pv.id AS variant_id,
          pv.product_id,

          p.name AS product_name,

          pv.sku,
          pv.primary_barcode,

          fs.name AS size_name,
          fc.name AS color_name,

          pv.selling_price,

          COALESCE(
            sb.quantity,
            0
          ) AS available_quantity,

          sl.id AS stock_location_id,
          sl.name AS stock_location_name

        FROM stock_locations sl

        JOIN product_variants pv
          ON pv.company_id = sl.company_id
          AND pv.status = 'active'

        JOIN products p
          ON p.id = pv.product_id
          AND p.company_id = pv.company_id

        LEFT JOIN fashion_sizes fs
          ON fs.id = pv.size_id

        LEFT JOIN fashion_colors fc
          ON fc.id = pv.color_id

        LEFT JOIN variant_barcodes vb
          ON vb.variant_id = pv.id
          AND vb.company_id = pv.company_id

        LEFT JOIN stock_balances sb
          ON sb.variant_id = pv.id
          AND sb.company_id = pv.company_id
          AND sb.stock_location_id = sl.id

        WHERE sl.company_id = $1
          AND sl.id = $2
          AND sl.is_active = TRUE

          AND (
            $4::uuid IS NULL
            OR sl.branch_id IS NULL
            OR sl.branch_id = $4::uuid
          )

          AND sl.location_type IN (
            'sales_floor',
            'branch_warehouse',
            'main_warehouse'
          )

          AND (
            p.name ILIKE $3
            OR pv.sku ILIKE $3
            OR pv.primary_barcode ILIKE $3
            OR vb.barcode ILIKE $3
          )

        ORDER BY
          p.name ASC,
          pv.sku ASC

        LIMIT 20;
        `,
      [
        companyId.trim(),
        stockLocationId.trim(),
        searchText,
        authenticatedBranchId,
      ],
    )

    return res.json({
      data: result.rows,
    })
  } catch (error) {
    return next(error)
  }
})
