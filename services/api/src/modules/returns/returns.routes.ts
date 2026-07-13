import { Router } from 'express'
import { db } from '../../db/pool'

export const returnsRouter = Router()

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

  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
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
    const companyId = req.query.companyId
    const branchId = req.query.branchId

    // limit عشان ما نرجعش عدد كبير جدًا مرة واحدة
    const limit = Math.min(Number(req.query.limit || 50), 100)

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res
        .status(400)
        .json({ error: 'companyId query parameter is required' })
    }

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
        r.created_at,

        -- عدد الأصناف داخل المرتجع
        COUNT(ri.id)::int AS items_count
      FROM returns r
      JOIN branches b ON b.id = r.branch_id
      JOIN stock_locations sl ON sl.id = r.stock_location_id
      LEFT JOIN customers c ON c.id = r.customer_id
      LEFT JOIN sales s ON s.id = r.original_sale_id
      LEFT JOIN return_items ri ON ri.return_id = r.id
      WHERE r.company_id = $1
        AND ($2::uuid IS NULL OR r.branch_id = $2::uuid)
      GROUP BY
        r.id,
        b.name,
        sl.name,
        c.name,
        s.sale_number
      ORDER BY r.created_at DESC
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
returnsRouter.get('/api/returns/:returnId', async (req, res, next) => {
  try {
    const returnId = req.params.returnId
    const companyId = req.query.companyId

    if (!returnId || typeof returnId !== 'string') {
      return res.status(400).json({ error: 'returnId is required' })
    }

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res
        .status(400)
        .json({ error: 'companyId query parameter is required' })
    }

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
        u.full_name AS created_by_name,
        r.created_at,
        r.synced_at
      FROM returns r
      JOIN branches b ON b.id = r.branch_id
      JOIN stock_locations sl ON sl.id = r.stock_location_id
      LEFT JOIN customers c ON c.id = r.customer_id
      LEFT JOIN sales s ON s.id = r.original_sale_id
      LEFT JOIN users u ON u.id = r.created_by
      WHERE r.company_id = $1
        AND r.id = $2;
      `,
      [companyId, returnId],
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
        created_at
      FROM return_refunds
      WHERE company_id = $1
        AND return_id = $2
      ORDER BY created_at ASC;
      `,
      [companyId, returnId],
    )

    res.json({
      data: {
        return: returnResult.rows[0],
        items: itemsResult.rows,
        refunds: refundsResult.rows,
      },
    })
  } catch (error) {
    next(error)
  }
})

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
  const client = await db.connect()

  try {
    const {
      companyId,
      branchId,
      stockLocationId,
      customerId,
      originalSaleId,
      returnNumber,
      source,
      idempotencyKey,
      reason,
      createdBy,
      items,
      refunds,
    } = req.body

    // =========================
    // Basic validation
    // =========================

    if (!companyId || typeof companyId !== 'string') {
      return res.status(400).json({ error: 'companyId is required' })
    }

    if (!branchId || typeof branchId !== 'string') {
      return res.status(400).json({ error: 'branchId is required' })
    }

    if (!stockLocationId || typeof stockLocationId !== 'string') {
      return res.status(400).json({ error: 'stockLocationId is required' })
    }

    if (!returnNumber || typeof returnNumber !== 'string') {
      return res.status(400).json({ error: 'returnNumber is required' })
    }

    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      return res.status(400).json({ error: 'idempotencyKey is required' })
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items are required' })
    }

    if (!Array.isArray(refunds) || refunds.length === 0) {
      return res.status(400).json({ error: 'refunds are required' })
    }

    await client.query('BEGIN')

    // =========================
    // Idempotency check
    // =========================
    // لو نفس المرتجع اتبعت مرتين بالغلط
    // نرجع المرتجع القديم بدل ما نكرره
    const existingReturn = await client.query(
      `
      SELECT id, return_number, refund_total, status
      FROM returns
      WHERE company_id = $1
        AND idempotency_key = $2;
      `,
      [companyId, idempotencyKey],
    )

    if ((existingReturn.rowCount ?? 0) > 0) {
      await client.query('COMMIT')

      return res.status(200).json({
        duplicated: true,
        data: existingReturn.rows[0],
      })
    }

    // =========================
    // Prepare return items
    // =========================
    // هنا بنجهز الأصناف قبل إنشاء المرتجع
    // عشان نحسب الإجماليات ونتأكد من صحة البيانات
    const preparedItems: any[] = []
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

      const secondKey = String(
        secondItem.originalSaleItemId || secondItem.variantId || '',
      )

      return firstKey.localeCompare(secondKey)
    })

    for (const item of orderedItems) {
      const originalSaleItemId = item.originalSaleItemId || null
      const variantId = item.variantId
      const quantity = Number(item.quantity)
      const unitPrice = Number(item.unitPrice)
      const refundAmount = Number(item.refundAmount)

      if (!variantId || typeof variantId !== 'string') {
        throw new ReturnsApiError(400, 'variantId is required for each item')
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

          -- ==================================================
          -- نقفل سطر الفاتورة حتى نهاية Transaction.
          --
          -- لو طلبا مرتجع وصلا في نفس الوقت لنفس الصنف:
          -- الطلب الثاني ينتظر الأول، ثم يعيد حساب الكمية
          -- المرتجعة سابقًا قبل السماح بإنشاء المرتجع.
          -- ==================================================
          FOR UPDATE OF si;
          `,
          [companyId, originalSaleItemId, variantId],
        )

        if ((saleItemResult.rowCount ?? 0) === 0) {
          throw new ReturnsApiError(404, 'Original sale item was not found')
        }

        const saleItem = saleItemResult.rows[0]

        // لو المستخدم بعت originalSaleId
        // نتأكد إن sale item تابع لنفس الفاتورة
        if (originalSaleId && saleItem.sale_id !== originalSaleId) {
          throw new ReturnsApiError(
            400,
            'originalSaleItemId does not belong to originalSaleId',
          )
        }

        // نجمع الكميات اللي اترجعت قبل كده لنفس sale item
        const alreadyReturnedResult = await client.query(
          `
          SELECT COALESCE(SUM(quantity), 0) AS returned_quantity
          FROM return_items
          WHERE company_id = $1
            AND original_sale_item_id = $2;
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
        branchId,
        stockLocationId,
        customerId || null,
        originalSaleId || null,
        returnNumber.trim(),
        source || 'online_pos',
        idempotencyKey,
        subtotal,
        refundTotal,
        reason || null,
        createdBy || null,
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
        [companyId, branchId, stockLocationId, item.variantId],
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
        [companyId, stockLocationId, item.variantId],
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
        [quantityAfter, branchId, companyId, stockLocationId, item.variantId],
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
          branchId,
          stockLocationId,
          item.variantId,
          item.quantity,
          quantityBefore,
          quantityAfter,
          createdReturn.id,
          `Return ${createdReturn.return_number}`,
          createdBy || null,
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

      if (!method || typeof method !== 'string') {
        throw new ReturnsApiError(400, 'Refund method is required')
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

    // أخطاء المرتجعات المتوقعة ترجع برسالة واضحة
    if (error instanceof ReturnsApiError) {
      return res.status(error.statusCode).json({ error: error.message })
    }

    next(error)
  } finally {
    client.release()
  }
})
