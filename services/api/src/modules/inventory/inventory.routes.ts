import { Router } from 'express'
import { db } from '../../db/pool'
import { getAuthContext } from '../auth/auth.middleware'
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
    const auth = getAuthContext(res)

    const stockLocationId =
      typeof req.query.stockLocationId === 'string'
        ? req.query.stockLocationId.trim().toLowerCase()
        : ''

    const code = typeof req.query.code === 'string' ? req.query.code.trim() : ''

    if (!stockLocationId || !isInventoryUuid(stockLocationId)) {
      return res.status(400).json({
        error: 'stockLocationId is invalid',
      })
    }

    if (!code) {
      return res.status(400).json({
        error: 'code query parameter is required',
      })
    }

    if (code.length > 120) {
      return res.status(400).json({
        error: 'code cannot exceed 120 characters',
      })
    }

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

          COALESCE(
            sb.quantity,
            0
          ) AS current_quantity,

          sl.id AS stock_location_id,
          sl.name AS stock_location_name,
          sl.code AS stock_location_code

        FROM product_variants pv

        JOIN products p
          ON p.company_id = pv.company_id
          AND p.id = pv.product_id
          AND p.status = 'active'

        JOIN stock_locations sl
          ON sl.company_id = pv.company_id
          AND sl.id = $2
          AND sl.is_active = TRUE

        LEFT JOIN fashion_sizes fs
          ON fs.company_id = pv.company_id
          AND fs.id = pv.size_id

        LEFT JOIN fashion_colors fc
          ON fc.company_id = pv.company_id
          AND fc.id = pv.color_id

        LEFT JOIN variant_barcodes vb
          ON vb.company_id = pv.company_id
          AND vb.variant_id = pv.id

        LEFT JOIN stock_balances sb
          ON sb.company_id = pv.company_id
          AND sb.stock_location_id = sl.id
          AND sb.variant_id = pv.id

        WHERE pv.company_id = $1
          AND pv.status = 'active'

          -- مستخدم الفرع لا يستطيع الوصول إلى
          -- مخزن فرع آخر أو مخزن مركزي.
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
      [auth.companyId, stockLocationId, code, auth.branchId],
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
// GET /api/inventory/reorder-rules
//
// قراءة حدود إعادة الطلب مع الرصيد الحالي.
//
// Query:
// - stockLocationId?
// - variantId?
// - limit?
//
// مستخدم الفرع يرى أماكن فرعه فقط.
// ======================================================
inventoryRouter.get('/api/inventory/reorder-rules', async (req, res, next) => {
  try {
    const auth = getAuthContext(res)

    const stockLocationId =
      typeof req.query.stockLocationId === 'string'
        ? req.query.stockLocationId.trim().toLowerCase()
        : ''

    if (stockLocationId && !isInventoryUuid(stockLocationId)) {
      return res.status(400).json({
        error: 'stockLocationId is invalid',
      })
    }

    const variantId =
      typeof req.query.variantId === 'string'
        ? req.query.variantId.trim().toLowerCase()
        : ''

    if (variantId && !isInventoryUuid(variantId)) {
      return res.status(400).json({
        error: 'variantId is invalid',
      })
    }

    const requestedLimit = Number(req.query.limit ?? 200)

    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 500)
      : 200

    const result = await db.query(
      `
        WITH rule_rows AS (
          SELECT
            rule.id,
            rule.company_id,
            rule.stock_location_id,
            rule.variant_id,

            rule.reorder_point,
            rule.safety_stock,
            rule.reorder_quantity,
            rule.is_active,

            rule.created_by,
            rule.updated_by,
            rule.created_at,
            rule.updated_at,

            sl.branch_id,
            branch.code AS branch_code,
            branch.name AS branch_name,

            sl.code AS stock_location_code,
            sl.name AS stock_location_name,
            sl.location_type,
            sl.is_active AS stock_location_is_active,

            pv.product_id,
            pv.sku,
            pv.primary_barcode,
            pv.status AS variant_status,

            product.name AS product_name,
            product.status AS product_status,

            size.name AS size_name,
            color.name AS color_name,

            category.name AS category_name,
            brand.name AS brand_name,

            COALESCE(
              balance.quantity,
              0
            ) AS current_quantity

          FROM inventory_reorder_rules rule

          JOIN stock_locations sl
            ON sl.company_id = rule.company_id
            AND sl.id = rule.stock_location_id

          LEFT JOIN branches branch
            ON branch.company_id = sl.company_id
            AND branch.id = sl.branch_id

          JOIN product_variants pv
            ON pv.company_id = rule.company_id
            AND pv.id = rule.variant_id

          JOIN products product
            ON product.company_id = pv.company_id
            AND product.id = pv.product_id

          LEFT JOIN fashion_sizes size
            ON size.company_id = pv.company_id
            AND size.id = pv.size_id

          LEFT JOIN fashion_colors color
            ON color.company_id = pv.company_id
            AND color.id = pv.color_id

          LEFT JOIN product_categories category
            ON category.company_id = product.company_id
            AND category.id = product.category_id

          LEFT JOIN brands brand
            ON brand.company_id = product.company_id
            AND brand.id = product.brand_id

          LEFT JOIN stock_balances balance
            ON balance.company_id = rule.company_id
            AND balance.stock_location_id =
                rule.stock_location_id
            AND balance.variant_id =
                rule.variant_id

          WHERE rule.company_id = $1

            AND (
              $2::uuid IS NULL
              OR sl.branch_id = $2::uuid
            )

            AND (
              $3::uuid IS NULL
              OR rule.stock_location_id = $3::uuid
            )

            AND (
              $4::uuid IS NULL
              OR rule.variant_id = $4::uuid
            )
        )

        SELECT
          rule_rows.*,

          CASE
            WHEN is_active = FALSE
            THEN 'inactive'

            WHEN current_quantity <= safety_stock
            THEN 'critical'

            WHEN current_quantity <= reorder_point
            THEN 'low'

            ELSE 'healthy'
          END AS stock_status,

          GREATEST(
            reorder_point - current_quantity,
            0
          ) AS shortage_quantity,

          CASE
            WHEN is_active = TRUE
             AND current_quantity <= reorder_point
            THEN GREATEST(
              reorder_quantity,
              reorder_point - current_quantity
            )

            ELSE 0
          END AS suggested_order_quantity

        FROM rule_rows

        ORDER BY
          is_active DESC,

          CASE
            WHEN is_active = FALSE THEN 4
            WHEN current_quantity <= safety_stock THEN 1
            WHEN current_quantity <= reorder_point THEN 2
            ELSE 3
          END ASC,

          GREATEST(
            reorder_point - current_quantity,
            0
          ) DESC,

          product_name ASC,
          sku ASC,
          stock_location_name ASC

        LIMIT $5;
        `,
      [
        auth.companyId,
        auth.branchId,
        stockLocationId || null,
        variantId || null,
        limit,
      ],
    )

    return res.json({
      data: result.rows.map((row) => ({
        id: String(row.id),

        companyId: String(row.company_id),

        branchId: typeof row.branch_id === 'string' ? row.branch_id : null,

        branchCode:
          typeof row.branch_code === 'string' ? row.branch_code : null,

        branchName:
          typeof row.branch_name === 'string' ? row.branch_name : null,

        stockLocationId: String(row.stock_location_id),

        stockLocationCode: String(row.stock_location_code),

        stockLocationName: String(row.stock_location_name),

        stockLocationType: String(row.location_type),

        stockLocationIsActive: Boolean(row.stock_location_is_active),

        variantId: String(row.variant_id),

        productId: String(row.product_id),

        productName: String(row.product_name),

        sku: String(row.sku),

        primaryBarcode:
          typeof row.primary_barcode === 'string' ? row.primary_barcode : null,

        sizeName: typeof row.size_name === 'string' ? row.size_name : null,

        colorName: typeof row.color_name === 'string' ? row.color_name : null,

        categoryName:
          typeof row.category_name === 'string' ? row.category_name : null,

        brandName: typeof row.brand_name === 'string' ? row.brand_name : null,

        productStatus: String(row.product_status),

        variantStatus: String(row.variant_status),

        reorderPoint: String(row.reorder_point),

        safetyStock: String(row.safety_stock),

        reorderQuantity: String(row.reorder_quantity),

        currentQuantity: String(row.current_quantity),

        shortageQuantity: String(row.shortage_quantity),

        suggestedOrderQuantity: String(row.suggested_order_quantity),

        stockStatus: String(row.stock_status),

        isActive: Boolean(row.is_active),

        createdBy: typeof row.created_by === 'string' ? row.created_by : null,

        updatedBy: typeof row.updated_by === 'string' ? row.updated_by : null,

        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),

      meta: {
        limit,
        branchSelectionLocked: Boolean(auth.branchId),
      },
    })
  } catch (error) {
    return next(error)
  }
})

// ======================================================
// PUT /api/inventory/reorder-rules
//
// إنشاء أو تحديث حد إعادة الطلب لنفس:
// company + stock location + variant
//
// يحتاج inventory.adjust.
// ======================================================
inventoryRouter.put('/api/inventory/reorder-rules', async (req, res, next) => {
  const client = await db.connect()

  try {
    const auth = getAuthContext(res)

    const {
      stockLocationId,
      variantId,
      reorderPoint,
      safetyStock,
      reorderQuantity,
      isActive,
    } = req.body

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

    const numericReorderPoint = Number(reorderPoint)

    const numericSafetyStock = Number(safetyStock ?? 0)

    const numericReorderQuantity = Number(reorderQuantity ?? 0)

    if (!Number.isFinite(numericReorderPoint) || numericReorderPoint < 0) {
      return res.status(400).json({
        error: 'reorderPoint must be zero or greater',
      })
    }

    if (!Number.isFinite(numericSafetyStock) || numericSafetyStock < 0) {
      return res.status(400).json({
        error: 'safetyStock must be zero or greater',
      })
    }

    if (
      !Number.isFinite(numericReorderQuantity) ||
      numericReorderQuantity < 0
    ) {
      return res.status(400).json({
        error: 'reorderQuantity must be zero or greater',
      })
    }

    if (numericSafetyStock > numericReorderPoint) {
      return res.status(400).json({
        error: 'safetyStock cannot exceed reorderPoint',
      })
    }

    if (isActive !== undefined && typeof isActive !== 'boolean') {
      return res.status(400).json({
        error: 'isActive must be boolean',
      })
    }

    const activeValue = typeof isActive === 'boolean' ? isActive : true

    if (activeValue && numericReorderPoint <= 0) {
      return res.status(400).json({
        error: 'Active reorder rule must have a reorderPoint greater than zero',
      })
    }

    await client.query('BEGIN')

    const contextResult = await client.query(
      `
          SELECT
            sl.id AS stock_location_id,
            sl.branch_id,
            sl.code AS stock_location_code,
            sl.name AS stock_location_name,
            sl.location_type,
            sl.is_active AS stock_location_is_active,

            pv.id AS variant_id,
            pv.product_id,
            pv.sku,
            pv.primary_barcode,
            pv.status AS variant_status,

            product.name AS product_name,
            product.status AS product_status,

            size.name AS size_name,
            color.name AS color_name

          FROM stock_locations sl

          JOIN product_variants pv
            ON pv.company_id = sl.company_id
            AND pv.id = $3

          JOIN products product
            ON product.company_id = pv.company_id
            AND product.id = pv.product_id

          LEFT JOIN fashion_sizes size
            ON size.company_id = pv.company_id
            AND size.id = pv.size_id

          LEFT JOIN fashion_colors color
            ON color.company_id = pv.company_id
            AND color.id = pv.color_id

          WHERE sl.company_id = $1
            AND sl.id = $2

            AND (
              $4::uuid IS NULL
              OR sl.branch_id = $4::uuid
            )

          LIMIT 1;
          `,
      [auth.companyId, stockLocationId.trim(), variantId.trim(), auth.branchId],
    )

    if ((contextResult.rowCount ?? 0) === 0) {
      throw new InventoryApiError(
        404,
        'الصنف أو مكان التخزين غير موجود أو غير مسموح.',
      )
    }

    const trustedContext = contextResult.rows[0]

    if (
      activeValue &&
      (!trustedContext.stock_location_is_active ||
        trustedContext.product_status !== 'active' ||
        trustedContext.variant_status !== 'active')
    ) {
      throw new InventoryApiError(
        409,
        'لا يمكن تفعيل حد إعادة الطلب لصنف أو مكان تخزين غير نشط.',
      )
    }

    const oldRuleResult = await client.query(
      `
          SELECT *

          FROM inventory_reorder_rules

          WHERE company_id = $1
            AND stock_location_id = $2
            AND variant_id = $3

          FOR UPDATE;
          `,
      [auth.companyId, stockLocationId.trim(), variantId.trim()],
    )

    const oldRule = oldRuleResult.rows[0] ?? null

    const ruleResult = await client.query(
      `
          INSERT INTO inventory_reorder_rules (
            company_id,
            stock_location_id,
            variant_id,

            reorder_point,
            safety_stock,
            reorder_quantity,

            is_active,

            created_by,
            updated_by
          )
          VALUES (
            $1, $2, $3,
            $4, $5, $6,
            $7,
            $8, $8
          )

          ON CONFLICT (
            company_id,
            stock_location_id,
            variant_id
          )
          DO UPDATE SET
            reorder_point =
              EXCLUDED.reorder_point,

            safety_stock =
              EXCLUDED.safety_stock,

            reorder_quantity =
              EXCLUDED.reorder_quantity,

            is_active =
              EXCLUDED.is_active,

            updated_by =
              EXCLUDED.updated_by,

            updated_at = NOW()

          RETURNING *;
          `,
      [
        auth.companyId,
        stockLocationId.trim(),
        variantId.trim(),

        numericReorderPoint,
        numericSafetyStock,
        numericReorderQuantity,

        activeValue,

        auth.userId,
      ],
    )

    const savedRule = ruleResult.rows[0]

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
          $1, $2, $3,
          $4,
          'inventory_reorder_rule',
          $5,
          $6::jsonb,
          $7::jsonb,
          $8,
          $9
        );
        `,
      [
        auth.companyId,
        trustedContext.branch_id,
        auth.userId,

        oldRule
          ? 'inventory.reorder_rule.updated'
          : 'inventory.reorder_rule.created',

        savedRule.id,

        oldRule ? JSON.stringify(oldRule) : null,

        JSON.stringify(savedRule),

        req.ip || null,
        req.get('user-agent') || null,
      ],
    )

    await client.query('COMMIT')

    return res.status(oldRule ? 200 : 201).json({
      data: {
        rule: {
          id: String(savedRule.id),

          companyId: String(savedRule.company_id),

          stockLocationId: String(savedRule.stock_location_id),

          variantId: String(savedRule.variant_id),

          reorderPoint: String(savedRule.reorder_point),

          safetyStock: String(savedRule.safety_stock),

          reorderQuantity: String(savedRule.reorder_quantity),

          isActive: Boolean(savedRule.is_active),

          createdBy: savedRule.created_by,

          updatedBy: savedRule.updated_by,

          createdAt: savedRule.created_at,

          updatedAt: savedRule.updated_at,
        },

        item: {
          branchId: trustedContext.branch_id,

          stockLocationId: trustedContext.stock_location_id,

          stockLocationCode: trustedContext.stock_location_code,

          stockLocationName: trustedContext.stock_location_name,

          stockLocationType: trustedContext.location_type,

          variantId: trustedContext.variant_id,

          productId: trustedContext.product_id,

          productName: trustedContext.product_name,

          sku: trustedContext.sku,

          primaryBarcode: trustedContext.primary_barcode,

          sizeName: trustedContext.size_name,

          colorName: trustedContext.color_name,
        },
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
