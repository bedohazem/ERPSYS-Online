import { Router } from 'express'
import { db } from '../../db/pool'

export const posRouter = Router()

// ======================================================
// GET /api/pos/stock-locations
//
// يعرض أماكن البيع والمخازن الصالحة لإنشاء فاتورة.
//
// المسار موجود تحت /api/pos حتى يحتاج sales.create
// بدل منح الكاشير صلاحية inventory.view.
//
// companyId وbranchId يتم فرضهما من Session الموثقة.
// ======================================================
posRouter.get('/api/pos/stock-locations', async (req, res, next) => {
  try {
    const companyId = req.query.companyId
    const branchId = req.query.branchId

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res.status(400).json({
        error: 'companyId query parameter is required',
      })
    }

    if (typeof branchId !== 'string' || !branchId.trim()) {
      return res.status(400).json({
        error: 'branchId query parameter is required',
      })
    }

    const result = await db.query(
      `
      SELECT
        sl.id,
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

        -- أماكن مسموح بإجراء البيع منها فقط.
        AND sl.location_type IN (
          'sales_floor',
          'branch_warehouse',
          'main_warehouse'
        )

        -- المخزن المركزي مسموح، أو مكان تابع لفرع المستخدم.
        AND (
          sl.branch_id IS NULL
          OR (
            sl.branch_id::text = $2
            AND b.is_active = TRUE
          )
        )

      ORDER BY
        CASE sl.location_type
          WHEN 'sales_floor' THEN 1
          WHEN 'branch_warehouse' THEN 2
          WHEN 'main_warehouse' THEN 3
          ELSE 4
        END,
        sl.name ASC;
      `,
      [companyId.trim(), branchId.trim()],
    )

    res.json({ data: result.rows })
  } catch (error) {
    next(error)
  }
})

// ======================================================
// GET /api/pos/customers
//
// بحث محدود عن العملاء النشطين أثناء إنشاء فاتورة بيع.
//
// وضعناه تحت /api/pos حتى يحتاج sales.create فقط،
// ولا نضطر لمنح الكاشير صلاحية customers.view.
//
// companyId يتم فرضه من Session الموثقة.
// ======================================================
posRouter.get('/api/pos/customers', async (req, res, next) => {
  try {
    const companyId = req.query.companyId
    const query = req.query.q

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res.status(400).json({
        error: 'companyId query parameter is required',
      })
    }

    const searchText =
      typeof query === 'string' && query.trim() ? `%${query.trim()}%` : null

    // حد صغير مناسب لقائمة الاختيار داخل شاشة البيع.
    const result = await db.query(
      `
      SELECT
        id,
        name,
        phone,
        email,
        address,
        is_active
      FROM customers
      WHERE company_id = $1
        AND is_active = TRUE
        AND (
          $2::text IS NULL
          OR name ILIKE $2
          OR phone ILIKE $2
          OR email ILIKE $2
        )
      ORDER BY name ASC
      LIMIT 20;
      `,
      [companyId.trim(), searchText],
    )

    res.json({
      data: result.rows,
    })
  } catch (error) {
    next(error)
  }
})

// ======================================================
// GET /api/pos/lookup-item
// الهدف:
// الكاشير يكتب barcode أو SKU
// والـ API يرجع بيانات الصنف الجاهز للبيع
//
// مثال:
// /api/pos/lookup-item?companyId=xxx&stockLocationId=yyy&code=100000000001
//
// companyId:
// عشان نجيب بيانات الشركة الحالية فقط
//
// stockLocationId:
// عشان نعرف الكمية المتاحة في صالة البيع أو المخزن
//
// code:
// ممكن يكون barcode أو SKU
// ======================================================
posRouter.get('/api/pos/lookup-item', async (req, res, next) => {
  try {
    const companyId = req.query.companyId
    const stockLocationId = req.query.stockLocationId
    const code = req.query.code

    // لازم companyId يكون موجود
    // لأن كل بيانات النظام مربوطة بالشركة
    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res
        .status(400)
        .json({ error: 'companyId query parameter is required' })
    }

    // لازم نعرف هنقرأ المخزون منين
    // مثال: Main Sales Floor
    if (typeof stockLocationId !== 'string' || !stockLocationId.trim()) {
      return res
        .status(400)
        .json({ error: 'stockLocationId query parameter is required' })
    }

    // code هو اللي الكاشير كتبه أو اتقرأ من الاسكانر
    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ error: 'code query parameter is required' })
    }

    // هنا بنبحث عن الصنف بطريقتين:
    // 1. primary_barcode الموجود على variant نفسه
    // 2. barcode الموجود في جدول variant_barcodes
    // 3. SKU كمان لو المستخدم كتب كود الصنف بدل الباركود
    const result = await db.query(
      `
      SELECT
        pv.id AS variant_id,
        pv.product_id,
        p.name AS product_name,

        pv.sku,
        pv.style_code,
        pv.primary_barcode,

        fs.name AS size_name,
        fs.code AS size_code,

        fc.name AS color_name,
        fc.code AS color_code,

        pv.cost_price,
        pv.selling_price,

        COALESCE(sb.quantity, 0) AS available_quantity,

        sl.id AS stock_location_id,
        sl.name AS stock_location_name,
        sl.code AS stock_location_code
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id

      LEFT JOIN fashion_sizes fs ON fs.id = pv.size_id
      LEFT JOIN fashion_colors fc ON fc.id = pv.color_id

      LEFT JOIN variant_barcodes vb
        ON vb.variant_id = pv.id
        AND vb.company_id = pv.company_id

      LEFT JOIN stock_balances sb
        ON sb.variant_id = pv.id
        AND sb.company_id = pv.company_id
        AND sb.stock_location_id = $2

      LEFT JOIN stock_locations sl
        ON sl.id = $2

      WHERE pv.company_id = $1
        AND pv.status = 'active'
        AND (
          pv.primary_barcode = $3
          OR pv.sku = $3
          OR vb.barcode = $3
        )
      LIMIT 1;
      `,
      [companyId, stockLocationId, code.trim()],
    )

    // لو الكود مش موجود، نرجع 404
    // ده هيساعد شاشة البيع تعرض رسالة: الصنف غير موجود
    if ((result.rowCount ?? 0) === 0) {
      return res.status(404).json({ error: 'Item was not found' })
    }

    // رجعنا الصنف الجاهز للبيع
    // أهم حاجة هنا variant_id لأنه هو اللي بيتباع في sales API
    res.json({ data: result.rows[0] })
  } catch (error) {
    next(error)
  }
})

// ======================================================
// GET /api/pos/search-items
// الهدف:
// البحث عن الأصناف بالاسم أو SKU أو الباركود
// مفيد لو الكاشير مش معاه باركود وعايز يبحث بالاسم
//
// مثال:
// /api/pos/search-items?companyId=xxx&stockLocationId=yyy&q=tshirt
// ======================================================
posRouter.get('/api/pos/search-items', async (req, res, next) => {
  try {
    const companyId = req.query.companyId
    const stockLocationId = req.query.stockLocationId
    const q = req.query.q

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res
        .status(400)
        .json({ error: 'companyId query parameter is required' })
    }

    if (typeof stockLocationId !== 'string' || !stockLocationId.trim()) {
      return res
        .status(400)
        .json({ error: 'stockLocationId query parameter is required' })
    }

    if (typeof q !== 'string' || !q.trim()) {
      return res.status(400).json({ error: 'q query parameter is required' })
    }

    // هنا بنستخدم ILIKE عشان البحث يكون غير حساس للحروف الكبيرة والصغيرة
    // يعني tshirt و TSHIRT يطلعوا نفس النتيجة
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

        pv.selling_price,

        COALESCE(sb.quantity, 0) AS available_quantity
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id

      LEFT JOIN fashion_sizes fs ON fs.id = pv.size_id
      LEFT JOIN fashion_colors fc ON fc.id = pv.color_id

      LEFT JOIN stock_balances sb
        ON sb.variant_id = pv.id
        AND sb.company_id = pv.company_id
        AND sb.stock_location_id = $2

      WHERE pv.company_id = $1
        AND pv.status = 'active'
        AND (
          p.name ILIKE $3
          OR pv.sku ILIKE $3
          OR pv.primary_barcode ILIKE $3
        )
      ORDER BY p.name ASC, pv.sku ASC
      LIMIT 20;
      `,
      [companyId, stockLocationId, `%${q.trim()}%`],
    )

    res.json({ data: result.rows })
  } catch (error) {
    next(error)
  }
})
