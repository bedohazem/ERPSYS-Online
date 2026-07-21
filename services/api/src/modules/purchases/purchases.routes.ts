import { Router } from 'express'
import { db } from '../../db/pool'

export const purchasesRouter = Router()

class PurchasesApiError extends Error {
  statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

const purchaseUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isPurchaseUuid(value: string) {
  return purchaseUuidPattern.test(value)
}

function isPostgresUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  )
}

function roundPurchaseMoney(value: number) {
  return Number(value.toFixed(2))
}

function roundPurchaseQuantity(value: number) {
  return Number(value.toFixed(3))
}

function parsePurchaseLimit(value: unknown) {
  const numericValue = Number(value ?? 50)

  if (!Number.isFinite(numericValue)) {
    return 50
  }

  return Math.min(Math.max(Math.trunc(numericValue), 1), 100)
}

// ======================================================
// تحميل إذن استلام كامل مع البنود.
// ======================================================
async function loadPurchaseReceiptDetails(
  companyId: string,
  receiptId: string,
  branchId: string | null,
) {
  const receiptResult = await db.query(
    `
    SELECT
      pr.*,
      s.name AS supplier_name,
      s.code AS supplier_code,
      sl.name AS stock_location_name,
      sl.code AS stock_location_code,
      b.name AS branch_name,
      u.full_name AS created_by_name
    FROM purchase_receipts pr

    JOIN suppliers s
      ON s.id = pr.supplier_id
      AND s.company_id = pr.company_id

    JOIN stock_locations sl
      ON sl.id = pr.stock_location_id
      AND sl.company_id = pr.company_id

    LEFT JOIN branches b
      ON b.id = pr.branch_id
      AND b.company_id = pr.company_id

    LEFT JOIN users u
      ON u.id = pr.created_by

    WHERE pr.company_id = $1
      AND pr.id = $2
      AND (
        $3::uuid IS NULL
        OR pr.branch_id = $3::uuid
      )

    LIMIT 1;
    `,
    [companyId, receiptId, branchId],
  )

  if ((receiptResult.rowCount ?? 0) === 0) {
    return null
  }

  const itemsResult = await db.query(
    `
    SELECT
      pri.*,
      pv.sku,
      pv.primary_barcode,
      pv.cost_price AS current_average_cost,
      p.name AS product_name,
      fs.name AS size_name,
      fc.name AS color_name
    FROM purchase_receipt_items pri

    JOIN product_variants pv
      ON pv.id = pri.variant_id
      AND pv.company_id = pri.company_id

    JOIN products p
      ON p.id = pv.product_id
      AND p.company_id = pv.company_id

    LEFT JOIN fashion_sizes fs
      ON fs.id = pv.size_id

    LEFT JOIN fashion_colors fc
      ON fc.id = pv.color_id

    WHERE pri.company_id = $1
      AND pri.purchase_receipt_id = $2

    ORDER BY p.name ASC, pv.sku ASC;
    `,
    [companyId, receiptId],
  )

  return {
    receipt: receiptResult.rows[0],
    items: itemsResult.rows,
  }
}

async function loadReceiptByIdempotency(
  companyId: string,
  idempotencyKey: string,
  branchId: string | null,
) {
  const result = await db.query(
    `
    SELECT id
    FROM purchase_receipts
    WHERE company_id = $1
      AND idempotency_key = $2
    LIMIT 1;
    `,
    [companyId, idempotencyKey],
  )

  if ((result.rowCount ?? 0) === 0) {
    return null
  }

  return loadPurchaseReceiptDetails(companyId, result.rows[0].id, branchId)
}

// ======================================================
// GET /api/purchases/stock-locations
//
// أماكن التخزين المتاحة لاستلام البضاعة.
// ======================================================
purchasesRouter.get(
  '/api/purchases/stock-locations',
  async (req, res, next) => {
    try {
      const companyId = req.query.companyId
      const branchId = req.query.branchId

      if (typeof companyId !== 'string' || !companyId.trim()) {
        return res.status(400).json({
          error: 'companyId query parameter is required',
        })
      }

      const authenticatedBranchId =
        typeof branchId === 'string' && branchId.trim() ? branchId.trim() : null

      const result = await db.query(
        `
        SELECT
          sl.id,
          sl.company_id,
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
          AND (
            $2::uuid IS NULL
            OR sl.branch_id = $2::uuid
          )

        ORDER BY sl.name ASC;
        `,
        [companyId.trim(), authenticatedBranchId],
      )

      return res.json({
        data: result.rows,
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// GET /api/purchases/lookup-item
//
// البحث عن صنف بالباركود أو SKU لإضافته لإذن الاستلام.
// ======================================================
purchasesRouter.get('/api/purchases/lookup-item', async (req, res, next) => {
  try {
    const companyId = req.query.companyId
    const code = req.query.code

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res.status(400).json({
        error: 'companyId query parameter is required',
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
          pv.primary_barcode,
          fs.name AS size_name,
          fc.name AS color_name,
          pv.cost_price,
          pv.selling_price
        FROM product_variants pv

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

        WHERE pv.company_id = $1
          AND pv.status = 'active'
          AND (
            pv.primary_barcode = $2
            OR pv.sku = $2
            OR vb.barcode = $2
          )

        LIMIT 1;
        `,
      [companyId.trim(), code.trim()],
    )

    if ((result.rowCount ?? 0) === 0) {
      return res.status(404).json({
        error: 'الصنف غير موجود.',
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
// GET /api/purchases/receipts
// ======================================================
purchasesRouter.get('/api/purchases/receipts', async (req, res, next) => {
  try {
    const companyId = req.query.companyId
    const branchId = req.query.branchId
    const supplierId = req.query.supplierId
    const query = req.query.q

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res.status(400).json({
        error: 'companyId query parameter is required',
      })
    }

    const authenticatedBranchId =
      typeof branchId === 'string' && branchId.trim() ? branchId.trim() : null

    const selectedSupplierId =
      typeof supplierId === 'string' && supplierId.trim()
        ? supplierId.trim()
        : null

    const searchText =
      typeof query === 'string' && query.trim() ? `%${query.trim()}%` : null

    if (selectedSupplierId && !isPurchaseUuid(selectedSupplierId)) {
      return res.status(400).json({
        error: 'supplierId is invalid',
      })
    }

    const result = await db.query(
      `
        SELECT
          pr.id,
          pr.company_id,
          pr.branch_id,
          b.name AS branch_name,
          pr.stock_location_id,
          sl.name AS stock_location_name,
          sl.code AS stock_location_code,
          pr.supplier_id,
          s.name AS supplier_name,
          s.code AS supplier_code,
          pr.purchase_order_id,
          pr.receipt_number,
          pr.status,
          pr.subtotal,
          pr.discount_total,
          pr.tax_total,
          pr.total,
          pr.received_at,
          pr.note,
          pr.created_by,
          u.full_name AS created_by_name,
          pr.created_at,

          COUNT(pri.id)::int
            AS items_count,

          COALESCE(
            SUM(pri.quantity),
            0
          ) AS received_quantity

        FROM purchase_receipts pr

        JOIN suppliers s
          ON s.id = pr.supplier_id
          AND s.company_id = pr.company_id

        JOIN stock_locations sl
          ON sl.id = pr.stock_location_id
          AND sl.company_id = pr.company_id

        LEFT JOIN branches b
          ON b.id = pr.branch_id
          AND b.company_id = pr.company_id

        LEFT JOIN users u
          ON u.id = pr.created_by

        LEFT JOIN purchase_receipt_items pri
          ON pri.purchase_receipt_id = pr.id
          AND pri.company_id = pr.company_id

        WHERE pr.company_id = $1
          AND (
            $2::uuid IS NULL
            OR pr.branch_id = $2::uuid
          )
          AND (
            $3::uuid IS NULL
            OR pr.supplier_id = $3::uuid
          )
          AND (
            $4::text IS NULL
            OR pr.receipt_number ILIKE $4
            OR s.name ILIKE $4
            OR s.code ILIKE $4
            OR sl.name ILIKE $4
          )

        GROUP BY
          pr.id,
          b.name,
          sl.name,
          sl.code,
          s.name,
          s.code,
          u.full_name

        ORDER BY pr.received_at DESC
        LIMIT $5;
        `,
      [
        companyId.trim(),
        authenticatedBranchId,
        selectedSupplierId,
        searchText,
        parsePurchaseLimit(req.query.limit),
      ],
    )

    return res.json({
      data: result.rows,
    })
  } catch (error) {
    return next(error)
  }
})

// ======================================================
// GET /api/purchases/receipts/:receiptId
// ======================================================
purchasesRouter.get(
  '/api/purchases/receipts/:receiptId',
  async (req, res, next) => {
    try {
      const receiptId = String(req.params.receiptId || '').trim()

      const companyId = req.query.companyId
      const branchId = req.query.branchId

      if (!isPurchaseUuid(receiptId)) {
        return res.status(400).json({
          error: 'receiptId is invalid',
        })
      }

      if (typeof companyId !== 'string' || !companyId.trim()) {
        return res.status(400).json({
          error: 'companyId query parameter is required',
        })
      }

      const authenticatedBranchId =
        typeof branchId === 'string' && branchId.trim() ? branchId.trim() : null

      const details = await loadPurchaseReceiptDetails(
        companyId.trim(),
        receiptId,
        authenticatedBranchId,
      )

      if (!details) {
        return res.status(404).json({
          error: 'Purchase receipt was not found',
        })
      }

      return res.json({
        data: details,
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// POST /api/purchases/receipts
//
// إنشاء إذن استلام مباشر وإضافة الكميات للمخزون.
//
// لا نعتمد على branchId المرسل من الواجهة؛
// الفرع الحقيقي يأتي من مكان التخزين الموثوق.
// ======================================================
purchasesRouter.post('/api/purchases/receipts', async (req, res, next) => {
  const client = await db.connect()

  try {
    const {
      companyId,
      branchId,
      supplierId,
      stockLocationId,
      receiptNumber,
      idempotencyKey,
      note,
      createdBy,
      items,
    } = req.body

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res.status(400).json({
        error: 'companyId is required',
      })
    }

    if (typeof supplierId !== 'string' || !isPurchaseUuid(supplierId.trim())) {
      return res.status(400).json({
        error: 'supplierId is invalid',
      })
    }

    if (
      typeof stockLocationId !== 'string' ||
      !isPurchaseUuid(stockLocationId.trim())
    ) {
      return res.status(400).json({
        error: 'stockLocationId is invalid',
      })
    }

    if (typeof receiptNumber !== 'string' || !receiptNumber.trim()) {
      return res.status(400).json({
        error: 'receiptNumber is required',
      })
    }

    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
      return res.status(400).json({
        error: 'idempotencyKey is required',
      })
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: 'Purchase receipt items are required',
      })
    }

    const authenticatedBranchId =
      typeof branchId === 'string' && branchId.trim() ? branchId.trim() : null

    const existingReceipt = await loadReceiptByIdempotency(
      companyId.trim(),
      idempotencyKey.trim(),
      authenticatedBranchId,
    )

    if (existingReceipt) {
      return res.status(200).json({
        duplicated: true,
        data: existingReceipt,
      })
    }

    const normalizedItems: Array<{
      variantId: string
      quantity: number
      unitCost: number
      discountAmount: number
      taxAmount: number
      lineBase: number
      lineTotal: number
    }> = []

    const variantIds = new Set<string>()

    for (const item of items) {
      const variantId =
        typeof item?.variantId === 'string' ? item.variantId.trim() : ''

      const quantity = Number(item?.quantity)

      const unitCost = Number(item?.unitCost)

      const discountAmount = Number(item?.discountAmount ?? 0)

      const taxAmount = Number(item?.taxAmount ?? 0)

      if (!isPurchaseUuid(variantId)) {
        throw new PurchasesApiError(
          400,
          'variantId is invalid for one or more items',
        )
      }

      if (variantIds.has(variantId)) {
        throw new PurchasesApiError(
          400,
          'Duplicate variant inside purchase receipt',
        )
      }

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new PurchasesApiError(
          400,
          'Purchase quantity must be greater than zero',
        )
      }

      if (!Number.isFinite(unitCost) || unitCost < 0) {
        throw new PurchasesApiError(400, 'Unit cost is invalid')
      }

      if (!Number.isFinite(discountAmount) || discountAmount < 0) {
        throw new PurchasesApiError(400, 'Discount amount is invalid')
      }

      if (!Number.isFinite(taxAmount) || taxAmount < 0) {
        throw new PurchasesApiError(400, 'Tax amount is invalid')
      }

      const normalizedQuantity = roundPurchaseQuantity(quantity)

      const normalizedUnitCost = roundPurchaseMoney(unitCost)

      const normalizedDiscount = roundPurchaseMoney(discountAmount)

      const normalizedTax = roundPurchaseMoney(taxAmount)

      const lineBase = roundPurchaseMoney(
        normalizedQuantity * normalizedUnitCost,
      )

      const lineTotal = roundPurchaseMoney(
        lineBase - normalizedDiscount + normalizedTax,
      )

      if (lineTotal < 0) {
        throw new PurchasesApiError(400, 'Line total cannot be negative')
      }

      variantIds.add(variantId)

      normalizedItems.push({
        variantId,
        quantity: normalizedQuantity,
        unitCost: normalizedUnitCost,
        discountAmount: normalizedDiscount,
        taxAmount: normalizedTax,
        lineBase,
        lineTotal,
      })
    }

    // ترتيب ثابت يقلل احتمالات Deadlock
    // عند استلام أكثر من صنف في نفس الوقت.
    normalizedItems.sort((first, second) =>
      first.variantId.localeCompare(second.variantId),
    )

    const subtotal = roundPurchaseMoney(
      normalizedItems.reduce((total, item) => total + item.lineBase, 0),
    )

    const discountTotal = roundPurchaseMoney(
      normalizedItems.reduce((total, item) => total + item.discountAmount, 0),
    )

    const taxTotal = roundPurchaseMoney(
      normalizedItems.reduce((total, item) => total + item.taxAmount, 0),
    )

    const receiptTotal = roundPurchaseMoney(
      normalizedItems.reduce((total, item) => total + item.lineTotal, 0),
    )

    await client.query('BEGIN')

    const supplierResult = await client.query(
      `
          SELECT
            id,
            name,
            code
          FROM suppliers
          WHERE company_id = $1
            AND id = $2
            AND is_active = TRUE
          FOR SHARE;
          `,
      [companyId.trim(), supplierId.trim()],
    )

    if ((supplierResult.rowCount ?? 0) === 0) {
      throw new PurchasesApiError(404, 'Supplier was not found or inactive')
    }

    const locationResult = await client.query(
      `
          SELECT
            id,
            branch_id,
            name,
            code
          FROM stock_locations
          WHERE company_id = $1
            AND id = $2
            AND is_active = TRUE
            AND (
              $3::uuid IS NULL
              OR branch_id = $3::uuid
            )
          FOR SHARE;
          `,
      [companyId.trim(), stockLocationId.trim(), authenticatedBranchId],
    )

    if ((locationResult.rowCount ?? 0) === 0) {
      throw new PurchasesApiError(
        404,
        'Stock location was not found or is not allowed for this branch',
      )
    }

    const trustedLocation = locationResult.rows[0]

    const variantsResult = await client.query(
      `
          SELECT id
          FROM product_variants
          WHERE company_id = $1
            AND id = ANY($2::uuid[])
            AND status = 'active';
          `,
      [companyId.trim(), Array.from(variantIds)],
    )

    if ((variantsResult.rowCount ?? 0) !== normalizedItems.length) {
      throw new PurchasesApiError(
        404,
        'One or more purchase items were not found or inactive',
      )
    }

    const receiptResult = await client.query(
      `
          INSERT INTO purchase_receipts (
            company_id,
            branch_id,
            stock_location_id,
            supplier_id,
            purchase_order_id,
            receipt_number,
            idempotency_key,
            status,
            subtotal,
            discount_total,
            tax_total,
            total,
            received_at,
            note,
            created_by
          )
          VALUES (
            $1, $2, $3, $4,
            NULL,
            $5, $6,
            'received',
            $7, $8, $9, $10,
            NOW(),
            $11,
            $12
          )
          RETURNING *;
          `,
      [
        companyId.trim(),
        trustedLocation.branch_id,
        stockLocationId.trim(),
        supplierId.trim(),
        receiptNumber.trim(),
        idempotencyKey.trim(),
        subtotal,
        discountTotal,
        taxTotal,
        receiptTotal,
        typeof note === 'string' && note.trim() ? note.trim() : null,
        createdBy || null,
      ],
    )

    const createdReceipt = receiptResult.rows[0]

    const createdItems: Array<Record<string, unknown>> = []

    for (const item of normalizedItems) {
      // ======================================================
      // قفل الصنف وتحديث متوسط التكلفة المرجح.
      //
      // متوسط التكلفة =
      // قيمة المخزون السابقة + قيمة المشتريات الجديدة
      // ÷ إجمالي الكمية بعد الاستلام.
      // ======================================================
      const variantCostResult = await client.query(
        `
        SELECT
          id,
          cost_price
        FROM product_variants
        WHERE company_id = $1
          AND id = $2
          AND status = 'active'
        FOR UPDATE;
        `,
        [companyId.trim(), item.variantId],
      )

      if ((variantCostResult.rowCount ?? 0) === 0) {
        throw new PurchasesApiError(404, 'Purchase variant was not found')
      }

      const previousCost = Number(variantCostResult.rows[0].cost_price)

      if (!Number.isFinite(previousCost)) {
        throw new PurchasesApiError(500, 'Previous variant cost is invalid')
      }

      const itemResult = await client.query(
        `
            INSERT INTO purchase_receipt_items (
              company_id,
              purchase_receipt_id,
              purchase_order_item_id,
              variant_id,
              quantity,
              unit_cost,
              discount_amount,
              tax_amount,
              line_total
            )
            VALUES (
              $1, $2, NULL,
              $3, $4, $5,
              $6, $7, $8
            )
            RETURNING *;
            `,
        [
          companyId.trim(),
          createdReceipt.id,
          item.variantId,
          item.quantity,
          item.unitCost,
          item.discountAmount,
          item.taxAmount,
          item.lineTotal,
        ],
      )

      createdItems.push(itemResult.rows[0])

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
          trustedLocation.branch_id,
          stockLocationId.trim(),
          item.variantId,
        ],
      )

      const balanceResult = await client.query(
        `
            SELECT quantity
            FROM stock_balances
            WHERE company_id = $1
              AND stock_location_id = $2
              AND variant_id = $3
            FOR UPDATE;
            `,
        [companyId.trim(), stockLocationId.trim(), item.variantId],
      )

      if ((balanceResult.rowCount ?? 0) === 0) {
        throw new PurchasesApiError(500, 'Stock balance row was not found')
      }

      const quantityBefore = Number(balanceResult.rows[0].quantity)

      if (!Number.isFinite(quantityBefore)) {
        throw new PurchasesApiError(500, 'Current stock quantity is invalid')
      }

      const previousInventoryValue = roundPurchaseMoney(
        quantityBefore * previousCost,
      )

      const receivedInventoryValue = roundPurchaseMoney(
        item.quantity * item.unitCost,
      )

      const quantityAfter = roundPurchaseQuantity(
        quantityBefore + item.quantity,
      )

      const weightedAverageCost =
        quantityAfter > 0
          ? roundPurchaseMoney(
              (previousInventoryValue + receivedInventoryValue) / quantityAfter,
            )
          : item.unitCost

      await client.query(
        `
        UPDATE product_variants
        SET
          cost_price = $1,
          updated_at = NOW()
        WHERE company_id = $2
          AND id = $3;
        `,
        [weightedAverageCost, companyId.trim(), item.variantId],
      )

      await client.query(
        `
          UPDATE stock_balances
          SET
            quantity = $1,
            branch_id = $2,
            updated_at = NOW()
          WHERE company_id = $3
            AND stock_location_id = $4
            AND variant_id = $5;
          `,
        [
          quantityAfter,
          trustedLocation.branch_id,
          companyId.trim(),
          stockLocationId.trim(),
          item.variantId,
        ],
      )

      await client.query(
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
            'purchase',
            $5, $6, $7,
            'purchase',
            $8,
            $9,
            $10
          );
          `,
        [
          companyId.trim(),
          trustedLocation.branch_id,
          stockLocationId.trim(),
          item.variantId,
          item.quantity,
          quantityBefore,
          quantityAfter,
          createdReceipt.id,
          `Purchase receipt ${createdReceipt.receipt_number}`,
          createdBy || null,
        ],
      )
    }

    await client.query('COMMIT')

    const details = await loadPurchaseReceiptDetails(
      companyId.trim(),
      createdReceipt.id,
      authenticatedBranchId,
    )

    return res.status(201).json({
      data: details || {
        receipt: createdReceipt,
        items: createdItems,
      },
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})

    if (isPostgresUniqueViolation(error)) {
      const requestCompanyId =
        typeof req.body?.companyId === 'string' ? req.body.companyId.trim() : ''

      const requestBranchId =
        typeof req.body?.branchId === 'string' && req.body.branchId.trim()
          ? req.body.branchId.trim()
          : null

      const requestIdempotencyKey =
        typeof req.body?.idempotencyKey === 'string'
          ? req.body.idempotencyKey.trim()
          : ''

      if (requestCompanyId && requestIdempotencyKey) {
        const existingReceipt = await loadReceiptByIdempotency(
          requestCompanyId,
          requestIdempotencyKey,
          requestBranchId,
        )

        if (existingReceipt) {
          return res.status(200).json({
            duplicated: true,
            data: existingReceipt,
          })
        }
      }

      return res.status(409).json({
        error: 'رقم إذن الاستلام مستخدم بالفعل.',
      })
    }

    if (error instanceof PurchasesApiError) {
      return res.status(error.statusCode).json({
        error: error.message,
      })
    }

    return next(error)
  } finally {
    client.release()
  }
})
