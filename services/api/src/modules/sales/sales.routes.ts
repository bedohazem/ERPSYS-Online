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

      -- نجمع المرتجعات السابقة لكل فاتورة
      LEFT JOIN (
        SELECT
          original_sale_items.sale_id,
          SUM(ri.quantity) AS returned_quantity
        FROM return_items ri

        JOIN sale_items original_sale_items
          ON original_sale_items.id = ri.original_sale_item_id
          AND original_sale_items.company_id = ri.company_id

        WHERE ri.company_id = $1
          AND ri.original_sale_item_id IS NOT NULL

        GROUP BY original_sale_items.sale_id
      ) returned_items
        ON returned_items.sale_id = s.id

      WHERE s.company_id = $1
        AND ($2::uuid IS NULL OR s.branch_id = $2::uuid)

      GROUP BY
        s.id,
        b.name,
        sl.name,
        c.name,
        returned_items.returned_quantity

      ORDER BY s.created_at DESC
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

      -- نجمع كل المرتجعات السابقة الخاصة بكل sale item
      LEFT JOIN (
        SELECT
          original_sale_item_id,
          SUM(quantity) AS returned_quantity
        FROM return_items
        WHERE company_id = $1
          AND original_sale_item_id IS NOT NULL
        GROUP BY original_sale_item_id
      ) returned_items
        ON returned_items.original_sale_item_id = si.id

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
      discountTotal,
      taxTotal,
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

    await client.query('BEGIN')

    const existingSale = await client.query(
      `
      SELECT id, sale_number, total, status
      FROM sales
      WHERE company_id = $1
        AND idempotency_key = $2;
      `,
      [companyId, idempotencyKey],
    )

    if ((existingSale.rowCount ?? 0) > 0) {
      await client.query('COMMIT')

      return res.status(200).json({
        duplicated: true,
        data: existingSale.rows[0],
      })
    }

    let subtotal = 0

    const preparedItems = []

    for (const item of items) {
      const variantId = item.variantId
      const quantity = Number(item.quantity)
      const unitPrice = Number(item.unitPrice)
      const itemDiscount = Number(item.discountAmount || 0)
      const itemTax = Number(item.taxAmount || 0)

      if (!variantId || typeof variantId !== 'string') {
        throw new Error('variantId is required for each item')
      }

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new Error('quantity must be greater than zero')
      }

      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new Error('unitPrice must be zero or greater')
      }

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
        throw new Error(`Variant not found or inactive: ${variantId}`)
      }

      const variant = variantResult.rows[0]
      const lineTotal = quantity * unitPrice - itemDiscount + itemTax

      subtotal += quantity * unitPrice

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

    const finalDiscountTotal = Number(discountTotal || 0)
    const finalTaxTotal = Number(taxTotal || 0)
    const total = subtotal - finalDiscountTotal + finalTaxTotal

    const paidTotal = payments.reduce((sum: number, payment: any) => {
      return sum + Number(payment.amount || 0)
    }, 0)

    const changeTotal = Math.max(paidTotal - total, 0)

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
        cashierId || null,
        shiftId || null,
        customerId || null,
        saleNumber.trim(),
        source || 'online_pos',
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
          cashierId || null,
        ],
      )
    }

    const createdPayments = []

    for (const payment of payments) {
      const method = payment.method
      const amount = Number(payment.amount)

      if (!method || typeof method !== 'string') {
        throw new Error('Payment method is required')
      }

      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('Payment amount must be greater than zero')
      }

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
        [companyId, sale.id, method, amount, payment.reference || null],
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
    // لو حصل أي خطأ، نرجع كل اللي حصل جوه transaction
    // يعني لو الفاتورة اتعملت وبعدها اكتشفنا إن المخزون غير كافي
    // كل حاجة تتلغي: sale + sale_items + payments + stock movement
    await client.query('ROLLBACK').catch(() => {})

    // لو الخطأ من النوع اللي إحنا عاملينه للـ Sales
    // نرجع status واضح ورسالة مفهومة
    if (error instanceof SalesApiError) {
      return res.status(error.statusCode).json({ error: error.message })
    }

    // أي خطأ تاني غير متوقع يروح للـ error handler العام
    next(error)
  } finally {
    client.release()
  }
})
