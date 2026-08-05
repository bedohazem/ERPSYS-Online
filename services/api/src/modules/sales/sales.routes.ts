import { Router } from 'express'
import { db } from '../../db/pool'
import { getAuthContext } from '../auth/auth.middleware'

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
  details?: unknown

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message)

    this.statusCode = statusCode

    this.details = details
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

function roundQuantity(value: number) {
  return Number(value.toFixed(3))
}

function normalizeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
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
    const auth = getAuthContext(res)

    // الشركة والفرع من Session فقط.
    const companyId = auth.companyId
    const branchId = auth.branchId

    const requestedLimit = Number(req.query.limit ?? 50)

    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100)
      : 50

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

        s.shift_id,

        sale_shift.status
          AS shift_status,

        sale_shift.closed_at
          AS shift_closed_at,

        s.subtotal,
        s.discount_total,
        s.tax_total,
        s.total,
        s.paid_total,
        s.change_total,

        s.payment_status,
        s.outstanding_total,
        s.due_date,
        s.is_credit_sale,

        s.status,

        s.void_reason,
        s.voided_by,

        voider.full_name
          AS voided_by_name,

        s.voided_at,

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
        AND b.company_id = s.company_id

      JOIN stock_locations sl
        ON sl.id = s.stock_location_id
        AND sl.company_id = s.company_id

      LEFT JOIN customers c
        ON c.id = s.customer_id
        AND c.company_id = s.company_id

      LEFT JOIN cashier_shifts
        sale_shift
        ON sale_shift.id =
          s.shift_id
        AND sale_shift.company_id =
            s.company_id

      LEFT JOIN users voider
        ON voider.id =
          s.voided_by
        AND voider.company_id =
            s.company_id

      LEFT JOIN sale_items si
        ON si.sale_id = s.id
        AND si.company_id = s.company_id

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
        sale_shift.status,
        sale_shift.closed_at,
        voider.full_name,
        returned_items.returned_quantity

      ORDER BY
        s.occurred_at DESC,
        s.created_at DESC
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
// GET /api/sales/:saleId
// الهدف: عرض تفاصيل فاتورة واحدة
// بيرجع:
// 1. بيانات الفاتورة
// 2. الأصناف المباعة
// 3. المدفوعات
// مثال:
// /api/sales/SALE_ID?companyId=xxx
// ======================================================
salesRouter.get(
  '/api/sales/:saleId',

  async (req, res, next) => {
    try {
      const auth = getAuthContext(res)

      const saleId = normalizeParam(req.params.saleId)

      if (typeof saleId !== 'string' || !isValidUuid(saleId)) {
        return res.status(400).json({
          error: 'saleId is invalid',
        })
      }

      const companyId = auth.companyId

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

            s.shift_id,

            sale_shift.status
              AS shift_status,

            sale_shift.closed_at
              AS shift_closed_at,

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

            s.payment_status,
            s.outstanding_total,
            s.due_date,
            s.is_credit_sale,

            s.status,

            s.void_reason,
            s.voided_by,

            voider.full_name
              AS voided_by_name,

            s.voided_at,
            s.occurred_at,
            s.created_at,
            s.synced_at
          FROM sales s
          JOIN branches b ON b.id = s.branch_id
          JOIN stock_locations sl ON sl.id = s.stock_location_id
          LEFT JOIN customers c ON c.id = s.customer_id
          LEFT JOIN users u
            ON u.id = s.cashier_id
            AND u.company_id =
                s.company_id

          LEFT JOIN cashier_shifts
            sale_shift
            ON sale_shift.id =
              s.shift_id
            AND sale_shift.company_id =
                s.company_id

          LEFT JOIN users voider
            ON voider.id =
              s.voided_by
            AND voider.company_id =
                s.company_id

          WHERE s.company_id = $1
            AND s.id = $2

            AND (
              $3::uuid IS NULL
              OR s.branch_id =
                $3::uuid
            );
        `,
        [companyId, saleId, auth.branchId],
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

        payment_role,
        payment_direction,
        reverses_payment_id,

        created_at
      FROM payments
      WHERE company_id = $1
        AND sale_id = $2
      ORDER BY created_at ASC;
      `,
        [companyId, saleId],
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
            'sale'

        AND sm.reference_id = $2

      ORDER BY
        sm.created_at ASC,
        sm.id ASC;
      `,
        [companyId, saleId],
      )

      // نرجع كل حاجة في Response واحد واضح
      res.json({
        data: {
          sale: saleResult.rows[0],
          items: itemsResult.rows,
          payments: paymentsResult.rows,
          stockMovements: stockMovementsResult.rows,
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

salesRouter.post('/api/sales', async (req, res, next) => {
  const auth = getAuthContext(res)
  const client = await db.connect()

  try {
    const {
      stockLocationId,
      shiftId,
      customerId,
      saleNumber,
      source,
      localSaleId,
      idempotencyKey,
      items,
      payments,
    } = req.body

    // الشركة والفرع والكاشير من Session فقط.
    const companyId = auth.companyId
    const branchId = auth.branchId
    const cashierId = auth.userId

    if (!branchId) {
      return res.status(409).json({
        error: 'المستخدم الحالي غير مرتبط بفرع ولا يمكنه إنشاء فاتورة بيع.',
      })
    }

    if (!stockLocationId || typeof stockLocationId !== 'string') {
      return res.status(400).json({
        error: 'stockLocationId is required',
      })
    }

    const normalizedSaleNumber =
      typeof saleNumber === 'string' ? saleNumber.trim() : ''

    if (!normalizedSaleNumber) {
      return res.status(400).json({
        error: 'saleNumber is required',
      })
    }

    if (normalizedSaleNumber.length > 120) {
      return res.status(400).json({
        error: 'saleNumber is too long',
      })
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

    // البيع الآجل الكامل يرسل مصفوفة دفع فارغة.
    if (!Array.isArray(payments)) {
      return res.status(400).json({
        error: 'payments must be an array',
      })
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
      AND branch_id = $3

    LIMIT 1;
    `,
      [companyId, normalizedIdempotencyKey, branchId],
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

    const usedVariantIds = new Set<string>()

    // ترتيب ثابت قبل أقفال المخزون يقلل
    // احتمالات Database Deadlock.
    const orderedItems = [...items].sort((firstItem, secondItem) => {
      const firstVariantId = String(firstItem.variantId || '')
        .trim()
        .toLowerCase()

      const secondVariantId = String(secondItem.variantId || '')
        .trim()
        .toLowerCase()

      return firstVariantId.localeCompare(secondVariantId)
    })

    for (const item of orderedItems) {
      const variantId =
        typeof item.variantId === 'string'
          ? item.variantId.trim().toLowerCase()
          : ''

      if (!isValidUuid(variantId)) {
        throw new SalesApiError(400, 'variantId is invalid for a sale item', {
          variantId: variantId || null,
        })
      }

      if (usedVariantIds.has(variantId)) {
        throw new SalesApiError(
          400,
          'The same variant cannot be repeated in one sale',
          {
            variantId,
          },
        )
      }

      usedVariantIds.add(variantId)

      const rawQuantity = Number(item.quantity)

      if (!Number.isFinite(rawQuantity)) {
        throw new SalesApiError(400, 'quantity is invalid')
      }

      const quantity = roundQuantity(rawQuantity)

      if (quantity <= 0) {
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
      const method =
        typeof payment.method === 'string' ? payment.method.trim() : ''

      const rawAmount = Number(payment.amount)

      if (!allowedPaymentMethods.has(method)) {
        throw new SalesApiError(
          400,
          `Unsupported payment method: ${String(method)}`,
        )
      }

      if (!Number.isFinite(rawAmount)) {
        throw new SalesApiError(400, 'Payment amount is invalid')
      }

      const amount = roundMoney(rawAmount)

      if (amount <= 0) {
        throw new SalesApiError(400, 'Payment amount must be greater than zero')
      }

      preparedPayments.push({
        method,
        amount,
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

    const changeTotal = roundMoney(Math.max(paidTotal - total, 0))

    // القيمة التي تم تطبيقها فعليًا على الفاتورة
    // بعد استبعاد الباقي الذي عاد للعميل.
    const netPaidTotal = roundMoney(Math.max(paidTotal - changeTotal, 0))

    const outstandingTotal = roundMoney(Math.max(total - netPaidTotal, 0))

    let paymentStatus = 'paid'
    let dueDate: string | null = null
    let isCreditSale = false

    if (outstandingTotal > 0) {
      if (!selectedCustomerId) {
        throw new SalesApiError(
          400,
          'يجب اختيار عميل عند إنشاء فاتورة آجلة أو مدفوعة جزئيًا.',
        )
      }

      // قفل العميل يجعل فحص الحد الائتماني آمنًا
      // عند تنفيذ فاتورتين متزامنتين.
      const creditPolicyResult = await client.query(
        `
            SELECT
              allow_credit_sales,
              credit_limit,
              payment_terms_days

            FROM customers

            WHERE company_id = $1
              AND id = $2
              AND is_active = TRUE

            FOR UPDATE;
          `,
        [companyId, selectedCustomerId],
      )

      if ((creditPolicyResult.rowCount ?? 0) === 0) {
        throw new SalesApiError(404, 'العميل غير موجود أو غير نشط.')
      }

      const creditPolicy = creditPolicyResult.rows[0]

      if (!creditPolicy.allow_credit_sales) {
        throw new SalesApiError(409, 'البيع الآجل غير مفعل لهذا العميل.')
      }

      const creditLimit = roundMoney(Number(creditPolicy.credit_limit))

      if (!Number.isFinite(creditLimit) || creditLimit <= 0) {
        throw new SalesApiError(409, 'الحد الائتماني للعميل غير صالح.')
      }

      const currentOutstandingResult = await client.query(
        `
            SELECT
              COALESCE(
                SUM(outstanding_total),
                0
              ) AS outstanding_total

            FROM sales

            WHERE company_id = $1
              AND customer_id = $2
              AND status <> 'voided';
          `,
        [companyId, selectedCustomerId],
      )

      const currentOutstanding = roundMoney(
        Number(currentOutstandingResult.rows[0].outstanding_total),
      )

      const nextCustomerOutstanding = roundMoney(
        currentOutstanding + outstandingTotal,
      )

      if (nextCustomerOutstanding - creditLimit > 0.01) {
        throw new SalesApiError(
          409,
          'الفاتورة تتجاوز الحد الائتماني المتاح للعميل.',
          {
            creditLimit,
            currentOutstanding,
            requestedCredit: outstandingTotal,

            nextCustomerOutstanding,
          },
        )
      }

      const paymentTermsDays = Number(creditPolicy.payment_terms_days)

      const calculatedDueDate = new Date()

      calculatedDueDate.setUTCDate(
        calculatedDueDate.getUTCDate() + paymentTermsDays,
      )

      dueDate = calculatedDueDate.toISOString().slice(0, 10)

      paymentStatus = netPaidTotal > 0 ? 'partially_paid' : 'unpaid'

      isCreditSale = true
    }

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

        payment_status,
        outstanding_total,
        due_date,
        is_credit_sale,

        status,
        synced_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20,
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
        normalizedSaleNumber,
        selectedSource,
        localSaleId || null,
        normalizedIdempotencyKey,
        subtotal,
        finalDiscountTotal,
        finalTaxTotal,
        total,
        paidTotal,
        changeTotal,

        paymentStatus,
        outstandingTotal,
        dueDate,
        isCreditSale,
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

      // حتى معالجة الطلب المكرر تستخدم Session الحالية.
      const requestCompanyId = auth.companyId

      const requestIdempotencyKey =
        typeof requestBody.idempotencyKey === 'string'
          ? requestBody.idempotencyKey.trim()
          : ''

      const requestBranchId = auth.branchId || ''

      if (
        requestCompanyId &&
        requestIdempotencyKey &&
        isValidUuid(requestBranchId)
      ) {
        const existingSaleResult = await db.query(
          `
        SELECT *
        FROM sales
        WHERE company_id = $1
          AND idempotency_key = $2
          AND branch_id = $3
        LIMIT 1;
        `,
          [requestCompanyId, requestIdempotencyKey, requestBranchId],
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
      return res.status(409).json({
        error: 'Sale number or idempotency key already exists',
      })
    }

    // أخطاء البيع المتوقعة مثل عدم كفاية المخزون.
    if (error instanceof SalesApiError) {
      return res.status(error.statusCode).json({
        error: error.message,

        ...(error.details
          ? {
              details: error.details,
            }
          : {}),
      })
    }

    // أي خطأ غير متوقع يذهب إلى Error Handler العام.
    return next(error)
  } finally {
    client.release()
  }
})

// ======================================================
// POST /api/sales/:saleId/void
//
// Body:
// {
//   reason: string,
//   refundReference?: string
// }
//
// يمنع إلغاء فاتورة مرتبطة بمرتجع أو استبدال نشط.
// يعكس المخزون وقيمة البيع داخل Transaction واحدة.
// ======================================================
salesRouter.post(
  '/api/sales/:saleId/void',

  async (req, res, next) => {
    const client = await db.connect()

    let transactionStarted = false

    try {
      const auth = getAuthContext(res)

      const saleId = normalizeParam(req.params.saleId)

      if (typeof saleId !== 'string' || !isValidUuid(saleId)) {
        throw new SalesApiError(400, 'saleId is invalid')
      }

      const reason =
        typeof req.body?.reason === 'string'
          ? req.body.reason.trim().slice(0, 500)
          : ''

      if (reason.length < 3) {
        throw new SalesApiError(
          400,
          'Void reason must contain at least 3 characters',
        )
      }

      const refundReference =
        typeof req.body?.refundReference === 'string' &&
        req.body.refundReference.trim()
          ? req.body.refundReference.trim().slice(0, 120)
          : null

      await client.query('BEGIN')

      transactionStarted = true

      // ==================================================
      // Lock sale
      // ==================================================
      const saleResult = await client.query(
        `
          SELECT *

          FROM sales

          WHERE company_id = $1
            AND id = $2

            AND (
              $3::uuid IS NULL
              OR branch_id =
                 $3::uuid
            )

          FOR UPDATE;
          `,
        [auth.companyId, saleId, auth.branchId],
      )

      if ((saleResult.rowCount ?? 0) === 0) {
        throw new SalesApiError(
          404,
          'Sale was not found or belongs to another branch',
        )
      }

      const sale = saleResult.rows[0]

      if (sale.status === 'voided') {
        await client.query('COMMIT')

        transactionStarted = false

        return res.json({
          alreadyVoided: true,

          data: {
            sale,

            stockReversalIds: [],

            paymentReversalIds: [],
          },
        })
      }

      if (sale.status !== 'completed') {
        throw new SalesApiError(409, 'Only completed sales can be voided')
      }

      // ==================================================
      // POS sale lifecycle protection
      //
      // فاتورة مرتبطة بورديّة لا يمكن إلغاؤها بعد إغلاق
      // الوردية، لأن رد المبلغ يجب أن يدخل في نفس تسوية
      // النقدية.
      //
      // بعد إغلاق الوردية يتم استخدام دورة المرتجعات
      // بدل إلغاء الفاتورة الأصلية.
      // ==================================================
      if (sale.shift_id) {
        const shiftResult = await client.query(
          `
      SELECT
        id,
        cashier_id,
        status,
        opened_at,
        closed_at

      FROM cashier_shifts

      WHERE company_id = $1
        AND id = $2
        AND branch_id = $3

      FOR UPDATE;
      `,
          [auth.companyId, sale.shift_id, sale.branch_id],
        )

        if ((shiftResult.rowCount ?? 0) === 0) {
          throw new SalesApiError(
            409,
            'Sale cashier shift history is missing or invalid',
          )
        }

        const saleShift = shiftResult.rows[0]

        if (sale.cashier_id && saleShift.cashier_id !== sale.cashier_id) {
          throw new SalesApiError(
            409,
            'Sale cashier does not match the original cashier shift',
          )
        }

        if (saleShift.status !== 'open') {
          throw new SalesApiError(
            409,
            'Sales from a closed cashier shift cannot be voided. Use the return workflow instead',
            {
              shiftId: saleShift.id,

              shiftStatus: saleShift.status,

              closedAt: saleShift.closed_at,
            },
          )
        }
      }

      // ==================================================
      // منع إلغاء فاتورة مرتبطة بمرتجع أو استبدال نشط.
      // يجب إلغاء المستندات التابعة أولًا.
      // ==================================================
      const dependenciesResult = await client.query(
        `
          SELECT
            (
              SELECT COUNT(*)::int

              FROM returns r

              WHERE r.company_id =
                    $1

                AND r.original_sale_id =
                    $2

                AND r.status IN (
                    'completed',
                    'pending_review'
                )
            ) AS active_returns,

            (
              SELECT COUNT(*)::int

              FROM exchanges e

              WHERE e.company_id =
                    $1

                AND e.original_sale_id =
                    $2

                AND e.status IN (
                    'completed',
                    'pending_review'
                )
            ) AS active_exchanges;
          `,
        [auth.companyId, saleId],
      )

      const activeReturns = Number(dependenciesResult.rows[0].active_returns)

      const activeExchanges = Number(
        dependenciesResult.rows[0].active_exchanges,
      )

      if (activeReturns > 0 || activeExchanges > 0) {
        throw new SalesApiError(
          409,
          'Sale has active returns or exchanges and cannot be voided',
          {
            activeReturns,
            activeExchanges,
          },
        )
      }

      // ==================================================
      // Original stock movements
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
                'sale'

            AND reference_id = $2

            AND movement_type =
                'sale'

            AND reversal_of_movement_id
                IS NULL

          ORDER BY
            variant_id ASC,
            created_at ASC,
            id ASC

          FOR UPDATE;
          `,
        [auth.companyId, saleId],
      )

      const expectedMovementsResult = await client.query(
        `
          SELECT COUNT(*)::int
            AS expected_count

          FROM sale_items

          WHERE company_id = $1
            AND sale_id = $2;
          `,
        [auth.companyId, saleId],
      )

      const expectedMovementCount = Number(
        expectedMovementsResult.rows[0].expected_count,
      )

      const originalMovements = originalMovementsResult.rows

      if (
        originalMovements.length === 0 ||
        originalMovements.length !== expectedMovementCount
      ) {
        throw new SalesApiError(
          409,
          'Sale stock movement history is incomplete and cannot be reversed safely',
          {
            expectedMovementCount,

            actualMovementCount: originalMovements.length,
          },
        )
      }

      for (const movement of originalMovements) {
        const quantity = Number(movement.quantity)

        if (!Number.isFinite(quantity) || quantity >= 0) {
          throw new SalesApiError(
            409,
            'Sale contains an invalid original stock movement',
            {
              movementId: movement.id,

              quantity: movement.quantity,
            },
          )
        }
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
        throw new SalesApiError(
          409,
          'Sale already contains stock reversal movements',
        )
      }

      // ==================================================
      // Original payments
      //
      // مدفوعات cash ترتب أولًا لأن change_total
      // غالبًا خرج من المبلغ النقدي.
      // ==================================================
      const originalPaymentsResult = await client.query(
        `
          SELECT *

          FROM payments

          WHERE company_id = $1
            AND sale_id = $2

            AND payment_role =
                'sale_collection'

          ORDER BY
            CASE
              WHEN method = 'cash'
              THEN 0
              ELSE 1
            END,

            created_at ASC,
            id ASC

          FOR UPDATE;
          `,
        [auth.companyId, saleId],
      )

      const originalPaymentTotal = roundMoney(
        originalPaymentsResult.rows.reduce(
          (total, payment) => total + Number(payment.amount),

          0,
        ),
      )

      const saleTotal = roundMoney(Number(sale.total))

      const paidTotal = roundMoney(Number(sale.paid_total))

      const changeTotal = roundMoney(Number(sale.change_total))

      if (
        !Number.isFinite(saleTotal) ||
        !Number.isFinite(paidTotal) ||
        !Number.isFinite(changeTotal)
      ) {
        throw new SalesApiError(409, 'Sale contains invalid financial totals')
      }

      if (Math.abs(originalPaymentTotal - paidTotal) > 0.01) {
        throw new SalesApiError(
          409,
          'Sale payment history does not match paid total',
          {
            expectedPaidTotal: paidTotal,

            actualPaymentTotal: originalPaymentTotal,
          },
        )
      }

      const outstandingTotal = roundMoney(Number(sale.outstanding_total ?? 0))

      const netCollectedTotal = roundMoney(Math.max(paidTotal - changeTotal, 0))

      const expectedOutstanding = roundMoney(
        Math.max(saleTotal - netCollectedTotal, 0),
      )

      if (
        !Number.isFinite(outstandingTotal) ||
        Math.abs(expectedOutstanding - outstandingTotal) > 0.01
      ) {
        throw new SalesApiError(
          409,
          'Sale receivable totals are inconsistent',
          {
            saleTotal,
            paidTotal,
            changeTotal,
            outstandingTotal,
            expectedOutstanding,
          },
        )
      }

      const cashPaymentTotal = roundMoney(
        originalPaymentsResult.rows.reduce(
          (total, payment) => {
            if (payment.method !== 'cash') {
              return total
            }

            return total + Number(payment.amount)
          },

          0,
        ),
      )

      if (changeTotal - cashPaymentTotal > 0.01) {
        throw new SalesApiError(
          409,
          'Sale change is not fully backed by cash payments and cannot be reversed safely',
          {
            changeTotal,
            cashPaymentTotal,
          },
        )
      }

      const existingPaymentReversalsResult = await client.query(
        `
          SELECT COUNT(*)::int
            AS reversal_count

          FROM payments

          WHERE company_id = $1
            AND sale_id = $2

            AND payment_role =
                'void_reversal';
          `,
        [auth.companyId, saleId],
      )

      if (Number(existingPaymentReversalsResult.rows[0].reversal_count) > 0) {
        throw new SalesApiError(
          409,
          'Sale already contains payment reversal records',
        )
      }

      // ==================================================
      // Lock stock balances
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
          [auth.companyId, sale.branch_id, sale.stock_location_id, variantId],
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
        [auth.companyId, sale.stock_location_id, variantIds],
      )

      const runningBalances = new Map<string, number>(
        balancesResult.rows.map((balance) => [
          String(balance.variant_id),

          Number(balance.quantity),
        ]),
      )

      // ==================================================
      // Reverse stock
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
            sale.branch_id,
            auth.companyId,
            sale.stock_location_id,
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
              'sale',
              $5, $6, $7,
              'sale',
              $8,
              $9,
              $10,
              $11
            )

            RETURNING id;
            `,
          [
            auth.companyId,
            sale.branch_id,
            sale.stock_location_id,
            variantId,

            reversalQuantity,
            quantityBefore,
            quantityAfter,

            saleId,

            originalMovement.id,

            `Void reversal for sale ${sale.sale_number}`,

            auth.userId,
          ],
        )

        createdStockReversalIds.push(reversalResult.rows[0].id)

        runningBalances.set(variantId, quantityAfter)
      }

      // ==================================================
      // Prepare payment reversals
      //
      // paid_total قد يحتوي على المبلغ الذي أعطاه العميل،
      // بينما change_total تم رده له بالفعل وقت البيع.
      //
      // المبلغ الذي يُرد عند الإلغاء هو sale.total فقط.
      // ==================================================
      let remainingChange = changeTotal

      const paymentReversalPlans: Array<{
        originalPaymentId: string
        method: string
        amount: number
        originalReference: string | null
      }> = []

      for (const payment of originalPaymentsResult.rows) {
        const paymentAmount = roundMoney(Number(payment.amount))

        if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
          throw new SalesApiError(
            409,
            'Sale contains an invalid payment record',
            {
              paymentId: payment.id,
            },
          )
        }

        const appliedChange =
          payment.method === 'cash'
            ? roundMoney(Math.min(paymentAmount, remainingChange))
            : 0

        remainingChange = roundMoney(remainingChange - appliedChange)

        const reversalAmount = roundMoney(paymentAmount - appliedChange)

        if (reversalAmount <= 0) {
          continue
        }

        paymentReversalPlans.push({
          originalPaymentId: payment.id,

          method: payment.method,

          amount: reversalAmount,

          originalReference:
            typeof payment.reference === 'string' && payment.reference.trim()
              ? payment.reference.trim()
              : null,
        })
      }

      if (Math.abs(remainingChange) > 0.01) {
        throw new SalesApiError(
          409,
          'Sale change could not be matched to original payments',
          {
            remainingChange,
          },
        )
      }

      const plannedRefundTotal = roundMoney(
        paymentReversalPlans.reduce(
          (total, payment) => total + payment.amount,

          0,
        ),
      )

      if (Math.abs(plannedRefundTotal - netCollectedTotal) > 0.01) {
        throw new SalesApiError(
          409,
          'Sale payment reversal total does not match collected total',
          {
            netCollectedTotal,
            plannedRefundTotal,
          },
        )
      }

      // ==================================================
      // Create payment reversal records
      // ==================================================
      const createdPaymentReversalIds: string[] = []

      for (const reversal of paymentReversalPlans) {
        const combinedReference = [
          `Void ${sale.sale_number}`,

          refundReference,

          reversal.originalReference
            ? `Original: ${reversal.originalReference}`
            : null,
        ]
          .filter(Boolean)
          .join(' | ')
          .slice(0, 200)

        const reversalResult = await client.query(
          `
            INSERT INTO payments (
              company_id,
              sale_id,

              method,
              amount,
              reference,

              payment_role,
              payment_direction,
              reverses_payment_id
            )
            VALUES (
              $1, $2,
              $3, $4, $5,
              'void_reversal',
              'refunded_to_customer',
              $6
            )

            RETURNING id;
            `,
          [
            auth.companyId,
            saleId,

            reversal.method,
            reversal.amount,
            combinedReference || null,

            reversal.originalPaymentId,
          ],
        )

        createdPaymentReversalIds.push(reversalResult.rows[0].id)
      }

      // ==================================================
      // Mark sale voided
      // ==================================================
      const voidedSaleResult = await client.query(
        `
          UPDATE sales

          SET
            status = 'voided',

            payment_status = 'voided',
            outstanding_total = 0,

            void_reason = $1,
            voided_by = $2,
            voided_at = NOW()

          WHERE company_id = $3
            AND id = $4

          RETURNING *;
          `,
        [reason, auth.userId, auth.companyId, saleId],
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
          'sale.void',
          'sale',
          $4,
          $5::jsonb,
          $6::jsonb,
          $7,
          $8
        );
        `,
        [
          auth.companyId,
          sale.branch_id,
          auth.userId,

          saleId,

          JSON.stringify({
            status: sale.status,

            total: sale.total,

            paidTotal: sale.paid_total,

            changeTotal: sale.change_total,
          }),

          JSON.stringify({
            status: 'voided',

            reason,

            refundedTotal: plannedRefundTotal,

            stockReversalIds: createdStockReversalIds,

            paymentReversalIds: createdPaymentReversalIds,
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
          sale: voidedSaleResult.rows[0],

          stockReversalIds: createdStockReversalIds,

          paymentReversalIds: createdPaymentReversalIds,
        },
      })
    } catch (error) {
      if (transactionStarted) {
        await client.query('ROLLBACK').catch(() => {})

        transactionStarted = false
      }

      if (error instanceof SalesApiError) {
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
