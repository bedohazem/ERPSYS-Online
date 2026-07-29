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

// أنواع حركات المخزون المسموح باستخدامها كفلتر.
// القائمة مطابقة للقيم المعرفة داخل PostgreSQL.
const allowedInventoryMovementTypes = new Set([
  'purchase',
  'sale',
  'return',
  'exchange',
  'transfer_in',
  'transfer_out',
  'adjustment',
  'damage',
  'stock_count',
])

// تحويل كمية موجبة مع دعم ثلاث خانات عشرية فقط.
function parsePositiveInventoryQuantity(value: unknown) {
  const normalizedValue = typeof value === 'string' ? value.trim() : value

  if (
    normalizedValue === '' ||
    (typeof normalizedValue !== 'string' && typeof normalizedValue !== 'number')
  ) {
    return null
  }

  const numericValue = Number(normalizedValue)

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null
  }

  const roundedValue = Number(numericValue.toFixed(3))

  if (Math.abs(numericValue - roundedValue) > 0.0000001) {
    return null
  }

  if (roundedValue > 99_999_999_999.999) {
    return null
  }

  return roundedValue
}

// يتحقق من التاريخ بصيغة YYYY-MM-DD.
// null يعني أن الفلتر غير مُرسل، وundefined يعني قيمة غير صالحة.
function parseInventoryDateFilter(value: unknown) {
  if (value === undefined || value === null || value === '') {
    return null
  }

  if (typeof value !== 'string') {
    return undefined
  }

  const normalizedValue = value.trim()

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedValue)) {
    return undefined
  }

  const parsedDate = new Date(`${normalizedValue}T00:00:00.000Z`)

  if (
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== normalizedValue
  ) {
    return undefined
  }

  return normalizedValue
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
//
// يعرض حركات المخزون الخاصة بالشركة والفرع الموجودين
// داخل Session الموثقة فقط.
//
// Query المسموح:
// - variantId?
// - stockLocationId?
// - movementType?
// - limit?
// ======================================================
inventoryRouter.get(
  '/api/inventory/stock-movements',
  async (req, res, next) => {
    try {
      const auth = getAuthContext(res)

      const variantId =
        typeof req.query.variantId === 'string'
          ? req.query.variantId.trim().toLowerCase()
          : ''

      if (variantId && !isInventoryUuid(variantId)) {
        return res.status(400).json({
          error: 'variantId is invalid',
        })
      }

      const stockLocationId =
        typeof req.query.stockLocationId === 'string'
          ? req.query.stockLocationId.trim().toLowerCase()
          : ''

      if (stockLocationId && !isInventoryUuid(stockLocationId)) {
        return res.status(400).json({
          error: 'stockLocationId is invalid',
        })
      }

      const movementType =
        typeof req.query.movementType === 'string'
          ? req.query.movementType.trim().toLowerCase()
          : ''

      if (movementType && !allowedInventoryMovementTypes.has(movementType)) {
        return res.status(400).json({
          error: 'movementType is invalid',
        })
      }

      const requestedLimit = Number(req.query.limit ?? 100)

      const limit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
        : 100

      const result = await db.query(
        `
          SELECT
            movement.id,
            movement.company_id,
            movement.branch_id,

            branch.name AS branch_name,

            movement.stock_location_id,

            location.name AS stock_location_name,
            location.code AS stock_location_code,
            location.location_type,

            movement.variant_id,

            variant.sku,
            variant.primary_barcode,

            product.name AS product_name,

            size.name AS size_name,
            color.name AS color_name,

            movement.movement_type,
            movement.quantity,
            movement.quantity_before,
            movement.quantity_after,

            movement.reference_type,
            movement.reference_id,

            movement.note,
            movement.created_by,

            creator.full_name AS created_by_name,

            movement.created_at

          FROM stock_movements movement

          JOIN stock_locations location
            ON location.company_id =
               movement.company_id

            AND location.id =
                movement.stock_location_id

          JOIN product_variants variant
            ON variant.company_id =
               movement.company_id

            AND variant.id =
                movement.variant_id

          JOIN products product
            ON product.company_id =
               variant.company_id

            AND product.id =
                variant.product_id

          LEFT JOIN branches branch
            ON branch.company_id =
               movement.company_id

            AND branch.id =
                movement.branch_id

          LEFT JOIN fashion_sizes size
            ON size.company_id =
               variant.company_id

            AND size.id =
                variant.size_id

          LEFT JOIN fashion_colors color
            ON color.company_id =
               variant.company_id

            AND color.id =
                variant.color_id

          LEFT JOIN users creator
            ON creator.company_id =
               movement.company_id

            AND creator.id =
                movement.created_by

          WHERE movement.company_id = $1

            AND (
              $2::uuid IS NULL
              OR movement.variant_id = $2
            )

            AND (
              $3::uuid IS NULL
              OR movement.stock_location_id = $3
            )

            AND (
              $4::text IS NULL
              OR movement.movement_type = $4
            )

            -- مستخدم الفرع يرى حركات أماكن فرعه فقط.
            AND (
              $5::uuid IS NULL
              OR location.branch_id = $5
            )

          ORDER BY
            movement.created_at DESC,
            movement.id DESC

          LIMIT $6;
        `,
        [
          auth.companyId,
          variantId || null,
          stockLocationId || null,
          movementType || null,
          auth.branchId,
          limit,
        ],
      )

      return res.json({
        data: result.rows,

        meta: {
          limit,
          branchSelectionLocked: Boolean(auth.branchId),
        },
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// GET /api/inventory/stock-locations
//
// يعرض أماكن التخزين النشطة حسب الشركة والفرع
// الموجودين داخل Session فقط.
//
// Query:
// - locationType?
// ======================================================
inventoryRouter.get(
  '/api/inventory/stock-locations',
  async (req, res, next) => {
    try {
      const auth = getAuthContext(res)

      const locationType =
        typeof req.query.locationType === 'string'
          ? req.query.locationType.trim().toLowerCase()
          : ''

      const allowedLocationTypes = new Set([
        'main_warehouse',
        'branch_warehouse',
        'sales_floor',
        'returns',
        'damaged',
        'inspection',
      ])

      if (locationType && !allowedLocationTypes.has(locationType)) {
        return res.status(400).json({
          error: 'locationType is invalid',
        })
      }

      const result = await db.query(
        `
          SELECT
            location.id,
            location.company_id,
            location.branch_id,

            branch.code AS branch_code,
            branch.name AS branch_name,

            location.code,
            location.name,
            location.location_type,
            location.is_active,

            location.created_at,
            location.updated_at

          FROM stock_locations location

          LEFT JOIN branches branch
            ON branch.company_id =
               location.company_id

            AND branch.id =
                location.branch_id

          WHERE location.company_id = $1
            AND location.is_active = TRUE

            AND (
              $2::uuid IS NULL
              OR location.branch_id = $2
            )

            AND (
              $3::text IS NULL
              OR location.location_type = $3
            )

          ORDER BY
            branch.name ASC NULLS FIRST,
            location.name ASC;
        `,
        [auth.companyId, auth.branchId, locationType || null],
      )

      return res.json({
        data: result.rows,

        meta: {
          branchSelectionLocked: Boolean(auth.branchId),
        },
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// GET /api/inventory/stock-balances
//
// يعرض أرصدة المخزون مع دعم:
// - نوع مكان التخزين.
// - مكان محدد.
// - البحث بالاسم أو SKU أو الباركود.
// - إخفاء الأرصدة الصفرية.
// - ملخص مخزون التالف وتحت الفحص.
//
// الشركة والفرع يؤخذان من Session فقط.
// ======================================================
inventoryRouter.get('/api/inventory/stock-balances', async (req, res, next) => {
  try {
    const auth = getAuthContext(res)

    const requestedLocationType =
      typeof req.query.locationType === 'string'
        ? req.query.locationType.trim().toLowerCase()
        : ''

    const allowedLocationTypes = new Set([
      'main_warehouse',
      'branch_warehouse',
      'sales_floor',
      'returns',
      'damaged',
      'inspection',

      // قيمة افتراضية تعني التالف وتحت الفحص معًا.
      'condition',
    ])

    if (
      requestedLocationType &&
      !allowedLocationTypes.has(requestedLocationType)
    ) {
      return res.status(400).json({
        error: 'locationType is invalid',
      })
    }

    const stockLocationId =
      typeof req.query.stockLocationId === 'string'
        ? req.query.stockLocationId.trim().toLowerCase()
        : ''

    if (stockLocationId && !isInventoryUuid(stockLocationId)) {
      return res.status(400).json({
        error: 'stockLocationId is invalid',
      })
    }

    const search =
      typeof req.query.search === 'string' ? req.query.search.trim() : ''

    if (search.length > 120) {
      return res.status(400).json({
        error: 'search cannot exceed 120 characters',
      })
    }

    const positiveOnly = req.query.positiveOnly === 'true'

    const requestedLimit = Number(req.query.limit ?? 200)

    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 500)
      : 200

    const result = await db.query(
      `
        WITH filtered_balances AS (
          SELECT
            balance.id,
            balance.company_id,
            balance.branch_id,

            branch.name AS branch_name,

            balance.stock_location_id,

            location.name AS stock_location_name,
            location.code AS stock_location_code,
            location.location_type,

            balance.variant_id,

            variant.sku,
            variant.primary_barcode,

            product.name AS product_name,

            size.name AS size_name,
            color.name AS color_name,

            balance.quantity,
            balance.updated_at

          FROM stock_balances balance

          JOIN stock_locations location
            ON location.company_id =
               balance.company_id

            AND location.id =
                balance.stock_location_id

          JOIN product_variants variant
            ON variant.company_id =
               balance.company_id

            AND variant.id =
                balance.variant_id

          JOIN products product
            ON product.company_id =
               variant.company_id

            AND product.id =
                variant.product_id

          LEFT JOIN branches branch
            ON branch.company_id =
               location.company_id

            AND branch.id =
                location.branch_id

          LEFT JOIN fashion_sizes size
            ON size.company_id =
               variant.company_id

            AND size.id =
                variant.size_id

          LEFT JOIN fashion_colors color
            ON color.company_id =
               variant.company_id

            AND color.id =
                variant.color_id

          WHERE balance.company_id = $1

            -- مستخدم الفرع لا يرى أرصدة فرع آخر.
            AND (
              $2::uuid IS NULL
              OR location.branch_id = $2
            )

            AND (
              $3::text IS NULL

              OR (
                $3 = 'condition'
                AND location.location_type
                    IN ('damaged', 'inspection')
              )

              OR location.location_type = $3
            )

            AND (
              $4::uuid IS NULL
              OR location.id = $4
            )

            AND (
              $5::boolean = FALSE
              OR balance.quantity > 0
            )

            AND (
              $6::text IS NULL

              OR product.name ILIKE
                 '%' || $6 || '%'

              OR variant.sku ILIKE
                 '%' || $6 || '%'

              OR variant.primary_barcode ILIKE
                 '%' || $6 || '%'

              OR EXISTS (
                SELECT 1

                FROM variant_barcodes barcode

                WHERE barcode.company_id =
                      variant.company_id

                  AND barcode.variant_id =
                      variant.id

                  AND barcode.barcode ILIKE
                      '%' || $6 || '%'
              )
            )
        )

        SELECT
          filtered_balances.*,

          COUNT(*) OVER()::integer
            AS filtered_count,

          COALESCE(
            SUM(quantity) OVER(),
            0
          ) AS filtered_quantity,

          COALESCE(
            SUM(quantity)
              FILTER (
                WHERE location_type = 'damaged'
              )
              OVER(),
            0
          ) AS damaged_quantity,

          COALESCE(
            SUM(quantity)
              FILTER (
                WHERE location_type = 'inspection'
              )
              OVER(),
            0
          ) AS inspection_quantity

        FROM filtered_balances

        ORDER BY
          CASE
            WHEN location_type = 'inspection' THEN 1
            WHEN location_type = 'damaged' THEN 2
            ELSE 3
          END,

          product_name ASC,
          sku ASC,
          stock_location_name ASC

        LIMIT $7;
      `,
      [
        auth.companyId,
        auth.branchId,
        requestedLocationType || null,
        stockLocationId || null,
        positiveOnly,
        search || null,
        limit,
      ],
    )

    const firstRow = result.rows[0]

    const data = result.rows.map((row) => {
      const {
        filtered_count: _filteredCount,
        filtered_quantity: _filteredQuantity,
        damaged_quantity: _damagedQuantity,
        inspection_quantity: _inspectionQuantity,
        ...balance
      } = row

      return balance
    })

    return res.json({
      data,

      meta: {
        limit,

        filteredCount: firstRow ? Number(firstRow.filtered_count) : 0,

        filteredQuantity: firstRow ? String(firstRow.filtered_quantity) : '0',

        damagedQuantity: firstRow ? String(firstRow.damaged_quantity) : '0',

        inspectionQuantity: firstRow
          ? String(firstRow.inspection_quantity)
          : '0',

        branchSelectionLocked: Boolean(auth.branchId),
      },
    })
  } catch (error) {
    return next(error)
  }
})

// ======================================================
// GET /api/inventory/item-card
//
// كارت حركة صنف واحد:
// - البحث بـ SKU أو الباركود.
// - الأرصدة الحالية حسب مكان التخزين.
// - إجمالي الداخل والخارج خلال الفترة.
// - سجل حركات المخزون.
//
// الشركة والفرع يأتون من Session فقط.
// ======================================================
inventoryRouter.get('/api/inventory/item-card', async (req, res, next) => {
  try {
    const auth = getAuthContext(res)

    const code = typeof req.query.code === 'string' ? req.query.code.trim() : ''

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

    const stockLocationId =
      typeof req.query.stockLocationId === 'string'
        ? req.query.stockLocationId.trim().toLowerCase()
        : ''

    if (stockLocationId && !isInventoryUuid(stockLocationId)) {
      return res.status(400).json({
        error: 'stockLocationId is invalid',
      })
    }

    const dateFrom = parseInventoryDateFilter(req.query.dateFrom)
    const dateTo = parseInventoryDateFilter(req.query.dateTo)

    if (dateFrom === undefined) {
      return res.status(400).json({
        error: 'dateFrom must use YYYY-MM-DD format',
      })
    }

    if (dateTo === undefined) {
      return res.status(400).json({
        error: 'dateTo must use YYYY-MM-DD format',
      })
    }

    if (dateFrom && dateTo && dateFrom > dateTo) {
      return res.status(400).json({
        error: 'dateFrom cannot be after dateTo',
      })
    }

    const requestedLimit = Number(req.query.limit ?? 200)

    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 500)
      : 200

    // نحدد الصنف داخل الشركة الموثقة فقط.
    // لا نشترط أن يكون Active لأن كارت الحركة يجب أن يعمل
    // أيضًا مع الأصناف الموقوفة التي لها تاريخ مخزون.
    const itemResult = await db.query(
      `
        SELECT DISTINCT
          variant.id AS variant_id,
          variant.product_id,

          product.name AS product_name,
          product.status AS product_status,

          variant.sku,
          variant.primary_barcode,
          variant.status AS variant_status,

          size.name AS size_name,
          color.name AS color_name,

          category.name AS category_name,
          brand.name AS brand_name

        FROM product_variants variant

        JOIN products product
          ON product.company_id =
             variant.company_id

          AND product.id =
              variant.product_id

        LEFT JOIN variant_barcodes barcode
          ON barcode.company_id =
             variant.company_id

          AND barcode.variant_id =
              variant.id

        LEFT JOIN fashion_sizes size
          ON size.company_id =
             variant.company_id

          AND size.id =
              variant.size_id

        LEFT JOIN fashion_colors color
          ON color.company_id =
             variant.company_id

          AND color.id =
              variant.color_id

        LEFT JOIN product_categories category
          ON category.company_id =
             product.company_id

          AND category.id =
              product.category_id

        LEFT JOIN brands brand
          ON brand.company_id =
             product.company_id

          AND brand.id =
              product.brand_id

        WHERE variant.company_id = $1

          AND (
            variant.sku = $2
            OR variant.primary_barcode = $2
            OR barcode.barcode = $2
          )

        LIMIT 1;
      `,
      [auth.companyId, code],
    )

    if ((itemResult.rowCount ?? 0) === 0) {
      return res.status(404).json({
        error: 'الصنف غير موجود داخل الشركة الحالية.',
      })
    }

    const item = itemResult.rows[0]

    // لو تم اختيار مكان معين، نتحقق أنه تابع للشركة
    // ومتاح للفرع الموجود في Session.
    if (stockLocationId) {
      const locationResult = await db.query(
        `
          SELECT id

          FROM stock_locations

          WHERE company_id = $1
            AND id = $2

            AND (
              $3::uuid IS NULL
              OR branch_id = $3
            )

          LIMIT 1;
        `,
        [auth.companyId, stockLocationId, auth.branchId],
      )

      if ((locationResult.rowCount ?? 0) === 0) {
        return res.status(404).json({
          error: 'مكان التخزين غير موجود أو غير مسموح.',
        })
      }
    }

    const [
      balancesResult,
      balanceSummaryResult,
      movementsResult,
      movementSummaryResult,
    ] = await Promise.all([
      db.query(
        `
          SELECT
            balance.id,
            balance.branch_id,

            branch.name AS branch_name,

            balance.stock_location_id,

            location.code AS stock_location_code,
            location.name AS stock_location_name,
            location.location_type,

            balance.quantity,
            balance.updated_at

          FROM stock_balances balance

          JOIN stock_locations location
            ON location.company_id =
               balance.company_id

            AND location.id =
                balance.stock_location_id

          LEFT JOIN branches branch
            ON branch.company_id =
               location.company_id

            AND branch.id =
                location.branch_id

          WHERE balance.company_id = $1
            AND balance.variant_id = $2
            AND balance.quantity <> 0

            AND (
              $3::uuid IS NULL
              OR location.id = $3
            )

            AND (
              $4::uuid IS NULL
              OR location.branch_id = $4
            )

          ORDER BY
            branch.name ASC NULLS FIRST,
            location.name ASC;
        `,
        [
          auth.companyId,
          item.variant_id,
          stockLocationId || null,
          auth.branchId,
        ],
      ),

      db.query(
        `
          SELECT
            COALESCE(
              SUM(balance.quantity),
              0
            ) AS current_quantity,

            (
              COUNT(*)
              FILTER (
                WHERE balance.quantity <> 0
              )
            )::integer AS location_count

          FROM stock_balances balance

          JOIN stock_locations location
            ON location.company_id =
               balance.company_id

            AND location.id =
                balance.stock_location_id

          WHERE balance.company_id = $1
            AND balance.variant_id = $2

            AND (
              $3::uuid IS NULL
              OR location.id = $3
            )

            AND (
              $4::uuid IS NULL
              OR location.branch_id = $4
            );
        `,
        [
          auth.companyId,
          item.variant_id,
          stockLocationId || null,
          auth.branchId,
        ],
      ),

      db.query(
        `
          SELECT
            movement.id,
            movement.branch_id,

            branch.name AS branch_name,

            movement.stock_location_id,

            location.code AS stock_location_code,
            location.name AS stock_location_name,
            location.location_type,

            movement.movement_type,
            movement.quantity,
            movement.quantity_before,
            movement.quantity_after,

            movement.reference_type,
            movement.reference_id,

            movement.note,
            movement.created_by,

            creator.full_name AS created_by_name,

            movement.created_at

          FROM stock_movements movement

          JOIN stock_locations location
            ON location.company_id =
               movement.company_id

            AND location.id =
                movement.stock_location_id

          LEFT JOIN branches branch
            ON branch.company_id =
               movement.company_id

            AND branch.id =
                movement.branch_id

          LEFT JOIN users creator
            ON creator.company_id =
               movement.company_id

            AND creator.id =
                movement.created_by

          WHERE movement.company_id = $1
            AND movement.variant_id = $2

            AND (
              $3::uuid IS NULL
              OR location.id = $3
            )

            AND (
              $4::uuid IS NULL
              OR location.branch_id = $4
            )

            AND (
              $5::date IS NULL
              OR movement.created_at >= $5::date
            )

            AND (
              $6::date IS NULL
              OR movement.created_at <
                 $6::date + INTERVAL '1 day'
            )

          ORDER BY
            movement.created_at DESC,
            movement.id DESC

          LIMIT $7;
        `,
        [
          auth.companyId,
          item.variant_id,
          stockLocationId || null,
          auth.branchId,
          dateFrom,
          dateTo,
          limit,
        ],
      ),

      db.query(
        `
          SELECT
            COUNT(*)::integer
              AS movement_count,

            COALESCE(
              SUM(
                CASE
                  WHEN movement.quantity > 0
                  THEN movement.quantity
                  ELSE 0
                END
              ),
              0
            ) AS inbound_quantity,

            COALESCE(
              SUM(
                CASE
                  WHEN movement.quantity < 0
                  THEN ABS(movement.quantity)
                  ELSE 0
                END
              ),
              0
            ) AS outbound_quantity,

            COALESCE(
              SUM(movement.quantity),
              0
            ) AS net_quantity

          FROM stock_movements movement

          JOIN stock_locations location
            ON location.company_id =
               movement.company_id

            AND location.id =
                movement.stock_location_id

          WHERE movement.company_id = $1
            AND movement.variant_id = $2

            AND (
              $3::uuid IS NULL
              OR location.id = $3
            )

            AND (
              $4::uuid IS NULL
              OR location.branch_id = $4
            )

            AND (
              $5::date IS NULL
              OR movement.created_at >= $5::date
            )

            AND (
              $6::date IS NULL
              OR movement.created_at <
                 $6::date + INTERVAL '1 day'
            );
        `,
        [
          auth.companyId,
          item.variant_id,
          stockLocationId || null,
          auth.branchId,
          dateFrom,
          dateTo,
        ],
      ),
    ])

    const balanceSummary = balanceSummaryResult.rows[0]
    const movementSummary = movementSummaryResult.rows[0]

    return res.json({
      data: {
        item,

        balances: balancesResult.rows,

        movements: movementsResult.rows,

        summary: {
          currentQuantity: balanceSummary.current_quantity,

          locationCount: balanceSummary.location_count,

          movementCount: movementSummary.movement_count,

          inboundQuantity: movementSummary.inbound_quantity,

          outboundQuantity: movementSummary.outbound_quantity,

          netQuantity: movementSummary.net_quantity,
        },
      },

      meta: {
        limit,
        stockLocationId: stockLocationId || null,
        dateFrom,
        dateTo,
        branchSelectionLocked: Boolean(auth.branchId),
      },
    })
  } catch (error) {
    return next(error)
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
//
// الشركة والفرع والمستخدم يأتون من Session.
// الواجهة ترسل بيانات العملية فقط.
// ======================================================
inventoryRouter.post(
  '/api/inventory/opening-balance',
  async (req, res, next) => {
    const client = await db.connect()

    try {
      const auth = getAuthContext(res)

      const { stockLocationId, variantId, quantity, note } = req.body

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

      const normalizedQuantity = parsePositiveInventoryQuantity(quantity)

      if (normalizedQuantity === null) {
        return res.status(400).json({
          error:
            'quantity must be greater than zero with at most 3 decimal places',
        })
      }

      const normalizedNote = typeof note === 'string' ? note.trim() : ''

      if (normalizedNote.length > 500) {
        return res.status(400).json({
          error: 'note cannot exceed 500 characters',
        })
      }

      const normalizedLocationId = stockLocationId.trim().toLowerCase()

      const normalizedVariantId = variantId.trim().toLowerCase()

      await client.query('BEGIN')

      // المكان والصنف يتم تحميلهما باستخدام الشركة
      // والفرع الموجودين في Session الموثقة.
      const contextResult = await client.query(
        `
          SELECT
            location.id AS stock_location_id,
            location.branch_id AS trusted_branch_id,

            location.name AS stock_location_name,
            location.code AS stock_location_code,

            variant.id AS variant_id,
            variant.sku,
            variant.primary_barcode,

            product.name AS product_name

          FROM stock_locations location

          JOIN product_variants variant
            ON variant.company_id =
               location.company_id

            AND variant.id = $2
            AND variant.status = 'active'

          JOIN products product
            ON product.company_id =
               variant.company_id

            AND product.id =
                variant.product_id

            AND product.status = 'active'

          WHERE location.company_id = $1
            AND location.id = $3
            AND location.is_active = TRUE

            AND (
              $4::uuid IS NULL
              OR location.branch_id = $4
            )

          LIMIT 1;
        `,
        [
          auth.companyId,
          normalizedVariantId,
          normalizedLocationId,
          auth.branchId,
        ],
      )

      if ((contextResult.rowCount ?? 0) === 0) {
        throw new InventoryApiError(
          404,
          'الصنف أو مكان التخزين غير موجود أو غير مسموح.',
        )
      }

      const trustedContext = contextResult.rows[0]

      // إنشاء صف رصيد بصفر ثم قفله يمنع تنفيذ
      // رصيدين افتتاحيين متزامنين لنفس الصنف.
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
          auth.companyId,
          trustedContext.trusted_branch_id,
          normalizedLocationId,
          normalizedVariantId,
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
        [auth.companyId, normalizedLocationId, normalizedVariantId],
      )

      if ((balanceBeforeResult.rowCount ?? 0) === 0) {
        throw new InventoryApiError(500, 'Stock balance row was not created')
      }

      const quantityBefore = Number(balanceBeforeResult.rows[0].quantity)

      // وجود أي حركة سابقة يعني أن الصنف بدأ العمل
      // ولا يجوز تسجيل رصيد افتتاحي له مرة أخرى.
      const previousMovementResult = await client.query(
        `
          SELECT id

          FROM stock_movements

          WHERE company_id = $1
            AND stock_location_id = $2
            AND variant_id = $3

          LIMIT 1;
        `,
        [auth.companyId, normalizedLocationId, normalizedVariantId],
      )

      if (quantityBefore !== 0 || (previousMovementResult.rowCount ?? 0) > 0) {
        throw new InventoryApiError(
          409,
          'تم تسجيل رصيد أو حركة سابقة لهذا الصنف داخل المكان المختار.',
        )
      }

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
          normalizedQuantity,
          trustedContext.trusted_branch_id,
          auth.companyId,
          normalizedLocationId,
          normalizedVariantId,
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
            $5, 0, $5,
            'opening_balance',
            NULL,
            $6,
            $7
          )
          RETURNING *;
        `,
        [
          auth.companyId,
          trustedContext.trusted_branch_id,
          normalizedLocationId,
          normalizedVariantId,
          normalizedQuantity,
          normalizedNote || 'رصيد افتتاحي',
          auth.userId,
        ],
      )

      const movement = movementResult.rows[0]

      // الرصيد الافتتاحي حركة حساسة، لذلك يتم تسجيلها
      // داخل Audit Log في نفس الـTransaction.
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
            'inventory.opening_balance.created',
            'stock_movement',
            $4,
            NULL,
            $5::jsonb,
            $6,
            $7
          );
        `,
        [
          auth.companyId,
          trustedContext.trusted_branch_id,
          auth.userId,

          movement.id,

          JSON.stringify({
            stockLocationId: normalizedLocationId,
            variantId: normalizedVariantId,
            quantity: normalizedQuantity,
            note: normalizedNote || null,
          }),

          req.ip || null,
          req.get('user-agent') || null,
        ],
      )

      await client.query('COMMIT')

      return res.status(201).json({
        data: {
          balance: balanceResult.rows[0],
          movement,
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
