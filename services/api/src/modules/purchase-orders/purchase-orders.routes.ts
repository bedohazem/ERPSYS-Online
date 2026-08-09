import { Router } from 'express'

import { db } from '../../db/pool'
import { getAuthContext } from '../auth/auth.middleware'

import {
  applyWeightedAveragePurchaseInbound,
  calculatePurchaseInventoryUnitCost,
} from '../inventory/inventory-cost.service'

export const purchaseOrdersRouter = Router()

class PurchaseOrderApiError extends Error {
  statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isUuid(value: string) {
  return uuidPattern.test(value)
}

function roundMoney(value: number) {
  return Number(value.toFixed(2))
}

function roundQuantity(value: number) {
  return Number(value.toFixed(3))
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  )
}

function parseLimit(value: unknown) {
  const numericValue = Number(value ?? 50)

  if (!Number.isFinite(numericValue)) {
    return 50
  }

  return Math.min(Math.max(Math.trunc(numericValue), 1), 100)
}

// ======================================================
// تحميل أمر شراء كامل.
// ======================================================
async function loadPurchaseOrderDetails(
  companyId: string,
  purchaseOrderId: string,
  branchId: string | null,
) {
  const orderResult = await db.query(
    `
    SELECT
      po.*,

      s.name AS supplier_name,
      s.code AS supplier_code,

      b.name AS branch_name,

      u.full_name AS created_by_name,

      COUNT(poi.id)::int AS items_count,

      COALESCE(
        SUM(poi.quantity),
        0
      ) AS ordered_quantity,

      COALESCE(
        SUM(poi.received_quantity),
        0
      ) AS received_quantity,

      COALESCE(
        SUM(
          poi.quantity -
          poi.received_quantity
        ),
        0
      ) AS remaining_quantity

    FROM purchase_orders po

    JOIN suppliers s
      ON s.id = po.supplier_id
      AND s.company_id = po.company_id

    LEFT JOIN branches b
      ON b.id = po.branch_id
      AND b.company_id = po.company_id

    LEFT JOIN users u
      ON u.id = po.created_by
      AND u.company_id = po.company_id

    LEFT JOIN purchase_order_items poi
      ON poi.purchase_order_id = po.id
      AND poi.company_id = po.company_id

    WHERE po.company_id = $1
      AND po.id = $2

      AND (
        $3::uuid IS NULL
        OR po.branch_id = $3::uuid
      )

    GROUP BY
      po.id,
      s.name,
      s.code,
      b.name,
      u.full_name

    LIMIT 1;
    `,
    [companyId, purchaseOrderId, branchId],
  )

  if ((orderResult.rowCount ?? 0) === 0) {
    return null
  }

  const itemsResult = await db.query(
    `
    SELECT
      poi.*,

      pv.sku,
      pv.primary_barcode,
      pv.cost_price AS current_average_cost,

      p.name AS product_name,

      fs.name AS size_name,
      fc.name AS color_name,

      (
        poi.quantity -
        poi.received_quantity
      ) AS remaining_quantity

    FROM purchase_order_items poi

    JOIN product_variants pv
      ON pv.id = poi.variant_id
      AND pv.company_id = poi.company_id

    JOIN products p
      ON p.id = pv.product_id
      AND p.company_id = pv.company_id

    LEFT JOIN fashion_sizes fs
      ON fs.id = pv.size_id
      AND fs.company_id = pv.company_id

    LEFT JOIN fashion_colors fc
      ON fc.id = pv.color_id
      AND fc.company_id = pv.company_id

    WHERE poi.company_id = $1
      AND poi.purchase_order_id = $2

    ORDER BY
      p.name ASC,
      pv.sku ASC;
    `,
    [companyId, purchaseOrderId],
  )

  return {
    order: orderResult.rows[0],
    items: itemsResult.rows,
  }
}

async function loadOrderByIdempotency(
  companyId: string,
  idempotencyKey: string,
  branchId: string | null,
) {
  const result = await db.query(
    `
    SELECT id
    FROM purchase_orders
    WHERE company_id = $1
      AND idempotency_key = $2
    LIMIT 1;
    `,
    [companyId, idempotencyKey],
  )

  if ((result.rowCount ?? 0) === 0) {
    return null
  }

  return loadPurchaseOrderDetails(companyId, result.rows[0].id, branchId)
}

// ======================================================
// معرفة إذن الاستلام المرتبط بمفتاح Idempotency.
//
// نستخدمها في الطلب العادي والطلب المتزامن.
// ======================================================
async function loadReceiptIdempotencyContext(
  companyId: string,
  idempotencyKey: string,
) {
  const result = await db.query(
    `
    SELECT
      id,
      purchase_order_id,
      receipt_number
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

  return result.rows[0] as {
    id: string
    purchase_order_id: string | null
    receipt_number: string
  }
}

// ======================================================
// GET /api/purchase-orders
// ======================================================
purchaseOrdersRouter.get('/api/purchase-orders', async (req, res, next) => {
  try {
    const auth = getAuthContext(res)

    const companyId = auth.companyId
    const authenticatedBranchId = auth.branchId

    const status = req.query.status
    const query = req.query.q

    const selectedStatus =
      typeof status === 'string' && status.trim() ? status.trim() : null

    const allowedStatuses = new Set([
      'draft',
      'ordered',
      'partially_received',
      'received',
      'cancelled',
    ])

    if (selectedStatus && !allowedStatuses.has(selectedStatus)) {
      return res.status(400).json({
        error: 'Unsupported purchase order status',
      })
    }

    const searchText =
      typeof query === 'string' && query.trim() ? `%${query.trim()}%` : null

    const result = await db.query(
      `
        SELECT
          po.id,
          po.company_id,
          po.branch_id,
          b.name AS branch_name,

          po.supplier_id,
          s.name AS supplier_name,
          s.code AS supplier_code,

          po.purchase_number,
          po.status,

          po.subtotal,
          po.discount_total,
          po.tax_total,
          po.total,

          po.order_date,
          po.expected_date,
          po.received_at,
          po.note,
          po.created_at,

          COUNT(poi.id)::int
            AS items_count,

          COALESCE(
            SUM(poi.quantity),
            0
          ) AS ordered_quantity,

          COALESCE(
            SUM(poi.received_quantity),
            0
          ) AS received_quantity,

          COALESCE(
            SUM(
              poi.quantity -
              poi.received_quantity
            ),
            0
          ) AS remaining_quantity

        FROM purchase_orders po

        JOIN suppliers s
          ON s.id = po.supplier_id
          AND s.company_id = po.company_id

        LEFT JOIN branches b
          ON b.id = po.branch_id
          AND b.company_id = po.company_id

        LEFT JOIN purchase_order_items poi
          ON poi.purchase_order_id = po.id
          AND poi.company_id = po.company_id

        WHERE po.company_id = $1

          AND (
            $2::uuid IS NULL
            OR po.branch_id = $2::uuid
          )

          AND (
            $3::text IS NULL
            OR po.status = $3::text
          )

          AND (
            $4::text IS NULL
            OR po.purchase_number ILIKE $4
            OR s.name ILIKE $4
            OR s.code ILIKE $4
          )

        GROUP BY
          po.id,
          b.name,
          s.name,
          s.code

        ORDER BY po.order_date DESC
        LIMIT $5;
        `,
      [
        companyId,
        authenticatedBranchId,
        selectedStatus,
        searchText,
        parseLimit(req.query.limit),
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
// GET /api/purchase-orders/:purchaseOrderId
// ======================================================
purchaseOrdersRouter.get(
  '/api/purchase-orders/:purchaseOrderId',
  async (req, res, next) => {
    try {
      const auth = getAuthContext(res)

      const purchaseOrderId = String(req.params.purchaseOrderId || '')
        .trim()
        .toLowerCase()

      if (!isUuid(purchaseOrderId)) {
        return res.status(400).json({
          error: 'purchaseOrderId is invalid',
        })
      }

      const details = await loadPurchaseOrderDetails(
        auth.companyId,
        purchaseOrderId,
        auth.branchId,
      )

      if (!details) {
        return res.status(404).json({
          error: 'أمر الشراء غير موجود أو غير مسموح بعرضه.',
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
// POST /api/purchase-orders
//
// إنشاء أمر شراء بحالة ordered.
// لا يتم تعديل المخزون هنا.
// ======================================================
purchaseOrdersRouter.post('/api/purchase-orders', async (req, res, next) => {
  const auth = getAuthContext(res)
  const client = await db.connect()

  try {
    const {
      supplierId,
      purchaseNumber,
      idempotencyKey,
      expectedDate,
      note,
      items,
    } = req.body

    // الشركة والفرع والمستخدم من Session فقط.
    const companyId = auth.companyId
    const authenticatedBranchId = auth.branchId
    const createdBy = auth.userId

    if (typeof supplierId !== 'string' || !isUuid(supplierId.trim())) {
      return res.status(400).json({
        error: 'supplierId is invalid',
      })
    }

    if (typeof purchaseNumber !== 'string' || !purchaseNumber.trim()) {
      return res.status(400).json({
        error: 'purchaseNumber is required',
      })
    }

    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
      return res.status(400).json({
        error: 'idempotencyKey is required',
      })
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: 'Purchase order items are required',
      })
    }

    const existingOrder = await loadOrderByIdempotency(
      companyId,
      idempotencyKey.trim(),
      authenticatedBranchId,
    )

    if (existingOrder) {
      return res.status(200).json({
        duplicated: true,
        data: existingOrder,
      })
    }

    const normalizedItems: Array<{
      variantId: string
      quantity: number
      unitCost: number
      discountAmount: number
      taxAmount: number
      lineTotal: number
    }> = []

    const variantIds = new Set<string>()

    for (const item of items) {
      const variantId =
        typeof item?.variantId === 'string' ? item.variantId.trim() : ''

      const quantity = roundQuantity(Number(item?.quantity))

      const unitCost = roundMoney(Number(item?.unitCost))

      const discountAmount = roundMoney(Number(item?.discountAmount ?? 0))

      const taxAmount = roundMoney(Number(item?.taxAmount ?? 0))

      if (!isUuid(variantId)) {
        throw new PurchaseOrderApiError(400, 'variantId is invalid')
      }

      if (variantIds.has(variantId)) {
        throw new PurchaseOrderApiError(
          400,
          'Duplicate variant inside purchase order',
        )
      }

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new PurchaseOrderApiError(
          400,
          'Quantity must be greater than zero',
        )
      }

      if (!Number.isFinite(unitCost) || unitCost < 0) {
        throw new PurchaseOrderApiError(400, 'Unit cost is invalid')
      }

      if (
        !Number.isFinite(discountAmount) ||
        discountAmount < 0 ||
        !Number.isFinite(taxAmount) ||
        taxAmount < 0
      ) {
        throw new PurchaseOrderApiError(400, 'Discount or tax is invalid')
      }

      const lineTotal = roundMoney(
        quantity * unitCost - discountAmount + taxAmount,
      )

      if (lineTotal < 0) {
        throw new PurchaseOrderApiError(400, 'Line total cannot be negative')
      }

      variantIds.add(variantId)

      normalizedItems.push({
        variantId,
        quantity,
        unitCost,
        discountAmount,
        taxAmount,
        lineTotal,
      })
    }

    normalizedItems.sort((first, second) =>
      first.variantId.localeCompare(second.variantId),
    )

    const subtotal = roundMoney(
      normalizedItems.reduce(
        (total, item) => total + item.quantity * item.unitCost,
        0,
      ),
    )

    const discountTotal = roundMoney(
      normalizedItems.reduce((total, item) => total + item.discountAmount, 0),
    )

    const taxTotal = roundMoney(
      normalizedItems.reduce((total, item) => total + item.taxAmount, 0),
    )

    const total = roundMoney(
      normalizedItems.reduce((sum, item) => sum + item.lineTotal, 0),
    )

    await client.query('BEGIN')

    const supplierResult = await client.query(
      `
          SELECT id
          FROM suppliers
          WHERE company_id = $1
            AND id = $2
            AND is_active = TRUE
          FOR SHARE;
          `,
      [companyId, supplierId.trim()],
    )

    if ((supplierResult.rowCount ?? 0) === 0) {
      throw new PurchaseOrderApiError(404, 'Supplier was not found or inactive')
    }

    const variantsResult = await client.query(
      `
          SELECT id
          FROM product_variants
          WHERE company_id = $1
            AND id = ANY($2::uuid[])
            AND status = 'active';
          `,
      [companyId, Array.from(variantIds)],
    )

    if ((variantsResult.rowCount ?? 0) !== normalizedItems.length) {
      throw new PurchaseOrderApiError(404, 'One or more items were not found')
    }

    const orderResult = await client.query(
      `
          INSERT INTO purchase_orders (
            company_id,
            branch_id,
            supplier_id,
            purchase_number,
            idempotency_key,
            status,
            subtotal,
            discount_total,
            tax_total,
            total,
            order_date,
            expected_date,
            note,
            created_by,
            updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5,
            'ordered',
            $6, $7, $8, $9,
            NOW(),
            $10,
            $11,
            $12,
            NOW()
          )
          RETURNING *;
          `,
      [
        companyId,
        authenticatedBranchId,
        supplierId.trim(),
        purchaseNumber.trim(),
        idempotencyKey.trim(),
        subtotal,
        discountTotal,
        taxTotal,
        total,
        typeof expectedDate === 'string' && expectedDate.trim()
          ? expectedDate.trim()
          : null,
        typeof note === 'string' && note.trim() ? note.trim() : null,
        createdBy,
      ],
    )

    const createdOrder = orderResult.rows[0]

    for (const item of normalizedItems) {
      await client.query(
        `
          INSERT INTO purchase_order_items (
            company_id,
            purchase_order_id,
            variant_id,
            quantity,
            received_quantity,
            unit_cost,
            discount_amount,
            tax_amount,
            line_total
          )
          VALUES (
            $1, $2, $3, $4,
            0, $5, $6, $7, $8
          );
          `,
        [
          companyId,
          createdOrder.id,
          item.variantId,
          item.quantity,
          item.unitCost,
          item.discountAmount,
          item.taxAmount,
          item.lineTotal,
        ],
      )
    }

    await client.query('COMMIT')

    const details = await loadPurchaseOrderDetails(
      companyId,
      createdOrder.id,
      authenticatedBranchId,
    )

    return res.status(201).json({
      data: details,
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})

    if (isUniqueViolation(error)) {
      const requestIdempotencyKey =
        typeof req.body?.idempotencyKey === 'string'
          ? req.body.idempotencyKey.trim()
          : ''

      if (requestIdempotencyKey) {
        const existingOrder = await loadOrderByIdempotency(
          auth.companyId,
          requestIdempotencyKey,
          auth.branchId,
        )

        if (existingOrder) {
          return res.status(200).json({
            duplicated: true,
            data: existingOrder,
          })
        }
      }

      return res.status(409).json({
        error: 'رقم أمر الشراء مستخدم بالفعل.',
      })
    }

    // أخطاء العمل المتوقعة لا يجب أن تصل إلى
    // Global Error Handler وتتحول إلى 500.
    if (error instanceof PurchaseOrderApiError) {
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
// POST /api/purchase-orders/:purchaseOrderId/receive
//
// استلام جزئي أو كامل لأمر الشراء.
// ======================================================
purchaseOrdersRouter.post(
  '/api/purchase-orders/:purchaseOrderId/receive',
  async (req, res, next) => {
    const auth = getAuthContext(res)
    const client = await db.connect()

    // يجب تعريفه خارج try لأن catch يحتاج استخدامه
    // عند معالجة طلبات Idempotency المتزامنة.
    const purchaseOrderId = String(req.params.purchaseOrderId || '')
      .trim()
      .toLowerCase()

    try {
      const { stockLocationId, receiptNumber, idempotencyKey, note, items } =
        req.body

      const companyId = auth.companyId
      const authenticatedBranchId = auth.branchId
      const createdBy = auth.userId

      if (!isUuid(purchaseOrderId)) {
        return res.status(400).json({
          error: 'purchaseOrderId is invalid',
        })
      }

      if (
        typeof stockLocationId !== 'string' ||
        !isUuid(stockLocationId.trim())
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
          error: 'Received items are required',
        })
      }

      const existingReceipt = await loadReceiptIdempotencyContext(
        companyId,
        idempotencyKey.trim(),
      )

      if (existingReceipt) {
        // نفس المفتاح لا يجوز استخدامه لأمر شراء مختلف.
        if (existingReceipt.purchase_order_id !== purchaseOrderId) {
          return res.status(409).json({
            error: 'Idempotency key belongs to another purchase order receipt',
          })
        }

        const details = await loadPurchaseOrderDetails(
          companyId,
          purchaseOrderId,
          authenticatedBranchId,
        )

        return res.status(200).json({
          duplicated: true,
          data: details,
        })
      }

      const normalizedItems: Array<{
        purchaseOrderItemId: string
        quantity: number
      }> = []

      const itemIds = new Set<string>()

      for (const item of items) {
        const purchaseOrderItemId =
          typeof item?.purchaseOrderItemId === 'string'
            ? item.purchaseOrderItemId.trim()
            : ''

        const quantity = roundQuantity(Number(item?.quantity))

        if (!isUuid(purchaseOrderItemId)) {
          throw new PurchaseOrderApiError(400, 'purchaseOrderItemId is invalid')
        }

        if (itemIds.has(purchaseOrderItemId)) {
          throw new PurchaseOrderApiError(400, 'Duplicate purchase order item')
        }

        if (!Number.isFinite(quantity) || quantity <= 0) {
          throw new PurchaseOrderApiError(
            400,
            'Received quantity must be greater than zero',
          )
        }

        itemIds.add(purchaseOrderItemId)

        normalizedItems.push({
          purchaseOrderItemId,
          quantity,
        })
      }

      normalizedItems.sort((first, second) =>
        first.purchaseOrderItemId.localeCompare(second.purchaseOrderItemId),
      )

      await client.query('BEGIN')

      const orderResult = await client.query(
        `
          SELECT *
          FROM purchase_orders
          WHERE company_id = $1
            AND id = $2
            AND status IN (
              'ordered',
              'partially_received'
            )
            AND (
              $3::uuid IS NULL
              OR branch_id = $3::uuid
            )
          FOR UPDATE;
          `,
        [companyId, purchaseOrderId, authenticatedBranchId],
      )

      if ((orderResult.rowCount ?? 0) === 0) {
        throw new PurchaseOrderApiError(
          404,
          'Purchase order was not found or is closed',
        )
      }

      const order = orderResult.rows[0]

      const locationResult = await client.query(
        `
          SELECT
            id,
            branch_id
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
        [companyId, stockLocationId.trim(), authenticatedBranchId],
      )

      if ((locationResult.rowCount ?? 0) === 0) {
        throw new PurchaseOrderApiError(
          404,
          'Stock location was not found or not allowed',
        )
      }

      const trustedLocation = locationResult.rows[0]

      const selectedOrderItemsResult = await client.query(
        `
          SELECT *
          FROM purchase_order_items
          WHERE company_id = $1
            AND purchase_order_id = $2
            AND id = ANY($3::uuid[])
          ORDER BY id ASC
          FOR UPDATE;
          `,
        [companyId, purchaseOrderId, Array.from(itemIds)],
      )

      if ((selectedOrderItemsResult.rowCount ?? 0) !== normalizedItems.length) {
        throw new PurchaseOrderApiError(
          404,
          'One or more purchase order items were not found',
        )
      }

      const selectedOrderItems = selectedOrderItemsResult.rows

      const receiptItems: Array<{
        orderItem: Record<string, unknown>
        quantity: number
      }> = []

      let receiptSubtotal = 0
      let receiptDiscountTotal = 0
      let receiptTaxTotal = 0
      let receiptTotal = 0

      for (const normalizedItem of normalizedItems) {
        const orderItem = selectedOrderItems.find(
          (currentItem) =>
            currentItem.id === normalizedItem.purchaseOrderItemId,
        )

        if (!orderItem) {
          throw new PurchaseOrderApiError(
            404,
            'Purchase order item was not found',
          )
        }

        const orderedQuantity = Number(orderItem.quantity)

        const alreadyReceived = Number(orderItem.received_quantity)

        const remainingQuantity = roundQuantity(
          orderedQuantity - alreadyReceived,
        )

        if (normalizedItem.quantity > remainingQuantity) {
          throw new PurchaseOrderApiError(
            409,
            `Received quantity exceeds remaining quantity for item ${orderItem.id}`,
          )
        }

        const ratio = normalizedItem.quantity / orderedQuantity

        const itemSubtotal = roundMoney(
          normalizedItem.quantity * Number(orderItem.unit_cost),
        )

        const itemDiscount = roundMoney(
          Number(orderItem.discount_amount) * ratio,
        )

        const itemTax = roundMoney(Number(orderItem.tax_amount) * ratio)

        const itemTotal = roundMoney(itemSubtotal - itemDiscount + itemTax)

        receiptSubtotal += itemSubtotal
        receiptDiscountTotal += itemDiscount
        receiptTaxTotal += itemTax
        receiptTotal += itemTotal

        receiptItems.push({
          orderItem,
          quantity: normalizedItem.quantity,
        })
      }

      receiptSubtotal = roundMoney(receiptSubtotal)

      receiptDiscountTotal = roundMoney(receiptDiscountTotal)

      receiptTaxTotal = roundMoney(receiptTaxTotal)

      receiptTotal = roundMoney(receiptTotal)

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
            $1, $2, $3, $4, $5,
            $6, $7,
            'received',
            $8, $9, $10, $11,
            NOW(),
            $12,
            $13
          )
          RETURNING *;
          `,
        [
          companyId,
          trustedLocation.branch_id,
          stockLocationId.trim(),
          order.supplier_id,
          purchaseOrderId,
          receiptNumber.trim(),
          idempotencyKey.trim(),
          receiptSubtotal,
          receiptDiscountTotal,
          receiptTaxTotal,
          receiptTotal,
          typeof note === 'string' && note.trim() ? note.trim() : null,
          createdBy,
        ],
      )

      const createdReceipt = receiptResult.rows[0]

      for (const receiptItem of receiptItems) {
        const orderItem = receiptItem.orderItem as {
          id: string
          variant_id: string
          quantity: string
          received_quantity: string
          unit_cost: string
          discount_amount: string
          tax_amount: string
        }

        const receivedQuantity = receiptItem.quantity

        const orderedQuantity = Number(orderItem.quantity)

        const ratio = receivedQuantity / orderedQuantity

        const lineDiscount = roundMoney(
          Number(orderItem.discount_amount) * ratio,
        )

        const lineTax = roundMoney(Number(orderItem.tax_amount) * ratio)

        const lineTotal = roundMoney(
          receivedQuantity * Number(orderItem.unit_cost) -
            lineDiscount +
            lineTax,
        )

        const inventoryUnitCost = calculatePurchaseInventoryUnitCost({
          quantity: receivedQuantity,

          unitCost: Number(orderItem.unit_cost),

          discountAmount: lineDiscount,
        })

        await client.query(
          `
            INSERT INTO purchase_receipt_items (
              company_id,
              purchase_receipt_id,
              purchase_order_item_id,
              variant_id,

              quantity,
              unit_cost,
              inventory_unit_cost,

              discount_amount,
              tax_amount,
              line_total
            )
            VALUES (
              $1, $2, $3, $4,
              $5, $6, $7,
              $8, $9, $10
            );
          `,
          [
            companyId,
            createdReceipt.id,
            orderItem.id,
            orderItem.variant_id,

            receivedQuantity,
            Number(orderItem.unit_cost),
            inventoryUnitCost,

            lineDiscount,
            lineTax,
            lineTotal,
          ],
        )

        await applyWeightedAveragePurchaseInbound(client, {
          companyId,

          branchId: trustedLocation.branch_id,

          stockLocationId: stockLocationId.trim(),

          variantId: orderItem.variant_id,

          quantity: receivedQuantity,

          inventoryUnitCost,

          referenceType: 'purchase_receipt',

          referenceId: createdReceipt.id,

          note: `Purchase order ${order.purchase_number} / Receipt ${createdReceipt.receipt_number}`,

          createdBy,
        })

        await client.query(
          `
          UPDATE purchase_order_items
          SET
            received_quantity =
              received_quantity + $1
          WHERE company_id = $2
            AND purchase_order_id = $3
            AND id = $4;
          `,
          [receivedQuantity, companyId, purchaseOrderId, orderItem.id],
        )
      }

      const remainingResult = await client.query(
        `
          SELECT
            COALESCE(
              SUM(
                quantity -
                received_quantity
              ),
              0
            ) AS remaining_quantity
          FROM purchase_order_items
          WHERE company_id = $1
            AND purchase_order_id = $2;
          `,
        [companyId, purchaseOrderId],
      )

      const remainingQuantity = Number(
        remainingResult.rows[0].remaining_quantity,
      )

      const nextStatus =
        remainingQuantity <= 0 ? 'received' : 'partially_received'

      await client.query(
        `
        UPDATE purchase_orders
        SET
          status = $1,
          received_at =
            CASE
              WHEN $1 = 'received'
              THEN NOW()
              ELSE received_at
            END,
          updated_at = NOW()
        WHERE company_id = $2
          AND id = $3;
        `,
        [nextStatus, companyId, purchaseOrderId],
      )

      await client.query('COMMIT')

      const details = await loadPurchaseOrderDetails(
        companyId,
        purchaseOrderId,
        authenticatedBranchId,
      )

      return res.status(201).json({
        data: {
          order: details?.order,
          items: details?.items ?? [],
          receipt: createdReceipt,
        },
      })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})

      if (isUniqueViolation(error)) {
        const requestIdempotencyKey =
          typeof req.body?.idempotencyKey === 'string'
            ? req.body.idempotencyKey.trim()
            : ''

        if (requestIdempotencyKey) {
          const existingReceipt = await loadReceiptIdempotencyContext(
            auth.companyId,
            requestIdempotencyKey,
          )

          if (
            existingReceipt &&
            existingReceipt.purchase_order_id === purchaseOrderId
          ) {
            const details = await loadPurchaseOrderDetails(
              auth.companyId,
              purchaseOrderId,
              auth.branchId,
            )

            return res.status(200).json({
              duplicated: true,
              data: details,
            })
          }
        }

        return res.status(409).json({
          error: 'رقم إذن الاستلام مستخدم بالفعل.',
        })
      }

      if (error instanceof PurchaseOrderApiError) {
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
