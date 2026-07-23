import { Router } from 'express'
import { db } from '../../db/pool'

export const salesRouter = Router()

// ======================================================
// SalesApiError
// ده Error مخصص للـ Sales API
//
// ليه عملناه؟
// بدل ما أي مشكلة ترجع 500 Internal Server Error
// نقدر نرجع status واضح زي 400 مع رسالة مفهومة
//
// مثال:
// لو المخزون غير كافي نرجع 400
// ======================================================
class SalesApiError extends Error {
  statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

// ======================================================
// roundMoney
//
// يمنع ظهور كسور طويلة في العمليات المالية.
// كل المبالغ المالية تُحفظ بمنزلتين عشريتين.
// ======================================================
function roundMoney(value: number) {
  return Number(value.toFixed(2))
}

// طرق الدفع التي يدعمها النظام حاليًا.
// التحقق هنا يمنع وصول قيمة غير صحيحة إلى PostgreSQL.
const allowedPaymentMethods = new Set([
  'cash',
  'card',
  'wallet',
  'bank_transfer',
  'mixed',
  'other',
])

// ======================================================
// مصادر البيع المسموح بها
//
// أي قيمة أخرى يتم رفضها قبل الوصول لقاعدة البيانات.
// ======================================================
const allowedSaleSources = new Set(['online_pos', 'offline_pos', 'web_admin'])

// ======================================================
// UUID validation
//
// يمنع إرسال IDs غير صالحة إلى PostgreSQL
// وبالتالي يرجع خطأ 400 مفهوم بدل Database Error.
// ======================================================
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isValidUuid(value: string) {
  return uuidPattern.test(value)
}

// ======================================================
// PostgreSQL Unique Violation
//
// الكود 23505 يعني أن Unique Constraint منعت
// إنشاء سجل مكرر.
// ======================================================
function isPostgresUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  )
}

// ======================================================
// GET /api/sales
// الهدف: عرض قائمة الفواتير المحفوظة
// مثال:
// /api/sales?companyId=xxx
// /api/sales?companyId=xxx&branchId=yyy
// ======================================================
salesRouter.get('/api/sales', async (req, res, next) => {
  try {
    // companyId مهم جدًا عشان نجيب فواتير الشركة الحالية فقط
    // ده جزء من فكرة multi-tenant مستقبلاً
    const companyId = req.query.companyId

    // branchId اختياري
    // لو اتبعت، نجيب فواتير فرع محدد
    // لو ما اتبعتش، نجيب فواتير كل الفروع داخل نفس الشركة
    const branchId = req.query.branchId

    // limit اختياري عشان ما نرجعش عدد ضخم من الفواتير مرة واحدة
    // لو المستخدم ما بعتوش نخليه 50
    const limit = Math.min(Number(req.query.limit || 50), 100)

    // Validation بسيط للتأكد إن companyId موجود وصحيح كنص
    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res
        .status(400)
        .json({ error: 'companyId query parameter is required' })
    }

    // ======================================================
    // تحميل الفواتير مع حالة المرتجعات
    //
    // لكل فاتورة نرجع:
    // 1. عدد سطور الأصناف
    // 2. إجمالي الكمية المباعة
    // 3. إجمالي الكمية المرتجعة سابقًا
    // 4. الكمية المتبقية التي يمكن إرجاعها
    // ======================================================
    const result = await db.query(
      `
      SELECT
        s.id,
        s.company_id,
        s.branch_id,
        b.name AS branch_name,
        s.stock_location_id,
        sl.name AS stock_location_name,
        s.customer_id,
        c.name AS customer_name,
        s.sale_number,
        s.source,
        s.local_sale_id,
        s.subtotal,
        s.discount_total,
        s.tax_total,
        s.total,
        s.paid_total,
        s.change_total,
        s.status,

        -- وقت حدوث البيع الحقيقي.
        -- في البيع Offline قد يسبق وقت المزامنة بساعات.
        s.occurred_at,
        s.created_at,
        s.synced_at,

        -- عدد سطور الأصناف داخل الفاتورة
        COUNT(si.id)::int AS items_count,

        -- إجمالي عدد القطع المباعة
        COALESCE(
          SUM(si.quantity),
          0
        ) AS sold_quantity,

        -- إجمالي عدد القطع التي تم إرجاعها سابقًا
        COALESCE(
          returned_items.returned_quantity,
          0
        ) AS returned_quantity,

        -- الكمية التي ما زال يمكن إرجاعها
        GREATEST(
          COALESCE(SUM(si.quantity), 0) -
          COALESCE(returned_items.returned_quantity, 0),
          0
        ) AS remaining_returnable_quantity

      FROM sales s

      JOIN branches b
        ON b.id = s.branch_id

      JOIN stock_locations sl
        ON sl.id = s.stock_location_id

      LEFT JOIN customers c
        ON c.id = s.customer_id

      LEFT JOIN sale_items si
        ON si.sale_id = s.id

      -- نجمع كل الكميات التي خرجت من قابلية
      -- الإرجاع، سواء عن طريق مرتجع أو استبدال.
      --
      -- العمليات الملغاة لا تؤثر على الكمية.
      LEFT JOIN (
        SELECT
          consumed_items.sale_id,

          SUM(
            consumed_items.quantity
          ) AS returned_quantity

        FROM (
          SELECT
            original_sale_items.sale_id,
            ri.quantity

          FROM return_items ri

          JOIN returns r
            ON r.id = ri.return_id
            AND r.company_id =
                ri.company_id

          JOIN sale_items
            original_sale_items
            ON original_sale_items.id =
              ri.original_sale_item_id
            AND original_sale_items.company_id =
                ri.company_id

          WHERE ri.company_id = $1

            AND ri.original_sale_item_id
                IS NOT NULL

            AND r.status IN (
              'completed',
              'pending_review'
            )

          UNION ALL

          SELECT
            original_sale_items.sale_id,
            eri.quantity

          FROM exchange_return_items eri

          JOIN exchanges e
            ON e.id = eri.exchange_id
            AND e.company_id =
                eri.company_id

          JOIN sale_items
            original_sale_items
            ON original_sale_items.id =
              eri.original_sale_item_id
            AND original_sale_items.company_id =
                eri.company_id

          WHERE eri.company_id = $1

            AND eri.original_sale_item_id
                IS NOT NULL

            AND e.status IN (
              'completed',
              'pending_review'
            )
        ) consumed_items

        GROUP BY
          consumed_items.sale_id
      ) returned_items
        ON returned_items.sale_id =
          s.id

      WHERE s.company_id = $1
        AND ($2::uuid IS NULL OR s.branch_id = $2::uuid)

      GROUP BY
        s.id,
        b.name,
        sl.name,
        c.name,
        returned_items.returned_quantity

      ORDER BY
        s.occurred_at DESC,
        s.created_at DESC
      LIMIT $3;
      `,
      [
        companyId,
        typeof branchId === 'string' && branchId.trim() ? branchId : null,
        limit,
      ],
    )

    res.json({ data: result.rows })
  } catch (error) {
    next(error)
  }
})

// ======================================================
// GET /api/sales/:saleId
// الهدف: عرض تفاصيل فاتورة واحدة
// بيرجع:
// 1. بيانات الفاتورة
// 2. الأصناف المباعة
// 3. المدفوعات
// مثال:
// /api/sales/SALE_ID?companyId=xxx
// ======================================================
salesRouter.get('/api/sales/:saleId', async (req, res, next) => {
  try {
    // saleId جاي من الرابط نفسه
    // مثال: /api/sales/123
    const saleId = req.params.saleId

    // companyId جاي من query
    // لازم نستخدمه عشان نضمن إن الفاتورة تابعة للشركة الصح
    const companyId = req.query.companyId

    if (!saleId || typeof saleId !== 'string') {
      return res.status(400).json({ error: 'saleId is required' })
    }

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res
        .status(400)
        .json({ error: 'companyId query parameter is required' })
    }

    // أول Query: نجيب بيانات الفاتورة الرئيسية
    const saleResult = await db.query(
      `
      SELECT
        s.id,
        s.company_id,
        s.branch_id,
        b.name AS branch_name,
        s.stock_location_id,
        sl.name AS stock_location_name,
        s.customer_id,
        c.name AS customer_name,
        s.cashier_id,
        u.full_name AS cashier_name,
        s.sale_number,
        s.source,
        s.local_sale_id,
        s.idempotency_key,
        s.subtotal,
        s.discount_total,
        s.tax_total,
        s.total,
        s.paid_total,
        s.change_total,
        s.status,
        s.occurred_at,
        s.created_at,
        s.synced_at
      FROM sales s
      JOIN branches b ON b.id = s.branch_id
      JOIN stock_locations sl ON sl.id = s.stock_location_id
      LEFT JOIN customers c ON c.id = s.customer_id
      LEFT JOIN users u ON u.id = s.cashier_id
      WHERE s.company_id = $1
        AND s.id = $2;
      `,
      [companyId, saleId],
    )

    // لو مفيش فاتورة بنفس ID داخل نفس الشركة، نرجع 404
    if ((saleResult.rowCount ?? 0) === 0) {
      return res.status(404).json({ error: 'Sale was not found' })
    }

    // ======================================================
    // تاني Query: نجيب أصناف الفاتورة
    //
    // مع كل صنف بنرجع:
    // 1. الكمية المباعة الأصلية
    // 2. الكمية التي تم إرجاعها سابقًا
    // 3. الكمية المتبقية المسموح بإرجاعها
    //
    // الهدف:
    // شاشة New Return تمنع المستخدم من اختيار كمية
    // أكبر من الكمية المتبقية فعلًا.
    // ======================================================
    const itemsResult = await db.query(
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

        -- الكمية التي تم بيعها داخل الفاتورة الأصلية
        si.quantity,

        -- إجمالي الكمية التي تم إرجاعها سابقًا من نفس السطر
        COALESCE(
          returned_items.returned_quantity,
          0
        ) AS already_returned_quantity,

        -- الكمية التي ما زال مسموحًا بإرجاعها
        GREATEST(
          si.quantity - COALESCE(
            returned_items.returned_quantity,
            0
          ),
          0
        ) AS remaining_returnable_quantity,

        si.unit_price,
        si.discount_amount,
        si.tax_amount,
        si.line_total,
        si.created_at
      FROM sale_items si

      -- نجمع المرتجعات والاستبدالات السابقة
      -- لنفس سطر الفاتورة.
      LEFT JOIN (
        SELECT
          consumed_items
            .original_sale_item_id,

          SUM(
            consumed_items.quantity
          ) AS returned_quantity

        FROM (
          SELECT
            ri.original_sale_item_id,
            ri.quantity

          FROM return_items ri

          JOIN returns r
            ON r.id = ri.return_id
            AND r.company_id =
                ri.company_id

          WHERE ri.company_id = $1

            AND ri.original_sale_item_id
                IS NOT NULL

            AND r.status IN (
              'completed',
              'pending_review'
            )

          UNION ALL

          SELECT
            eri.original_sale_item_id,
            eri.quantity

          FROM exchange_return_items eri

          JOIN exchanges e
            ON e.id = eri.exchange_id
            AND e.company_id =
                eri.company_id

          WHERE eri.company_id = $1

            AND eri.original_sale_item_id
                IS NOT NULL

            AND e.status IN (
              'completed',
              'pending_review'
            )
        ) consumed_items

        GROUP BY
          consumed_items
            .original_sale_item_id
      ) returned_items
        ON returned_items
            .original_sale_item_id =
          si.id

      WHERE si.company_id = $1
        AND si.sale_id = $2
      ORDER BY si.created_at ASC;
      `,
      [companyId, saleId],
    )

    // تالت Query: نجيب المدفوعات الخاصة بالفاتورة
    const paymentsResult = await db.query(
      `
      SELECT
        id,
        sale_id,
        method,
        amount,
        reference,
        created_at
      FROM payments
      WHERE company_id = $1
        AND sale_id = $2
      ORDER BY created_at ASC;
      `,
      [companyId, saleId],
    )

    // نرجع كل حاجة في Response واحد واضح
    res.json({
      data: {
        sale: saleResult.rows[0],
        items: itemsResult.rows,
        payments: paymentsResult.rows,
      },
    })
  } catch (error) {
    next(error)
  }
})

salesRouter.post('/api/sales', async (req, res, next) => {
  const client = await db.connect()

  try {
    const {
      companyId,
      branchId,
      stockLocationId,
      cashierId,
      shiftId,
      customerId,
      saleNumber,
      source,
      localSaleId,
      idempotencyKey,
      items,
      payments,
    } = req.body

    if (!companyId || typeof companyId !== 'string') {
      return res.status(400).json({ error: 'companyId is required' })
    }

    if (!branchId || typeof branchId !== 'string') {
      return res.status(400).json({ error: 'branchId is required' })
    }

    if (!stockLocationId || typeof stockLocationId !== 'string') {
      return res.status(400).json({ error: 'stockLocationId is required' })
    }

    if (!saleNumber || typeof saleNumber !== 'string') {
      return res.status(400).json({ error: 'saleNumber is required' })
    }

    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      return res.status(400).json({ error: 'idempotencyKey is required' })
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items are required' })
    }

    if (!Array.isArray(payments) || payments.length === 0) {
      return res.status(400).json({ error: 'payments are required' })
    }

    // ======================================================
    // تجهيز القيم الاختيارية
    //
    // لا نمرر undefined أو قيم عشوائية إلى PostgreSQL.
    // ======================================================
    const selectedCustomerId =
      typeof customerId === 'string' && customerId.trim()
        ? customerId.trim()
        : null

    const selectedCashierId =
      typeof cashierId === 'string' && cashierId.trim()
        ? cashierId.trim()
        : null

    const selectedShiftId =
      typeof shiftId === 'string' && shiftId.trim() ? shiftId.trim() : null

    const selectedSource =
      typeof source === 'string' && source.trim() ? source.trim() : 'online_pos'

    // ======================================================
    // فحص صيغة جميع UUIDs
    // ======================================================
    if (!isValidUuid(companyId)) {
      return res.status(400).json({ error: 'companyId is invalid' })
    }

    if (!isValidUuid(branchId)) {
      return res.status(400).json({ error: 'branchId is invalid' })
    }

    if (!isValidUuid(stockLocationId)) {
      return res.status(400).json({
        error: 'stockLocationId is invalid',
      })
    }

    if (selectedCustomerId && !isValidUuid(selectedCustomerId)) {
      return res.status(400).json({
        error: 'customerId is invalid',
      })
    }

    if (selectedCashierId && !isValidUuid(selectedCashierId)) {
      return res.status(400).json({
        error: 'cashierId is invalid',
      })
    }

    if (selectedShiftId && !isValidUuid(selectedShiftId)) {
      return res.status(400).json({
        error: 'shiftId is invalid',
      })
    }

    if (!allowedSaleSources.has(selectedSource)) {
      return res.status(400).json({
        error: `Unsupported sale source: ${selectedSource}`,
      })
    }

    await client.query('BEGIN')

    // ======================================================
    // استرجاع الفاتورة السابقة عند تكرار نفس المفتاح.
    //
    // يجب أن تكون الاستجابة بنفس شكل استجابة الإنشاء العادية:
    // data.sale
    // data.items
    // data.payments
    // ======================================================
    const existingSaleResult = await client.query(
      `
  SELECT *
  FROM sales
  WHERE company_id = $1
    AND idempotency_key = $2
  LIMIT 1;
  `,
      [companyId, idempotencyKey],
    )

    if ((existingSaleResult.rowCount ?? 0) > 0) {
      const existingSale = existingSaleResult.rows[0]

      const existingItemsResult = await client.query(
        `
    SELECT *
    FROM sale_items
    WHERE company_id = $1
      AND sale_id = $2
    ORDER BY created_at ASC;
    `,
        [companyId, existingSale.id],
      )

      const existingPaymentsResult = await client.query(
        `
    SELECT *
    FROM payments
    WHERE company_id = $1
      AND sale_id = $2
    ORDER BY created_at ASC;
    `,
        [companyId, existingSale.id],
      )

      await client.query('COMMIT')

      return res.status(200).json({
        duplicated: true,

        data: {
          sale: existingSale,
          items: existingItemsResult.rows,
          payments: existingPaymentsResult.rows,
        },
      })
    }

    // ======================================================
    // Tenant Validation
    //
    // نتحقق أن كل الكيانات المستخدمة في الفاتورة:
    // - تابعة لنفس الشركة
    // - نشطة
    // - مرتبطة بالفرع الصحيح
    //
    // ده يمنع خلط بيانات شركتين أو فرعين داخل مستند واحد.
    // ======================================================
    const contextValidationResult = await client.query(
      `
      SELECT
        EXISTS (
          SELECT 1
          FROM companies c
          WHERE c.id = $1
            AND c.is_active = TRUE
        ) AS company_is_valid,

        EXISTS (
          SELECT 1
          FROM branches b
          WHERE b.id = $2
            AND b.company_id = $1
            AND b.is_active = TRUE
        ) AS branch_is_valid,

        EXISTS (
          SELECT 1
          FROM stock_locations sl
          WHERE sl.id = $3
            AND sl.company_id = $1
            AND sl.is_active = TRUE

            -- المخزن المركزي ممكن يكون بدون branch_id.
            -- أما مخزن الفرع فلازم يطابق فرع الفاتورة.
            AND (
              sl.branch_id IS NULL
              OR sl.branch_id = $2
            )
        ) AS stock_location_is_valid,

        CASE
          WHEN $4::uuid IS NULL THEN TRUE
          ELSE EXISTS (
            SELECT 1
            FROM customers c
            WHERE c.id = $4
              AND c.company_id = $1
              AND c.is_active = TRUE
          )
        END AS customer_is_valid,

        CASE
          WHEN $5::uuid IS NULL THEN TRUE
          ELSE EXISTS (
            SELECT 1
            FROM users u
            WHERE u.id = $5
              AND u.company_id = $1
              AND u.is_active = TRUE
              AND (
                u.branch_id IS NULL
                OR u.branch_id = $2
              )
          )
        END AS cashier_is_valid,

        CASE
          WHEN $6::uuid IS NULL THEN TRUE
          ELSE EXISTS (
            SELECT 1
            FROM cashier_shifts cs
            WHERE cs.id = $6
              AND cs.company_id = $1
              AND cs.branch_id = $2
              AND cs.status = 'open'

              -- لو cashierId موجود لازم الوردية تخص نفس الكاشير.
              AND (
                $5::uuid IS NULL
                OR cs.cashier_id = $5
              )
          )
        END AS shift_is_valid;
      `,
      [
        companyId,
        branchId,
        stockLocationId,
        selectedCustomerId,
        selectedCashierId,
        selectedShiftId,
      ],
    )

    const contextValidation = contextValidationResult.rows[0]

    if (!contextValidation.company_is_valid) {
      throw new SalesApiError(400, 'Company was not found or inactive')
    }

    if (!contextValidation.branch_is_valid) {
      throw new SalesApiError(
        400,
        'Branch does not belong to company or is inactive',
      )
    }

    if (!contextValidation.stock_location_is_valid) {
      throw new SalesApiError(
        400,
        'Stock location does not belong to company or branch',
      )
    }

    if (!contextValidation.customer_is_valid) {
      throw new SalesApiError(
        400,
        'Customer does not belong to company or is inactive',
      )
    }

    if (!contextValidation.cashier_is_valid) {
      throw new SalesApiError(
        400,
        'Cashier does not belong to company or branch',
      )
    }

    if (!contextValidation.shift_is_valid) {
      throw new SalesApiError(
        400,
        'Shift is invalid, closed, or belongs to another cashier',
      )
    }

    // ======================================================
    // تجهيز الأصناف وحساب الفاتورة
    //
    // قاعدة مهمة:
    // لا نثق في سعر أو خصم أو ضريبة قادمة من Frontend.
    //
    // سعر البيع يتم قراءته من PostgreSQL فقط.
    // الخصومات والضرائب ستتم إضافتها لاحقًا من خلال
    // نظام تسعير وصلاحيات منفصل.
    // ======================================================
    let subtotal = 0

    // الخصم والضريبة مقفولان حاليًا حتى إنشاء
    // نظام صلاحيات وتسعير آمن.
    const finalDiscountTotal = 0
    const finalTaxTotal = 0

    const preparedItems = []

    for (const item of items) {
      const variantId = item.variantId
      const quantity = Number(item.quantity)

      if (!variantId || typeof variantId !== 'string') {
        throw new SalesApiError(400, 'variantId is required for each item')
      }

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new SalesApiError(400, 'quantity must be greater than zero')
      }

      // نقرأ الصنف وسعره الحقيقي من قاعدة البيانات.
      const variantResult = await client.query(
        `
        SELECT
          pv.id,
          pv.sku,
          pv.primary_barcode,
          pv.selling_price,
          p.name AS product_name,
          fs.name AS size_name,
          fc.name AS color_name
        FROM product_variants pv
        JOIN products p
          ON p.id = pv.product_id
        LEFT JOIN fashion_sizes fs
          ON fs.id = pv.size_id
        LEFT JOIN fashion_colors fc
          ON fc.id = pv.color_id
        WHERE pv.company_id = $1
          AND pv.id = $2
          AND pv.status = 'active';
        `,
        [companyId, variantId],
      )

      if ((variantResult.rowCount ?? 0) === 0) {
        throw new SalesApiError(
          404,
          `Variant not found or inactive: ${variantId}`,
        )
      }

      const variant = variantResult.rows[0]

      // سعر البيع الحقيقي من PostgreSQL.
      // أي unitPrice مرسل من الواجهة يتم تجاهله.
      const unitPrice = Number(variant.selling_price)

      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new SalesApiError(
          400,
          `Invalid selling price for variant: ${variantId}`,
        )
      }

      const itemDiscount = 0
      const itemTax = 0
      const lineTotal = roundMoney(quantity * unitPrice)

      subtotal = roundMoney(subtotal + lineTotal)

      preparedItems.push({
        variantId,
        quantity,
        unitPrice,
        discountAmount: itemDiscount,
        taxAmount: itemTax,
        lineTotal,
        skuSnapshot: variant.sku,
        barcodeSnapshot: variant.primary_barcode,
        productNameSnapshot: variant.product_name,
        sizeSnapshot: variant.size_name,
        colorSnapshot: variant.color_name,
      })
    }

    // إجمالي الفاتورة محسوب بالكامل داخل Backend.
    const total = roundMoney(subtotal - finalDiscountTotal + finalTaxTotal)

    // ======================================================
    // تجهيز طرق الدفع قبل إنشاء الفاتورة
    //
    // نتحقق من كل المدفوعات أولًا حتى لا يتم إنشاء
    // Sale Header ببيانات دفع غير صالحة.
    // ======================================================
    const preparedPayments: Array<{
      method: string
      amount: number
      reference: string | null
    }> = []

    for (const payment of payments) {
      const method = payment.method
      const amount = Number(payment.amount)

      if (typeof method !== 'string' || !allowedPaymentMethods.has(method)) {
        throw new SalesApiError(
          400,
          `Unsupported payment method: ${String(method)}`,
        )
      }

      if (!Number.isFinite(amount) || amount <= 0) {
        throw new SalesApiError(400, 'Payment amount must be greater than zero')
      }

      preparedPayments.push({
        method,
        amount: roundMoney(amount),
        reference:
          typeof payment.reference === 'string' && payment.reference.trim()
            ? payment.reference.trim()
            : null,
      })
    }

    const paidTotal = roundMoney(
      preparedPayments.reduce((sum, payment) => {
        return sum + payment.amount
      }, 0),
    )

    // النظام لا يحتوي حاليًا على مبيعات آجلة أو حسابات مدينة،
    // لذلك لا نسمح بحفظ فاتورة ناقصة الدفع.
    if (paidTotal < total) {
      throw new SalesApiError(
        400,
        `Paid total is less than sale total. Sale total: ${total}, Paid total: ${paidTotal}`,
      )
    }

    const changeTotal = roundMoney(Math.max(paidTotal - total, 0))

    const saleResult = await client.query(
      `
      INSERT INTO sales (
        company_id,
        branch_id,
        stock_location_id,
        cashier_id,
        shift_id,
        customer_id,
        sale_number,
        source,
        local_sale_id,
        idempotency_key,
        subtotal,
        discount_total,
        tax_total,
        total,
        paid_total,
        change_total,
        status,
        synced_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16,
        'completed',
        CASE WHEN $8 = 'offline_pos' THEN NOW() ELSE NULL END
      )
      RETURNING *;
      `,
      [
        companyId,
        branchId,
        stockLocationId,
        // القيم دي تم التحقق من الشركة والفرع الخاصين بها.
        selectedCashierId,
        selectedShiftId,
        selectedCustomerId,
        saleNumber.trim(),
        selectedSource,
        localSaleId || null,
        idempotencyKey,
        subtotal,
        finalDiscountTotal,
        finalTaxTotal,
        total,
        paidTotal,
        changeTotal,
      ],
    )

    const sale = saleResult.rows[0]

    const createdItems = []

    for (const item of preparedItems) {
      const saleItemResult = await client.query(
        `
        INSERT INTO sale_items (
          company_id,
          sale_id,
          variant_id,
          sku_snapshot,
          barcode_snapshot,
          product_name_snapshot,
          size_snapshot,
          color_snapshot,
          quantity,
          unit_price,
          discount_amount,
          tax_amount,
          line_total
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13
        )
        RETURNING *;
        `,
        [
          companyId,
          sale.id,
          item.variantId,
          item.skuSnapshot,
          item.barcodeSnapshot,
          item.productNameSnapshot,
          item.sizeSnapshot,
          item.colorSnapshot,
          item.quantity,
          item.unitPrice,
          item.discountAmount,
          item.taxAmount,
          item.lineTotal,
        ],
      )

      createdItems.push(saleItemResult.rows[0])

      const balanceResult = await client.query(
        `
        SELECT quantity
        FROM stock_balances
        WHERE company_id = $1
          AND stock_location_id = $2
          AND variant_id = $3
        FOR UPDATE;
        `,
        [companyId, stockLocationId, item.variantId],
      )

      // الكمية الموجودة حاليًا في المخزون قبل البيع
      // لو مفيش record في stock_balances نعتبر الكمية = 0
      const quantityBefore =
        (balanceResult.rowCount ?? 0) > 0
          ? Number(balanceResult.rows[0].quantity)
          : 0

      // ممنوع نبيع أكتر من الكمية المتاحة
      // مثال:
      // الموجود 8 والعميل بيبيع 20 => نوقف العملية كلها
      // لأن المخزون لازم ماينزلش بالسالب
      if (quantityBefore < item.quantity) {
        throw new SalesApiError(
          400,
          `Insufficient stock for ${item.skuSnapshot}. Available: ${quantityBefore}, Requested: ${item.quantity}`,
        )
      }

      // الكمية بعد البيع = الكمية قبل البيع - الكمية المباعة
      const quantityAfter = quantityBefore - item.quantity

      // هنا بنحدث المخزون بعد التأكد إن الكمية كافية
      await client.query(
        `
        UPDATE stock_balances
        SET quantity = $1,
            updated_at = NOW()
        WHERE company_id = $2
          AND stock_location_id = $3
          AND variant_id = $4;
        `,
        [quantityAfter, companyId, stockLocationId, item.variantId],
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
          'sale',
          $5, $6, $7,
          'sale',
          $8,
          $9,
          $10
        );
        `,
        [
          companyId,
          branchId,
          stockLocationId,
          item.variantId,
          -Math.abs(item.quantity),
          quantityBefore,
          quantityAfter,
          sale.id,
          `Sale ${sale.sale_number}`,
          // المستخدم المسؤول عن حركة المخزون
          selectedCashierId,
        ],
      )
    }

    const createdPayments = []

    // المدفوعات تم التحقق منها وحسابها قبل إنشاء الفاتورة.
    for (const payment of preparedPayments) {
      const paymentResult = await client.query(
        `
        INSERT INTO payments (
          company_id,
          sale_id,
          method,
          amount,
          reference
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *;
        `,
        [companyId, sale.id, payment.method, payment.amount, payment.reference],
      )

      createdPayments.push(paymentResult.rows[0])
    }

    await client.query('COMMIT')

    res.status(201).json({
      data: {
        sale,
        items: createdItems,
        payments: createdPayments,
      },
    })
  } catch (error) {
    // إلغاء أي تغييرات غير مكتملة داخل Transaction الحالية.
    await client.query('ROLLBACK').catch(() => {})

    // ====================================================
    // معالجة طلبين متزامنين بنفس Idempotency Key.
    //
    // في هذه الحالة PostgreSQL تسمح لطلب واحد فقط بالحفظ،
    // والطلب الآخر يحصل على 23505.
    //
    // بدل إرجاع خطأ، نسترجع نفس الفاتورة التي حفظها
    // الطلب الأول ونرجع استجابة نجاح موحدة.
    // ====================================================
    if (isPostgresUniqueViolation(error)) {
      const requestBody =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {}

      const requestCompanyId =
        typeof requestBody.companyId === 'string'
          ? requestBody.companyId.trim()
          : ''

      const requestIdempotencyKey =
        typeof requestBody.idempotencyKey === 'string'
          ? requestBody.idempotencyKey.trim()
          : ''

      if (requestCompanyId && requestIdempotencyKey) {
        const existingSaleResult = await db.query(
          `
        SELECT *
        FROM sales
        WHERE company_id = $1
          AND idempotency_key = $2
        LIMIT 1;
        `,
          [requestCompanyId, requestIdempotencyKey],
        )

        // وجود الفاتورة بنفس المفتاح يؤكد أن الخطأ
        // ناتج عن طلب مكرر وليس Unique Constraint آخر.
        if ((existingSaleResult.rowCount ?? 0) > 0) {
          const existingSale = existingSaleResult.rows[0]

          const [existingItemsResult, existingPaymentsResult] =
            await Promise.all([
              db.query(
                `
            SELECT *
            FROM sale_items
            WHERE company_id = $1
              AND sale_id = $2
            ORDER BY created_at ASC;
            `,
                [requestCompanyId, existingSale.id],
              ),

              db.query(
                `
            SELECT *
            FROM payments
            WHERE company_id = $1
              AND sale_id = $2
            ORDER BY created_at ASC;
            `,
                [requestCompanyId, existingSale.id],
              ),
            ])

          return res.status(200).json({
            duplicated: true,

            data: {
              sale: existingSale,
              items: existingItemsResult.rows,
              payments: existingPaymentsResult.rows,
            },
          })
        }
      }
    }

    // أخطاء البيع المتوقعة مثل عدم كفاية المخزون.
    if (error instanceof SalesApiError) {
      return res.status(error.statusCode).json({
        error: error.message,
      })
    }

    // أي خطأ غير متوقع يذهب إلى Error Handler العام.
    return next(error)
  } finally {
    client.release()
  }
})
