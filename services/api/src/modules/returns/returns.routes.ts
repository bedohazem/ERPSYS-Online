import { Router } from 'express'
import { db } from '../../db/pool'
import { getAuthContext } from '../auth/auth.middleware'

export const returnsRouter = Router()

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function roundMoney(value: number) {
  return Number(value.toFixed(2))
}

function roundQuantity(value: number) {
  return Number(value.toFixed(3))
}

function normalizeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

// ======================================================
// ReturnsApiError
// Error مخصص للمرتجعات
//
// ليه؟
// عشان لو حصل خطأ متوقع زي:
// - صنف غير موجود
// - محاولة ترجيع كمية أكبر من المباعة
// نرجع رسالة واضحة بدل 500 Internal Server Error
// ======================================================
class ReturnsApiError extends Error {
  statusCode: number
  details?: unknown

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message)

    this.statusCode = statusCode

    this.details = details
  }
}

// طرق رد المبلغ المدعومة في قاعدة البيانات.
const allowedRefundMethods = new Set([
  'cash',
  'card',
  'wallet',
  'bank_transfer',
  'other',
])

// ======================================================
// فحص خطأ Unique Constraint من PostgreSQL.
// ======================================================
function isPostgresUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  )
}

// ======================================================
// استرجاع مرتجع محفوظ سابقًا بنفس Idempotency Key.
//
// ترجع نفس شكل استجابة إنشاء المرتجع:
// data.return
// data.items
// data.refunds
// ======================================================
async function loadReturnByIdempotency(
  companyId: string,
  idempotencyKey: string,
  branchId: string | null,
) {
  const returnResult = await db.query(
    `
      SELECT *

      FROM returns

      WHERE company_id = $1
        AND idempotency_key = $2

        AND (
          $3::uuid IS NULL
          OR branch_id = $3::uuid
        )

      LIMIT 1;
      `,
    [companyId, idempotencyKey, branchId],
  )

  if ((returnResult.rowCount ?? 0) === 0) {
    return null
  }

  const returnDocument = returnResult.rows[0]

  const [itemsResult, refundsResult] = await Promise.all([
    db.query(
      `
      SELECT *

      FROM return_items

      WHERE company_id = $1
        AND return_id = $2

      ORDER BY
        created_at ASC,
        id ASC;
      `,
      [companyId, returnDocument.id],
    ),

    db.query(
      `
      SELECT *

      FROM return_refunds

      WHERE company_id = $1
        AND return_id = $2

      ORDER BY
        created_at ASC,
        id ASC;
      `,
      [companyId, returnDocument.id],
    ),
  ])

  return {
    return: returnDocument,

    items: itemsResult.rows,

    refunds: refundsResult.rows,
  }
}

// ======================================================
// GET /api/returns
// الهدف:
// عرض قائمة المرتجعات الموجودة داخل شركة معينة
//
// مثال:
// /api/returns?companyId=xxx
// /api/returns?companyId=xxx&branchId=yyy
//
// companyId:
// مهم عشان نعرض مرتجعات الشركة الحالية فقط
//
// branchId:
// اختياري لو عايز تعرض مرتجعات فرع معين فقط
// ======================================================
returnsRouter.get('/api/returns', async (req, res, next) => {
  try {
    const auth = getAuthContext(res)

    const companyId = auth.companyId
    const branchId = auth.branchId

    const requestedLimit = Number(req.query.limit ?? 50)

    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100)
      : 50

    const result = await db.query(
      `
      SELECT
        r.id,
        r.company_id,
        r.branch_id,
        b.name AS branch_name,
        r.stock_location_id,
        sl.name AS stock_location_name,
        r.customer_id,
        c.name AS customer_name,
        r.original_sale_id,
        s.sale_number AS original_sale_number,
        r.return_number,
        r.source,
        r.subtotal,
        r.refund_total,
        r.status,
        r.reason,

        r.void_reason,
        r.voided_by,

        voider.full_name
          AS voided_by_name,

        r.voided_at,
        r.created_at,

        -- عدد الأصناف داخل المرتجع
        COUNT(ri.id)::int AS items_count
      FROM returns r
      JOIN branches b
        ON b.id = r.branch_id
        AND b.company_id = r.company_id

      JOIN stock_locations sl
        ON sl.id = r.stock_location_id
        AND sl.company_id = r.company_id

      LEFT JOIN customers c
        ON c.id = r.customer_id
        AND c.company_id = r.company_id

      LEFT JOIN sales s
        ON s.id = r.original_sale_id
        AND s.company_id = r.company_id

      LEFT JOIN users voider
        ON voider.id = r.voided_by
        AND voider.company_id =
            r.company_id
      LEFT JOIN return_items ri
        ON ri.return_id = r.id
        AND ri.company_id = r.company_id
      WHERE r.company_id = $1
        AND ($2::uuid IS NULL OR r.branch_id = $2::uuid)
      GROUP BY
        r.id,
        b.name,
        sl.name,
        c.name,
        s.sale_number,
        voider.full_name
      ORDER BY r.created_at DESC
      LIMIT $3;
      `,
      [companyId, branchId, limit],
    )

    res.json({ data: result.rows })
  } catch (error) {
    next(error)
  }
})

// ======================================================
// GET /api/returns/:returnId
// الهدف:
// عرض تفاصيل مرتجع واحد
//
// بيرجع:
// 1. بيانات المرتجع
// 2. الأصناف المرتجعة
// 3. طرق رد الفلوس
//
// مثال:
// /api/returns/RETURN_ID?companyId=xxx
// ======================================================
returnsRouter.get(
  '/api/returns/:returnId',

  async (req, res, next) => {
    try {
      const auth = getAuthContext(res)

      const returnId = normalizeParam(req.params.returnId)

      if (typeof returnId !== 'string' || !uuidPattern.test(returnId)) {
        return res.status(400).json({
          error: 'returnId is invalid',
        })
      }

      const companyId = auth.companyId

      // أول Query:
      // نجيب بيانات المرتجع الرئيسية
      const returnResult = await db.query(
        `
      SELECT
        r.id,
        r.company_id,
        r.branch_id,
        b.name AS branch_name,
        r.stock_location_id,
        sl.name AS stock_location_name,
        r.customer_id,
        c.name AS customer_name,
        r.original_sale_id,
        s.sale_number AS original_sale_number,
        r.return_number,
        r.source,
        r.idempotency_key,
        r.subtotal,
        r.refund_total,
        r.status,
        r.reason,

        r.created_by,
        u.full_name
          AS created_by_name,

        r.void_reason,
        r.voided_by,

        voider.full_name
          AS voided_by_name,

        r.voided_at,
        r.created_at,
        r.synced_at
      FROM returns r
      JOIN branches b ON b.id = r.branch_id
      JOIN stock_locations sl ON sl.id = r.stock_location_id
      LEFT JOIN customers c ON c.id = r.customer_id
      LEFT JOIN sales s ON s.id = r.original_sale_id
      LEFT JOIN users u
        ON u.id = r.created_by
        AND u.company_id =
            r.company_id

      LEFT JOIN users voider
        ON voider.id = r.voided_by
        AND voider.company_id =
            r.company_id
      WHERE r.company_id = $1
        AND r.id = $2

        AND (
          $3::uuid IS NULL
          OR r.branch_id =
            $3::uuid
        );
      `,
        [companyId, returnId, auth.branchId],
      )

      // لو المرتجع مش موجود داخل نفس الشركة
      if ((returnResult.rowCount ?? 0) === 0) {
        return res.status(404).json({ error: 'Return was not found' })
      }

      // ثاني Query:
      // نجيب الأصناف المرتجعة
      const itemsResult = await db.query(
        `
      SELECT
        id,
        return_id,
        original_sale_item_id,
        variant_id,
        sku_snapshot,
        barcode_snapshot,
        product_name_snapshot,
        size_snapshot,
        color_snapshot,
        quantity,
        unit_price,
        refund_amount,
        reason,
        created_at
      FROM return_items
      WHERE company_id = $1
        AND return_id = $2
      ORDER BY created_at ASC;
      `,
        [companyId, returnId],
      )

      // ثالث Query:
      // نجيب طرق رد الفلوس
      const refundsResult = await db.query(
        `
      SELECT
        id,
        return_id,

        method,
        amount,
        reference,

        refund_role,
        payment_direction,
        reverses_refund_id,

        created_at
      FROM return_refunds
      WHERE company_id = $1
        AND return_id = $2
      ORDER BY created_at ASC;
      `,
        [companyId, returnId],
      )

      const stockMovementsResult = await db.query(
        `
      SELECT
        sm.id,
        sm.company_id,
        sm.branch_id,
        sm.stock_location_id,
        sm.variant_id,

        sm.movement_type,
        sm.quantity,
        sm.quantity_before,
        sm.quantity_after,

        sm.reference_type,
        sm.reference_id,

        sm.reversal_of_movement_id,

        sm.note,
        sm.created_at,

        pv.sku,
        pv.primary_barcode,

        p.name
          AS product_name,

        fs.name
          AS size_name,

        fc.name
          AS color_name,

        sl.name
          AS stock_location_name

      FROM stock_movements sm

      JOIN product_variants pv
        ON pv.id = sm.variant_id
        AND pv.company_id =
            sm.company_id

      JOIN products p
        ON p.id = pv.product_id
        AND p.company_id =
            pv.company_id

      JOIN stock_locations sl
        ON sl.id =
          sm.stock_location_id
        AND sl.company_id =
            sm.company_id

      LEFT JOIN fashion_sizes fs
        ON fs.id = pv.size_id
        AND fs.company_id =
            pv.company_id

      LEFT JOIN fashion_colors fc
        ON fc.id = pv.color_id
        AND fc.company_id =
            pv.company_id

      WHERE sm.company_id = $1
        AND sm.reference_type =
            'return'

        AND sm.reference_id = $2

      ORDER BY
        sm.created_at ASC,
        sm.id ASC;
      `,
        [companyId, returnId],
      )

      res.json({
        data: {
          return: returnResult.rows[0],
          items: itemsResult.rows,
          refunds: refundsResult.rows,
          stockMovements: stockMovementsResult.rows,
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

// ======================================================
// POST /api/returns
// الهدف:
// إنشاء مرتجع جديد
//
// المرتجع يعمل 4 حاجات مهمة:
// 1. يسجل return في جدول returns
// 2. يسجل الأصناف في return_items
// 3. يسجل مبلغ الفلوس المرجعة في return_refunds
// 4. يزود المخزون في stock_balances ويسجل stock_movements
//
// ملاحظة مهمة:
// لو بعت originalSaleItemId، هنمنع ترجيع كمية أكبر من المباعة
// ======================================================
returnsRouter.post('/api/returns', async (req, res, next) => {
  const auth = getAuthContext(res)
  const client = await db.connect()

  try {
    const {
      originalSaleId,
      returnNumber,
      source,
      idempotencyKey,
      reason,
      items,
      refunds,
    } = req.body

    // الشركة والفرع والمستخدم من Session فقط.
    const companyId = auth.companyId
    const authenticatedBranchId = auth.branchId

    const normalizedOriginalSaleId =
      typeof originalSaleId === 'string'
        ? originalSaleId.trim().toLowerCase()
        : ''

    if (!uuidPattern.test(normalizedOriginalSaleId)) {
      return res.status(400).json({
        error: 'originalSaleId is invalid',
      })
    }

    if (!returnNumber || typeof returnNumber !== 'string') {
      return res.status(400).json({ error: 'returnNumber is required' })
    }

    const normalizedIdempotencyKey =
      typeof idempotencyKey === 'string' ? idempotencyKey.trim() : ''

    if (!normalizedIdempotencyKey) {
      return res.status(400).json({
        error: 'idempotencyKey is required',
      })
    }

    if (normalizedIdempotencyKey.length > 200) {
      return res.status(400).json({
        error: 'idempotencyKey is too long',
      })
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items are required' })
    }

    if (!Array.isArray(refunds) || refunds.length === 0) {
      return res.status(400).json({ error: 'refunds are required' })
    }

    const existingReturn = await loadReturnByIdempotency(
      auth.companyId,
      normalizedIdempotencyKey,
      auth.branchId,
    )

    if (existingReturn) {
      return res.status(200).json({
        duplicated: true,
        data: existingReturn,
      })
    }

    await client.query('BEGIN')

    // ======================================================
    // استخراج الفرع والمخزن والعميل من الفاتورة الأصلية.
    //
    // لا نثق في أي branchId أو stockLocationId أو customerId
    // قادم من المتصفح.
    // ======================================================
    const originalSaleResult = await client.query(
      `
  SELECT
    s.id,
    s.branch_id,
    s.stock_location_id,
    s.customer_id,
    s.status
  FROM sales s

  JOIN branches b
    ON b.id = s.branch_id
    AND b.company_id = s.company_id
    AND b.is_active = TRUE

  JOIN stock_locations sl
    ON sl.id = s.stock_location_id
    AND sl.company_id = s.company_id
    AND sl.is_active = TRUE

  WHERE s.company_id = $1
    AND s.id = $2
    AND s.status = 'completed'

    -- المستخدم المرتبط بفرع لا يرجع فاتورة فرع آخر.
    AND (
      $3::uuid IS NULL
      OR s.branch_id = $3::uuid
    )

  FOR SHARE OF s;
  `,
      [companyId, normalizedOriginalSaleId, authenticatedBranchId],
    )

    if ((originalSaleResult.rowCount ?? 0) === 0) {
      throw new ReturnsApiError(
        404,
        'Original sale was not found, inactive, or belongs to another branch',
      )
    }

    const trustedOriginalSale = originalSaleResult.rows[0]

    const trustedBranchId = trustedOriginalSale.branch_id

    const trustedStockLocationId = trustedOriginalSale.stock_location_id

    const trustedCustomerId = trustedOriginalSale.customer_id

    // =========================
    // Prepare return items
    // =========================
    // هنا بنجهز الأصناف قبل إنشاء المرتجع
    // عشان نحسب الإجماليات ونتأكد من صحة البيانات
    const preparedItems: any[] = []

    const usedOriginalSaleItemIds = new Set<string>()

    let subtotal = 0

    // ======================================================
    // ترتيب الأصناف قبل قفلها ومعالجتها
    //
    // لو عمليتا مرتجع تعملان في نفس اللحظة على أكثر من صنف،
    // الترتيب الثابت يقلل احتمال حدوث Database Deadlock.
    // ======================================================
    const orderedItems = [...items].sort((firstItem, secondItem) => {
      const firstKey = String(
        firstItem.originalSaleItemId || firstItem.variantId || '',
      )
        .trim()
        .toLowerCase()

      const secondKey = String(
        secondItem.originalSaleItemId || secondItem.variantId || '',
      )
        .trim()
        .toLowerCase()

      return firstKey.localeCompare(secondKey)
    })

    for (const item of orderedItems) {
      const originalSaleItemId =
        typeof item.originalSaleItemId === 'string' &&
        item.originalSaleItemId.trim()
          ? item.originalSaleItemId.trim().toLowerCase()
          : null

      // المرتجعات اليدوية غير المرتبطة بفواتير غير مسموحة حاليًا.
      // ستضاف لاحقًا بصلاحية منفصلة ومراجعة إدارية.
      if (!originalSaleItemId) {
        throw new ReturnsApiError(
          400,
          'originalSaleItemId is required. Manual returns are not supported',
        )
      }

      if (!uuidPattern.test(originalSaleItemId)) {
        throw new ReturnsApiError(400, 'originalSaleItemId is invalid', {
          originalSaleItemId,
        })
      }

      if (usedOriginalSaleItemIds.has(originalSaleItemId)) {
        throw new ReturnsApiError(
          400,
          'The same original sale item cannot be repeated in one return',
          {
            originalSaleItemId,
          },
        )
      }

      usedOriginalSaleItemIds.add(originalSaleItemId)
      const variantId =
        typeof item.variantId === 'string'
          ? item.variantId.trim().toLowerCase()
          : ''

      const quantity = Number(item.quantity)
      const unitPrice = Number(item.unitPrice)
      const refundAmount = Number(item.refundAmount)

      if (!uuidPattern.test(variantId)) {
        throw new ReturnsApiError(
          400,
          'variantId is invalid for a return item',
          {
            variantId: variantId || null,
          },
        )
      }

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new ReturnsApiError(400, 'quantity must be greater than zero')
      }

      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new ReturnsApiError(400, 'unitPrice must be zero or greater')
      }

      if (!Number.isFinite(refundAmount) || refundAmount < 0) {
        throw new ReturnsApiError(400, 'refundAmount must be zero or greater')
      }

      // ======================================================
      // الحالة الأفضل:
      // لو عندنا originalSaleItemId
      // نجيب بيانات الصنف من الفاتورة الأصلية
      // ونمنع ترجيع كمية أكبر من المباعة
      // ======================================================
      if (originalSaleItemId) {
        const saleItemResult = await client.query(
          `
          SELECT
            si.id,
            si.sale_id,
            si.variant_id,
            si.sku_snapshot,
            si.barcode_snapshot,
            si.product_name_snapshot,
            si.size_snapshot,
            si.color_snapshot,
            si.quantity AS sold_quantity,
            si.unit_price,

            -- إجمالي السطر النهائي بعد خصم وضريبة الصنف
            -- نستخدمه لحساب المبلغ الحقيقي المستحق للمرتجع
            si.line_total,

            s.customer_id
          FROM sale_items si
          JOIN sales s ON s.id = si.sale_id
          WHERE si.company_id = $1
            AND si.id = $2
            AND si.variant_id = $3
            AND si.sale_id = $4

          -- ==================================================
          -- نقفل سطر الفاتورة حتى نهاية Transaction.
          --
          -- لو طلبا مرتجع وصلا في نفس الوقت لنفس الصنف:
          -- الطلب الثاني ينتظر الأول، ثم يعيد حساب الكمية
          -- المرتجعة سابقًا قبل السماح بإنشاء المرتجع.
          -- ==================================================
          FOR UPDATE OF si;
          `,
          [companyId, originalSaleItemId, variantId, normalizedOriginalSaleId],
        )

        if ((saleItemResult.rowCount ?? 0) === 0) {
          throw new ReturnsApiError(404, 'Original sale item was not found')
        }

        const saleItem = saleItemResult.rows[0]

        // نجمع الكميات اللي اترجعت قبل كده لنفس sale item
        const alreadyReturnedResult = await client.query(
          `
          SELECT
            COALESCE(
              SUM(
                consumed_items.quantity
              ),
              0
            ) AS returned_quantity

          FROM (
            SELECT
              ri.quantity

            FROM return_items ri

            JOIN returns r
              ON r.id = ri.return_id
              AND r.company_id =
                  ri.company_id

            WHERE ri.company_id = $1

              AND ri.original_sale_item_id =
                  $2

              AND r.status IN (
                'completed',
                'pending_review'
              )

            UNION ALL

            SELECT
              eri.quantity

            FROM exchange_return_items eri

            JOIN exchanges e
              ON e.id = eri.exchange_id
              AND e.company_id =
                  eri.company_id

            WHERE eri.company_id = $1

              AND eri.original_sale_item_id =
                  $2

              AND e.status IN (
                'completed',
                'pending_review'
              )
          ) consumed_items;
          `,
          [companyId, originalSaleItemId],
        )

        const soldQuantity = Number(saleItem.sold_quantity)
        const alreadyReturnedQuantity = Number(
          alreadyReturnedResult.rows[0].returned_quantity,
        )
        const remainingReturnableQuantity =
          soldQuantity - alreadyReturnedQuantity

        // ممنوع ترجع أكتر من الكمية المتبقية من الفاتورة الأصلية
        if (quantity > remainingReturnableQuantity) {
          throw new ReturnsApiError(
            400,
            `Return quantity is greater than remaining returnable quantity. Sold: ${soldQuantity}, Already returned: ${alreadyReturnedQuantity}, Requested: ${quantity}`,
          )
        }

        // ======================================================
        // حساب قيمة المرتجع من بيانات الفاتورة الأصلية
        //
        // لا نثق في unitPrice أو refundAmount المرسلين من Frontend.
        //
        // مثال:
        // تم بيع قطعتين وإجمالي السطر بعد الخصم = 180
        // إذن صافي قيمة القطعة الواحدة = 90
        // عند إرجاع قطعة واحدة يكون المرتجع = 90
        // ======================================================
        const originalUnitPrice = Number(saleItem.unit_price)
        const originalLineTotal = Number(saleItem.line_total)

        if (!Number.isFinite(originalLineTotal) || originalLineTotal < 0) {
          throw new ReturnsApiError(
            400,
            'Original sale item line total is invalid',
          )
        }

        const refundableUnitAmount =
          soldQuantity > 0 ? originalLineTotal / soldQuantity : 0

        // نثبت المبلغ على منزلتين عشريتين لمنع مشاكل الكسور
        const calculatedRefundAmount = Number(
          (refundableUnitAmount * quantity).toFixed(2),
        )

        subtotal += calculatedRefundAmount

        preparedItems.push({
          originalSaleItemId,
          variantId,
          quantity,

          // نحفظ سعر الوحدة الأصلي للمعلومة والتقارير
          unitPrice: originalUnitPrice,

          // المبلغ الفعلي محسوب من Backend
          refundAmount: calculatedRefundAmount,

          reason: item.reason || null,
          skuSnapshot: saleItem.sku_snapshot,
          barcodeSnapshot: saleItem.barcode_snapshot,
          productNameSnapshot: saleItem.product_name_snapshot,
          sizeSnapshot: saleItem.size_snapshot,
          colorSnapshot: saleItem.color_snapshot,
        })

        continue
      }

      // ======================================================
      // الحالة الثانية:
      // مفيش originalSaleItemId
      // يبقى نجيب بيانات الصنف من product_variants
      // دي تصلح لمرتجع يدوي، لكن بعدين هنقيدها بصلاحيات
      // ======================================================
      const variantResult = await client.query(
        `
        SELECT
          pv.id,
          pv.sku,
          pv.primary_barcode,
          p.name AS product_name,
          fs.name AS size_name,
          fc.name AS color_name
        FROM product_variants pv
        JOIN products p ON p.id = pv.product_id
        LEFT JOIN fashion_sizes fs ON fs.id = pv.size_id
        LEFT JOIN fashion_colors fc ON fc.id = pv.color_id
        WHERE pv.company_id = $1
          AND pv.id = $2
          AND pv.status = 'active';
        `,
        [companyId, variantId],
      )

      if ((variantResult.rowCount ?? 0) === 0) {
        throw new ReturnsApiError(
          404,
          `Variant not found or inactive: ${variantId}`,
        )
      }

      const variant = variantResult.rows[0]

      subtotal += refundAmount

      preparedItems.push({
        originalSaleItemId: null,
        variantId,
        quantity,
        unitPrice,
        refundAmount,
        reason: item.reason || null,
        skuSnapshot: variant.sku,
        barcodeSnapshot: variant.primary_barcode,
        productNameSnapshot: variant.product_name,
        sizeSnapshot: variant.size_name,
        colorSnapshot: variant.color_name,
      })
    }

    // ======================================================
    // حساب إجمالي طرق رد المبلغ
    // ======================================================
    const refundTotal = Number(
      refunds
        .reduce((sum: number, refund: any) => {
          return sum + Number(refund.amount || 0)
        }, 0)
        .toFixed(2),
    )

    // نثبت إجمالي الأصناف المرتجعة على منزلتين عشريتين
    subtotal = Number(subtotal.toFixed(2))

    if (!Number.isFinite(refundTotal) || refundTotal <= 0) {
      throw new ReturnsApiError(400, 'refundTotal must be greater than zero')
    }

    // ======================================================
    // لازم إجمالي الفلوس التي سيتم ردها يساوي
    // إجمالي قيمة الأصناف المرتجعة.
    //
    // نسمح بفارق قرش واحد فقط بسبب تقريب الكسور.
    // ======================================================
    if (Math.abs(refundTotal - subtotal) > 0.01) {
      throw new ReturnsApiError(
        400,
        `Refund total does not match return items total. Items total: ${subtotal}, Refund total: ${refundTotal}`,
      )
    }

    // =========================
    // Create return header
    // =========================
    const returnResult = await client.query(
      `
      INSERT INTO returns (
        company_id,
        branch_id,
        stock_location_id,
        customer_id,
        original_sale_id,
        return_number,
        source,
        idempotency_key,
        subtotal,
        refund_total,
        status,
        reason,
        created_by,
        synced_at
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8,
        $9, $10,
        'completed',
        $11, $12,
        CASE WHEN $7 = 'offline_pos' THEN NOW() ELSE NULL END
      )
      RETURNING *;
      `,
      [
        companyId,
        trustedBranchId,
        trustedStockLocationId,
        trustedCustomerId,
        normalizedOriginalSaleId,
        returnNumber.trim(),
        source || 'online_pos',
        normalizedIdempotencyKey,
        subtotal,
        refundTotal,
        reason || null,
        auth.userId,
      ],
    )

    const createdReturn = returnResult.rows[0]
    const createdItems: any[] = []

    // =========================
    // Insert return items + increase stock
    // =========================
    for (const item of preparedItems) {
      // نسجل الصنف داخل return_items
      const returnItemResult = await client.query(
        `
        INSERT INTO return_items (
          company_id,
          return_id,
          original_sale_item_id,
          variant_id,
          sku_snapshot,
          barcode_snapshot,
          product_name_snapshot,
          size_snapshot,
          color_snapshot,
          quantity,
          unit_price,
          refund_amount,
          reason
        )
        VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8, $9,
          $10, $11, $12, $13
        )
        RETURNING *;
        `,
        [
          companyId,
          createdReturn.id,
          item.originalSaleItemId,
          item.variantId,
          item.skuSnapshot,
          item.barcodeSnapshot,
          item.productNameSnapshot,
          item.sizeSnapshot,
          item.colorSnapshot,
          item.quantity,
          item.unitPrice,
          item.refundAmount,
          item.reason,
        ],
      )

      createdItems.push(returnItemResult.rows[0])

      // نضمن إن فيه صف للمخزون
      // لو الصنف مش موجود في stock_balances نعمله بكمية صفر
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
        ON CONFLICT (company_id, stock_location_id, variant_id) DO NOTHING;
        `,
        [companyId, trustedBranchId, trustedStockLocationId, item.variantId],
      )

      // نقفل صف المخزون FOR UPDATE
      // عشان لو عمليتين حصلوا في نفس الوقت، الكمية ما تلخبطش
      const balanceResult = await client.query(
        `
        SELECT quantity
        FROM stock_balances
        WHERE company_id = $1
          AND stock_location_id = $2
          AND variant_id = $3
        FOR UPDATE;
        `,
        [companyId, trustedStockLocationId, item.variantId],
      )

      const quantityBefore = Number(balanceResult.rows[0].quantity)
      const quantityAfter = quantityBefore + item.quantity

      // نزوّد المخزون لأن ده مرتجع
      await client.query(
        `
        UPDATE stock_balances
        SET quantity = $1,
            branch_id = $2,
            updated_at = NOW()
        WHERE company_id = $3
          AND stock_location_id = $4
          AND variant_id = $5;
        `,
        [
          quantityAfter,
          trustedBranchId,
          companyId,
          trustedStockLocationId,
          item.variantId,
        ],
      )

      // نسجل حركة مخزون return
      // quantity هنا موجبة لأن المخزون زاد
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
          'return',
          $5, $6, $7,
          'return',
          $8,
          $9,
          $10
        );
        `,
        [
          companyId,
          trustedBranchId,
          trustedStockLocationId,
          item.variantId,
          item.quantity,
          quantityBefore,
          quantityAfter,
          createdReturn.id,
          `Return ${createdReturn.return_number}`,
          auth.userId,
        ],
      )
    }

    // =========================
    // Insert refunds
    // =========================
    const createdRefunds: any[] = []

    for (const refund of refunds) {
      const method = refund.method
      const amount = Number(refund.amount)

      if (typeof method !== 'string' || !allowedRefundMethods.has(method)) {
        throw new ReturnsApiError(
          400,
          `Unsupported refund method: ${String(method)}`,
        )
      }

      if (!Number.isFinite(amount) || amount <= 0) {
        throw new ReturnsApiError(
          400,
          'Refund amount must be greater than zero',
        )
      }

      const refundResult = await client.query(
        `
        INSERT INTO return_refunds (
          company_id,
          return_id,
          method,
          amount,
          reference
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *;
        `,
        [companyId, createdReturn.id, method, amount, refund.reference || null],
      )

      createdRefunds.push(refundResult.rows[0])
    }

    await client.query('COMMIT')

    res.status(201).json({
      data: {
        return: createdReturn,
        items: createdItems,
        refunds: createdRefunds,
      },
    })
  } catch (error) {
    // لو حصل أي خطأ، نلغي كل حاجة حصلت جوه transaction
    await client.query('ROLLBACK').catch(() => {})

    // طلبان متزامنان بنفس Idempotency Key.
    if (isPostgresUniqueViolation(error)) {
      const requestBody =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {}

      const auth = getAuthContext(res)

      const requestIdempotencyKey =
        typeof requestBody.idempotencyKey === 'string'
          ? requestBody.idempotencyKey.trim()
          : ''

      if (requestIdempotencyKey) {
        const existingReturn = await loadReturnByIdempotency(
          auth.companyId,
          requestIdempotencyKey,
          auth.branchId,
        )

        if (existingReturn) {
          return res.status(200).json({
            duplicated: true,
            data: existingReturn,
          })
        }
      }
    }

    // أخطاء المرتجعات المتوقعة ترجع برسالة واضحة
    if (error instanceof ReturnsApiError) {
      return res.status(error.statusCode).json({
        error: error.message,

        ...(error.details
          ? {
              details: error.details,
            }
          : {}),
      })
    }

    return next(error)
  } finally {
    client.release()
  }
})

// ======================================================
// POST /api/returns/:returnId/void
//
// Body:
// {
//   reason: string,
//   collectionReference?: string
// }
//
// الإلغاء يعكس:
// 1. الزيادة التي حدثت في المخزون.
// 2. المبلغ الذي تم رده للعميل.
// 3. حالة المرتجع.
// 4. ويسجل Audit Log.
// ======================================================
returnsRouter.post(
  '/api/returns/:returnId/void',

  async (req, res, next) => {
    const client = await db.connect()

    let transactionStarted = false

    try {
      const auth = getAuthContext(res)

      const returnId = normalizeParam(req.params.returnId)

      if (typeof returnId !== 'string' || !uuidPattern.test(returnId)) {
        throw new ReturnsApiError(400, 'returnId is invalid')
      }

      const reason =
        typeof req.body?.reason === 'string'
          ? req.body.reason.trim().slice(0, 500)
          : ''

      if (reason.length < 3) {
        throw new ReturnsApiError(
          400,
          'Void reason must contain at least 3 characters',
        )
      }

      const collectionReference =
        typeof req.body?.collectionReference === 'string' &&
        req.body.collectionReference.trim()
          ? req.body.collectionReference.trim().slice(0, 120)
          : null

      await client.query('BEGIN')

      transactionStarted = true

      // ==================================================
      // Lock return header
      // ==================================================
      const returnResult = await client.query(
        `
          SELECT *

          FROM returns

          WHERE company_id = $1
            AND id = $2

            AND (
              $3::uuid IS NULL
              OR branch_id =
                 $3::uuid
            )

          FOR UPDATE;
          `,
        [auth.companyId, returnId, auth.branchId],
      )

      if ((returnResult.rowCount ?? 0) === 0) {
        throw new ReturnsApiError(
          404,
          'Return was not found or belongs to another branch',
        )
      }

      const returnDocument = returnResult.rows[0]

      if (returnDocument.status === 'voided') {
        await client.query('COMMIT')

        transactionStarted = false

        return res.json({
          alreadyVoided: true,

          data: {
            return: returnDocument,

            stockReversalIds: [],

            refundReversalIds: [],
          },
        })
      }

      if (returnDocument.status !== 'completed') {
        throw new ReturnsApiError(409, 'Only completed returns can be voided')
      }

      // ==================================================
      // Original return stock movements
      // ==================================================
      const originalMovementsResult = await client.query(
        `
          SELECT
            id,
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
            created_at

          FROM stock_movements

          WHERE company_id = $1

            AND reference_type =
                'return'

            AND reference_id = $2

            AND movement_type =
                'return'

            AND reversal_of_movement_id
                IS NULL

          ORDER BY
            created_at DESC,
            id DESC

          FOR UPDATE;
          `,
        [auth.companyId, returnId],
      )

      const expectedMovementsResult = await client.query(
        `
          SELECT COUNT(*)::int
            AS expected_count

          FROM return_items

          WHERE company_id = $1
            AND return_id = $2;
          `,
        [auth.companyId, returnId],
      )

      const expectedMovementCount = Number(
        expectedMovementsResult.rows[0].expected_count,
      )

      const originalMovements = originalMovementsResult.rows

      if (
        originalMovements.length === 0 ||
        originalMovements.length !== expectedMovementCount
      ) {
        throw new ReturnsApiError(
          409,
          'Return stock movement history is incomplete and cannot be reversed safely',
          {
            expectedMovementCount,

            actualMovementCount: originalMovements.length,
          },
        )
      }

      const originalMovementIds = originalMovements.map((movement) =>
        String(movement.id),
      )

      const existingStockReversalsResult = await client.query(
        `
          SELECT COUNT(*)::int
            AS reversal_count

          FROM stock_movements

          WHERE company_id = $1

            AND reversal_of_movement_id =
                ANY($2::uuid[]);
          `,
        [auth.companyId, originalMovementIds],
      )

      if (Number(existingStockReversalsResult.rows[0].reversal_count) > 0) {
        throw new ReturnsApiError(
          409,
          'Return already contains stock reversal movements',
        )
      }

      // ==================================================
      // Original refunds
      // ==================================================
      const originalRefundsResult = await client.query(
        `
          SELECT *

          FROM return_refunds

          WHERE company_id = $1
            AND return_id = $2

            AND refund_role =
                'refund'

          ORDER BY
            created_at ASC,
            id ASC

          FOR UPDATE;
          `,
        [auth.companyId, returnId],
      )

      if ((originalRefundsResult.rowCount ?? 0) === 0) {
        throw new ReturnsApiError(
          409,
          'Return refund history is missing and cannot be reversed safely',
        )
      }

      const originalRefundTotal = roundMoney(
        originalRefundsResult.rows.reduce(
          (total, refund) => total + Number(refund.amount),

          0,
        ),
      )

      if (
        Math.abs(originalRefundTotal - Number(returnDocument.refund_total)) >
        0.01
      ) {
        throw new ReturnsApiError(
          409,
          'Return refund history does not match the return total',
          {
            expectedRefundTotal: returnDocument.refund_total,

            actualRefundTotal: originalRefundTotal,
          },
        )
      }

      const existingRefundReversalsResult = await client.query(
        `
          SELECT COUNT(*)::int
            AS reversal_count

          FROM return_refunds

          WHERE company_id = $1
            AND return_id = $2

            AND refund_role =
                'void_reversal';
          `,
        [auth.companyId, returnId],
      )

      if (Number(existingRefundReversalsResult.rows[0].reversal_count) > 0) {
        throw new ReturnsApiError(
          409,
          'Return already contains refund reversal records',
        )
      }

      // ==================================================
      // Lock affected stock balances
      // ==================================================
      const variantIds = [
        ...new Set(
          originalMovements.map((movement) => String(movement.variant_id)),
        ),
      ].sort()

      for (const variantId of variantIds) {
        await client.query(
          `
          INSERT INTO stock_balances (
            company_id,
            branch_id,
            stock_location_id,
            variant_id,
            quantity
          )
          VALUES (
            $1, $2, $3, $4, 0
          )

          ON CONFLICT (
            company_id,
            stock_location_id,
            variant_id
          )
          DO NOTHING;
          `,
          [
            auth.companyId,
            returnDocument.branch_id,
            returnDocument.stock_location_id,
            variantId,
          ],
        )
      }

      const balancesResult = await client.query(
        `
          SELECT
            variant_id,
            quantity

          FROM stock_balances

          WHERE company_id = $1

            AND stock_location_id =
                $2

            AND variant_id =
                ANY($3::uuid[])

          ORDER BY
            variant_id ASC

          FOR UPDATE;
          `,
        [auth.companyId, returnDocument.stock_location_id, variantIds],
      )

      const runningBalances = new Map<string, number>(
        balancesResult.rows.map((balance) => [
          String(balance.variant_id),

          Number(balance.quantity),
        ]),
      )

      // ==================================================
      // Calculate final balances before modification
      // ==================================================
      const reversalByVariant = new Map<string, number>()

      for (const movement of originalMovements) {
        const variantId = String(movement.variant_id)

        const originalQuantity = Number(movement.quantity)

        if (!Number.isFinite(originalQuantity) || originalQuantity <= 0) {
          throw new ReturnsApiError(
            409,
            'Return contains an invalid original stock movement',
            {
              movementId: movement.id,

              quantity: movement.quantity,
            },
          )
        }

        const reversalQuantity = roundQuantity(-originalQuantity)

        reversalByVariant.set(
          variantId,

          roundQuantity(
            (reversalByVariant.get(variantId) ?? 0) + reversalQuantity,
          ),
        )
      }

      const shortages = variantIds
        .map((variantId) => {
          const currentQuantity = runningBalances.get(variantId) ?? 0

          const reversalQuantity = reversalByVariant.get(variantId) ?? 0

          const finalQuantity = roundQuantity(
            currentQuantity + reversalQuantity,
          )

          return {
            variantId,
            currentQuantity,
            reversalQuantity,
            finalQuantity,
          }
        })
        .filter((item) => item.finalQuantity < 0)

      if (shortages.length > 0) {
        throw new ReturnsApiError(
          409,
          'Stock is insufficient to void this return safely',
          {
            shortages,
          },
        )
      }

      // ==================================================
      // Reverse stock movements
      // ==================================================
      const createdStockReversalIds: string[] = []

      for (const originalMovement of originalMovements) {
        const variantId = String(originalMovement.variant_id)

        const quantityBefore = runningBalances.get(variantId) ?? 0

        const reversalQuantity = roundQuantity(
          -Number(originalMovement.quantity),
        )

        const quantityAfter = roundQuantity(quantityBefore + reversalQuantity)

        await client.query(
          `
          UPDATE stock_balances

          SET
            quantity = $1,
            branch_id = $2,
            updated_at = NOW()

          WHERE company_id = $3

            AND stock_location_id =
                $4

            AND variant_id = $5;
          `,
          [
            quantityAfter,
            returnDocument.branch_id,
            auth.companyId,
            returnDocument.stock_location_id,
            variantId,
          ],
        )

        const reversalResult = await client.query(
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

              reversal_of_movement_id,

              note,
              created_by
            )
            VALUES (
              $1, $2, $3, $4,
              'return',
              $5, $6, $7,
              'return',
              $8,
              $9,
              $10,
              $11
            )

            RETURNING id;
            `,
          [
            auth.companyId,
            returnDocument.branch_id,
            returnDocument.stock_location_id,
            variantId,

            reversalQuantity,
            quantityBefore,
            quantityAfter,

            returnId,

            originalMovement.id,

            `Void reversal for return ${returnDocument.return_number}`,

            auth.userId,
          ],
        )

        createdStockReversalIds.push(reversalResult.rows[0].id)

        runningBalances.set(variantId, quantityAfter)
      }

      // ==================================================
      // Reverse refunds
      //
      // المرتجع الأصلي رد مبلغ للعميل.
      // الإلغاء يسجل أن المبلغ أصبح مطلوبًا من العميل.
      // ==================================================
      const createdRefundReversalIds: string[] = []

      for (const originalRefund of originalRefundsResult.rows) {
        const originalReference =
          typeof originalRefund.reference === 'string' &&
          originalRefund.reference.trim()
            ? originalRefund.reference.trim()
            : null

        const combinedReference = [
          `Void ${returnDocument.return_number}`,

          collectionReference,

          originalReference ? `Original: ${originalReference}` : null,
        ]
          .filter(Boolean)
          .join(' | ')
          .slice(0, 200)

        const reversalResult = await client.query(
          `
            INSERT INTO return_refunds (
              company_id,
              return_id,

              method,
              amount,
              reference,

              refund_role,
              payment_direction,
              reverses_refund_id
            )
            VALUES (
              $1, $2,
              $3, $4, $5,
              'void_reversal',
              'collected_from_customer',
              $6
            )

            RETURNING id;
            `,
          [
            auth.companyId,
            returnId,

            originalRefund.method,
            originalRefund.amount,
            combinedReference || null,

            originalRefund.id,
          ],
        )

        createdRefundReversalIds.push(reversalResult.rows[0].id)
      }

      // ==================================================
      // Mark return as voided
      // ==================================================
      const voidedReturnResult = await client.query(
        `
          UPDATE returns

          SET
            status = 'voided',
            void_reason = $1,
            voided_by = $2,
            voided_at = NOW()

          WHERE company_id = $3
            AND id = $4

          RETURNING *;
          `,
        [reason, auth.userId, auth.companyId, returnId],
      )

      // ==================================================
      // Audit log
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
          $1, $2, $3,
          'return.void',
          'return',
          $4,
          $5::jsonb,
          $6::jsonb,
          $7,
          $8
        );
        `,
        [
          auth.companyId,
          returnDocument.branch_id,
          auth.userId,

          returnId,

          JSON.stringify({
            status: returnDocument.status,

            subtotal: returnDocument.subtotal,

            refundTotal: returnDocument.refund_total,
          }),

          JSON.stringify({
            status: 'voided',

            reason,

            stockReversalIds: createdStockReversalIds,

            refundReversalIds: createdRefundReversalIds,
          }),

          req.ip || null,

          req.get('user-agent') || null,
        ],
      )

      await client.query('COMMIT')

      transactionStarted = false

      return res.json({
        alreadyVoided: false,

        data: {
          return: voidedReturnResult.rows[0],

          stockReversalIds: createdStockReversalIds,

          refundReversalIds: createdRefundReversalIds,
        },
      })
    } catch (error) {
      if (transactionStarted) {
        await client.query('ROLLBACK').catch(() => {})

        transactionStarted = false
      }

      if (error instanceof ReturnsApiError) {
        return res.status(error.statusCode).json({
          error: error.message,

          ...(error.details
            ? {
                details: error.details,
              }
            : {}),
        })
      }

      return next(error)
    } finally {
      client.release()
    }
  },
)
