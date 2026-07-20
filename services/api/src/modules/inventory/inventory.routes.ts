import { Router } from 'express'
import { db } from '../../db/pool'

export const inventoryRouter = Router()

// ======================================================
// أخطاء المخزون المتوقعة.
// ======================================================
class InventoryApiError extends Error {
  statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

const inventoryUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isInventoryUuid(value: string) {
  return inventoryUuidPattern.test(value)
}

// ======================================================
// GET /api/inventory/lookup-item
//
// البحث عن صنف بالباركود أو SKU داخل مكان تخزين محدد.
// الشركة والفرع يتم فرضهما من Session.
// ======================================================
inventoryRouter.get('/api/inventory/lookup-item', async (req, res, next) => {
  try {
    const companyId = req.query.companyId
    const branchId = req.query.branchId
    const stockLocationId = req.query.stockLocationId
    const code = req.query.code

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res.status(400).json({
        error: 'companyId query parameter is required',
      })
    }

    if (
      typeof stockLocationId !== 'string' ||
      !isInventoryUuid(stockLocationId.trim())
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

    const selectedBranchId =
      typeof branchId === 'string' && branchId.trim() ? branchId.trim() : null

    const result = await db.query(
      `
        SELECT
          pv.id AS variant_id,
          pv.product_id,
          p.name AS product_name,
          pv.sku,
          pv.primary_barcode,
          fs.name AS size_name,
          fc.name AS color_name,
          pv.cost_price,
          pv.selling_price,
          COALESCE(sb.quantity, 0) AS current_quantity,
          sl.id AS stock_location_id,
          sl.name AS stock_location_name,
          sl.code AS stock_location_code
        FROM product_variants pv

        JOIN products p
          ON p.id = pv.product_id
          AND p.company_id = pv.company_id

        JOIN stock_locations sl
          ON sl.id = $2
          AND sl.company_id = pv.company_id
          AND sl.is_active = TRUE

        LEFT JOIN fashion_sizes fs
          ON fs.id = pv.size_id

        LEFT JOIN fashion_colors fc
          ON fc.id = pv.color_id

        LEFT JOIN variant_barcodes vb
          ON vb.variant_id = pv.id
          AND vb.company_id = pv.company_id

        LEFT JOIN stock_balances sb
          ON sb.company_id = pv.company_id
          AND sb.stock_location_id = sl.id
          AND sb.variant_id = pv.id

        WHERE pv.company_id = $1
          AND pv.status = 'active'

          -- مستخدم الفرع لا يستطيع اختيار مخزن فرع آخر.
          AND (
            $4::uuid IS NULL
            OR sl.branch_id = $4::uuid
          )

          AND (
            pv.primary_barcode = $3
            OR pv.sku = $3
            OR vb.barcode = $3
          )

        LIMIT 1;
        `,
      [companyId.trim(), stockLocationId.trim(), code.trim(), selectedBranchId],
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
// GET /api/inventory/stock-movements
// الهدف:
// عرض سجل حركات المخزون
//
// كل تغيير في المخزون لازم يبقى له حركة هنا
// أمثلة:
// - opening_balance
// - sale
// - return
// - adjustment
// - purchase
// - transfer
//
// مثال:
// /api/inventory/stock-movements?companyId=xxx
//
// ممكن نفلتر:
// /api/inventory/stock-movements?companyId=xxx&variantId=yyy
// /api/inventory/stock-movements?companyId=xxx&stockLocationId=zzz
// /api/inventory/stock-movements?companyId=xxx&movementType=sale
// ======================================================
inventoryRouter.get(
  '/api/inventory/stock-movements',
  async (req, res, next) => {
    try {
      const companyId = req.query.companyId
      const variantId = req.query.variantId
      const stockLocationId = req.query.stockLocationId
      const movementType = req.query.movementType
      const branchId = req.query.branchId

      // limit عشان ما نرجعش عدد ضخم من الحركات مرة واحدة
      const limit = Math.min(Number(req.query.limit || 100), 200)

      if (typeof companyId !== 'string' || !companyId.trim()) {
        return res
          .status(400)
          .json({ error: 'companyId query parameter is required' })
      }

      const selectedVariantId =
        typeof variantId === 'string' && variantId.trim() ? variantId : null

      const selectedStockLocationId =
        typeof stockLocationId === 'string' && stockLocationId.trim()
          ? stockLocationId
          : null

      const selectedMovementType =
        typeof movementType === 'string' && movementType.trim()
          ? movementType
          : null

      const selectedBranchId =
        typeof branchId === 'string' && branchId.trim() ? branchId.trim() : null

      const result = await db.query(
        `
      SELECT
        sm.id,
        sm.company_id,
        sm.branch_id,
        b.name AS branch_name,
        sm.stock_location_id,
        sl.name AS stock_location_name,
        sl.code AS stock_location_code,
        sm.variant_id,
        pv.sku,
        pv.primary_barcode,
        p.name AS product_name,
        fs.name AS size_name,
        fc.name AS color_name,
        sm.movement_type,
        sm.quantity,
        sm.quantity_before,
        sm.quantity_after,
        sm.reference_type,
        sm.reference_id,
        sm.note,
        sm.created_by,
        u.full_name AS created_by_name,
        sm.created_at
      FROM stock_movements sm
      LEFT JOIN branches b ON b.id = sm.branch_id
      JOIN stock_locations sl ON sl.id = sm.stock_location_id
      JOIN product_variants pv ON pv.id = sm.variant_id
      JOIN products p ON p.id = pv.product_id
      LEFT JOIN fashion_sizes fs ON fs.id = pv.size_id
      LEFT JOIN fashion_colors fc ON fc.id = pv.color_id
      LEFT JOIN users u ON u.id = sm.created_by
      WHERE sm.company_id = $1
        AND ($2::uuid IS NULL OR sm.variant_id = $2::uuid)
        AND ($3::uuid IS NULL OR sm.stock_location_id = $3::uuid)
        AND ($4::text IS NULL OR sm.movement_type = $4::text)
        AND ($5::uuid IS NULL OR sm.branch_id = $5::uuid)
      ORDER BY sm.created_at DESC
      LIMIT $6;
      `,
        [
          companyId,
          selectedVariantId,
          selectedStockLocationId,
          selectedMovementType,
          selectedBranchId,
          limit,
        ],
      )

      res.json({ data: result.rows })
    } catch (error) {
      next(error)
    }
  },
)

inventoryRouter.get(
  '/api/inventory/stock-locations',
  async (req, res, next) => {
    try {
      const companyId = req.query.companyId
      const branchId = req.query.branchId

      const selectedBranchId =
        typeof branchId === 'string' && branchId.trim() ? branchId.trim() : null

      if (typeof companyId !== 'string' || !companyId.trim()) {
        return res
          .status(400)
          .json({ error: 'companyId query parameter is required' })
      }

      const result = await db.query(
        `
      SELECT
        id,
        company_id,
        branch_id,
        code,
        name,
        location_type,
        is_active,
        created_at,
        updated_at
      FROM stock_locations
      WHERE company_id = $1
        AND is_active = TRUE
        AND (
          $2::uuid IS NULL
          OR branch_id = $2::uuid
        )
      ORDER BY name ASC;
      `,
        [companyId, selectedBranchId],
      )

      res.json({ data: result.rows })
    } catch (error) {
      next(error)
    }
  },
)

inventoryRouter.get('/api/inventory/stock-balances', async (req, res, next) => {
  try {
    const companyId = req.query.companyId
    const branchId = req.query.branchId

    const selectedBranchId =
      typeof branchId === 'string' && branchId.trim() ? branchId.trim() : null

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res
        .status(400)
        .json({ error: 'companyId query parameter is required' })
    }

    const result = await db.query(
      `
      SELECT
        sb.id,
        sb.company_id,
        sb.branch_id,
        sb.stock_location_id,
        sl.name AS stock_location_name,
        sl.code AS stock_location_code,
        sl.location_type,
        sb.variant_id,
        pv.sku,
        pv.primary_barcode,
        p.name AS product_name,
        fs.name AS size_name,
        fc.name AS color_name,
        sb.quantity,
        sb.updated_at
      FROM stock_balances sb
      JOIN stock_locations sl ON sl.id = sb.stock_location_id
      JOIN product_variants pv ON pv.id = sb.variant_id
      JOIN products p ON p.id = pv.product_id
      LEFT JOIN fashion_sizes fs ON fs.id = pv.size_id
      LEFT JOIN fashion_colors fc ON fc.id = pv.color_id
      WHERE sb.company_id = $1
        AND (
          $2::uuid IS NULL
          OR sl.branch_id = $2::uuid
        )
      ORDER BY p.name ASC, pv.sku ASC, sl.name ASC;
      `,
      [companyId, selectedBranchId],
    )

    res.json({ data: result.rows })
  } catch (error) {
    next(error)
  }
})

// ======================================================
// POST /api/inventory/opening-balance
//
// تسجيل رصيد افتتاحي مرة واحدة فقط للصنف والمكان.
// لا تتم إضافة الكمية على رصيد سابق.
// ======================================================
inventoryRouter.post(
  '/api/inventory/opening-balance',
  async (req, res, next) => {
    const client = await db.connect()

    try {
      const {
        companyId,
        branchId,
        stockLocationId,
        variantId,
        quantity,
        note,
        createdBy,
      } = req.body

      if (typeof companyId !== 'string' || !companyId.trim()) {
        return res.status(400).json({
          error: 'companyId is required',
        })
      }

      if (
        typeof stockLocationId !== 'string' ||
        !isInventoryUuid(stockLocationId.trim())
      ) {
        return res.status(400).json({
          error: 'stockLocationId is invalid',
        })
      }

      if (typeof variantId !== 'string' || !isInventoryUuid(variantId.trim())) {
        return res.status(400).json({
          error: 'variantId is invalid',
        })
      }

      const numericQuantity = Number(quantity)

      if (!Number.isFinite(numericQuantity) || numericQuantity <= 0) {
        return res.status(400).json({
          error: 'quantity must be greater than zero',
        })
      }

      const authenticatedBranchId =
        typeof branchId === 'string' && branchId.trim() ? branchId.trim() : null

      await client.query('BEGIN')

      // التحقق من الصنف ومكان التخزين معًا.
      const contextResult = await client.query(
        `
        SELECT
          sl.id AS stock_location_id,
          sl.branch_id AS trusted_branch_id,
          sl.name AS stock_location_name,
          sl.code AS stock_location_code,
          pv.id AS variant_id,
          pv.sku,
          pv.primary_barcode,
          p.name AS product_name
        FROM stock_locations sl

        JOIN product_variants pv
          ON pv.id = $2
          AND pv.company_id = sl.company_id
          AND pv.status = 'active'

        JOIN products p
          ON p.id = pv.product_id
          AND p.company_id = pv.company_id

        WHERE sl.company_id = $1
          AND sl.id = $3
          AND sl.is_active = TRUE

          -- مستخدم الفرع لا يعدل مخزن فرع آخر
          -- أو المخزن المركزي.
          AND (
            $4::uuid IS NULL
            OR sl.branch_id = $4::uuid
          )

        LIMIT 1;
        `,
        [
          companyId.trim(),
          variantId.trim(),
          stockLocationId.trim(),
          authenticatedBranchId,
        ],
      )

      if ((contextResult.rowCount ?? 0) === 0) {
        throw new InventoryApiError(
          404,
          'الصنف أو مكان التخزين غير موجود أو غير مسموح.',
        )
      }

      const trustedContext = contextResult.rows[0]

      await client.query(
        `
        INSERT INTO stock_balances (
          company_id,
          branch_id,
          stock_location_id,
          variant_id,
          quantity
        )
        VALUES ($1, $2, $3, $4, 0)

        ON CONFLICT (
          company_id,
          stock_location_id,
          variant_id
        )
        DO NOTHING;
        `,
        [
          companyId.trim(),
          trustedContext.trusted_branch_id,
          stockLocationId.trim(),
          variantId.trim(),
        ],
      )

      const balanceBeforeResult = await client.query(
        `
          SELECT
            id,
            quantity
          FROM stock_balances
          WHERE company_id = $1
            AND stock_location_id = $2
            AND variant_id = $3
          FOR UPDATE;
          `,
        [companyId.trim(), stockLocationId.trim(), variantId.trim()],
      )

      if ((balanceBeforeResult.rowCount ?? 0) === 0) {
        throw new InventoryApiError(500, 'Stock balance row was not created')
      }

      const quantityBefore = Number(balanceBeforeResult.rows[0].quantity)

      // أي حركة سابقة تعني أن الصنف بدأ العمل عليه بالفعل.
      const previousMovementResult = await client.query(
        `
          SELECT id
          FROM stock_movements
          WHERE company_id = $1
            AND stock_location_id = $2
            AND variant_id = $3
          LIMIT 1;
          `,
        [companyId.trim(), stockLocationId.trim(), variantId.trim()],
      )

      if (quantityBefore !== 0 || (previousMovementResult.rowCount ?? 0) > 0) {
        throw new InventoryApiError(
          409,
          'تم تسجيل رصيد أو حركة سابقة لهذا الصنف داخل المكان المختار.',
        )
      }

      const quantityAfter = numericQuantity

      const balanceResult = await client.query(
        `
        UPDATE stock_balances
        SET
          quantity = $1,
          branch_id = $2,
          updated_at = NOW()
        WHERE company_id = $3
          AND stock_location_id = $4
          AND variant_id = $5
        RETURNING *;
        `,
        [
          quantityAfter,
          trustedContext.trusted_branch_id,
          companyId.trim(),
          stockLocationId.trim(),
          variantId.trim(),
        ],
      )

      const movementResult = await client.query(
        `
        INSERT INTO stock_movements (
          company_id,
          branch_id,
          stock_location_id,
          variant_id,
          movement_type,
          quantity,
          quantity_before,
          quantity_after,
          reference_type,
          reference_id,
          note,
          created_by
        )
        VALUES (
          $1, $2, $3, $4,
          'adjustment',
          $5, $6, $7,
          'opening_balance',
          NULL,
          $8,
          $9
        )
        RETURNING *;
        `,
        [
          companyId.trim(),
          trustedContext.trusted_branch_id,
          stockLocationId.trim(),
          variantId.trim(),
          numericQuantity,
          quantityBefore,
          quantityAfter,
          typeof note === 'string' && note.trim()
            ? note.trim()
            : 'Opening balance',
          createdBy || null,
        ],
      )

      await client.query('COMMIT')

      return res.status(201).json({
        data: {
          balance: balanceResult.rows[0],
          movement: movementResult.rows[0],
          item: trustedContext,
        },
      })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})

      if (error instanceof InventoryApiError) {
        return res.status(error.statusCode).json({
          error: error.message,
        })
      }

      return next(error)
    } finally {
      client.release()
    }
  },
)
