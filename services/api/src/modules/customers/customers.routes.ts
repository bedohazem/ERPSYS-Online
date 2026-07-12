import { Router } from 'express'
import { db } from '../../db/pool'

export const customersRouter = Router()

// ======================================================
// GET /api/customers
// الهدف:
// عرض العملاء الموجودين داخل شركة معينة
//
// أمثلة:
// /api/customers?companyId=xxx
// /api/customers?companyId=xxx&q=ahmed
//
// companyId:
// مهم جدًا عشان نعرض عملاء الشركة الحالية فقط
//
// q:
// اختياري للبحث بالاسم أو رقم التليفون أو الإيميل
// ======================================================
customersRouter.get('/api/customers', async (req, res, next) => {
  try {
    const companyId = req.query.companyId
    const q = req.query.q

    // limit عشان ما نرجعش عدد ضخم من العملاء مرة واحدة
    const limit = Math.min(Number(req.query.limit || 50), 100)

    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res
        .status(400)
        .json({ error: 'companyId query parameter is required' })
    }

    // لو المستخدم كتب q نبحث به
    // لو ماكتبش q نرجع كل العملاء داخل الشركة
    const searchText =
      typeof q === 'string' && q.trim() ? `%${q.trim()}%` : null

    const result = await db.query(
      `
      SELECT
        id,
        company_id,
        name,
        phone,
        email,
        address,
        is_active,
        created_at,
        updated_at
      FROM customers
      WHERE company_id = $1
        AND (
          $2::text IS NULL
          OR name ILIKE $2
          OR phone ILIKE $2
          OR email ILIKE $2
        )
      ORDER BY created_at DESC
      LIMIT $3;
      `,
      [companyId, searchText, limit],
    )

    res.json({ data: result.rows })
  } catch (error) {
    next(error)
  }
})

// ======================================================
// GET /api/customers/:customerId/sales
// الهدف:
// عرض كل فواتير عميل معين
//
// مثال:
// /api/customers/CUSTOMER_ID/sales?companyId=xxx
//
// ليه مهم؟
// عشان لما نفتح شاشة عميل في Web Admin أو POS
// نقدر نعرف العميل اشترى إيه قبل كده
// وإجمالي تعاملاته كام
// ======================================================
customersRouter.get(
  '/api/customers/:customerId/sales',
  async (req, res, next) => {
    try {
      // customerId جاي من الرابط
      // مثال: /api/customers/123/sales
      const customerId = req.params.customerId

      // companyId جاي من query
      // لازم نستخدمه عشان نضمن إن العميل والفواتير تابعين لنفس الشركة
      const companyId = req.query.companyId

      // limit اختياري
      // لو العميل عنده فواتير كتير، مانرجعش كل حاجة مرة واحدة
      const limit = Math.min(Number(req.query.limit || 50), 100)

      if (!customerId || typeof customerId !== 'string') {
        return res.status(400).json({ error: 'customerId is required' })
      }

      if (typeof companyId !== 'string' || !companyId.trim()) {
        return res
          .status(400)
          .json({ error: 'companyId query parameter is required' })
      }

      // أولًا: نتأكد إن العميل موجود داخل نفس الشركة
      // ده يمنع إن حد يطلب فواتير عميل مش تابع للشركة دي
      const customerResult = await db.query(
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
        AND id = $2;
      `,
        [companyId, customerId],
      )

      if ((customerResult.rowCount ?? 0) === 0) {
        return res.status(404).json({ error: 'Customer was not found' })
      }

      // ثانيًا: نجيب فواتير العميل
      // بنجيب معاها اسم الفرع وعدد الأصناف داخل كل فاتورة
      const salesResult = await db.query(
        `
      SELECT
        s.id,
        s.sale_number,
        s.branch_id,
        b.name AS branch_name,
        s.stock_location_id,
        sl.name AS stock_location_name,
        s.subtotal,
        s.discount_total,
        s.tax_total,
        s.total,
        s.paid_total,
        s.change_total,
        s.status,
        s.created_at,

        -- عدد الأصناف داخل الفاتورة
        COUNT(si.id)::int AS items_count
      FROM sales s
      JOIN branches b ON b.id = s.branch_id
      JOIN stock_locations sl ON sl.id = s.stock_location_id
      LEFT JOIN sale_items si ON si.sale_id = s.id
      WHERE s.company_id = $1
        AND s.customer_id = $2
      GROUP BY
        s.id,
        b.name,
        sl.name
      ORDER BY s.created_at DESC
      LIMIT $3;
      `,
        [companyId, customerId, limit],
      )

      // ثالثًا: نعمل ملخص سريع لتعاملات العميل
      // عدد الفواتير + إجمالي المبيعات + إجمالي المدفوع
      const summaryResult = await db.query(
        `
      SELECT
        COUNT(*)::int AS sales_count,
        COALESCE(SUM(total), 0) AS total_sales,
        COALESCE(SUM(paid_total), 0) AS total_paid
      FROM sales
      WHERE company_id = $1
        AND customer_id = $2
        AND status = 'completed';
      `,
        [companyId, customerId],
      )

      res.json({
        data: {
          customer: customerResult.rows[0],
          summary: summaryResult.rows[0],
          sales: salesResult.rows,
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

// ======================================================
// GET /api/customers/:customerId/returns
// الهدف:
// عرض كل مرتجعات عميل معين
//
// مثال:
// /api/customers/CUSTOMER_ID/returns?companyId=xxx
//
// ليه مهم؟
// عشان لما نفتح شاشة العميل نقدر نشوف:
// 1. العميل رجّع إيه
// 2. إجمالي المرتجعات كام
// 3. المرتجعات مرتبطة بأي فواتير أصلية
// ======================================================
customersRouter.get(
  '/api/customers/:customerId/returns',
  async (req, res, next) => {
    try {
      // customerId جاي من الرابط
      // مثال: /api/customers/123/returns
      const customerId = req.params.customerId

      // companyId جاي من query
      // مهم عشان نضمن إن العميل تابع للشركة الحالية
      const companyId = req.query.companyId

      // limit اختياري
      // لو العميل عنده مرتجعات كتير، مانرجعش كل حاجة مرة واحدة
      const limit = Math.min(Number(req.query.limit || 50), 100)

      if (!customerId || typeof customerId !== 'string') {
        return res.status(400).json({ error: 'customerId is required' })
      }

      if (typeof companyId !== 'string' || !companyId.trim()) {
        return res
          .status(400)
          .json({ error: 'companyId query parameter is required' })
      }

      // ======================================================
      // أولًا: نتأكد إن العميل موجود داخل نفس الشركة
      // ده يمنع إن حد يطلب مرتجعات عميل مش تابع للشركة دي
      // ======================================================
      const customerResult = await db.query(
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
        AND id = $2;
      `,
        [companyId, customerId],
      )

      if ((customerResult.rowCount ?? 0) === 0) {
        return res.status(404).json({ error: 'Customer was not found' })
      }

      // ======================================================
      // ثانيًا: نجيب مرتجعات العميل
      // بنجيب معاها:
      // - رقم المرتجع
      // - رقم الفاتورة الأصلية لو موجود
      // - اسم الفرع
      // - إجمالي المبلغ المرجع
      // - عدد الأصناف داخل المرتجع
      // ======================================================
      const returnsResult = await db.query(
        `
      SELECT
        r.id,
        r.return_number,
        r.branch_id,
        b.name AS branch_name,
        r.stock_location_id,
        sl.name AS stock_location_name,
        r.original_sale_id,
        s.sale_number AS original_sale_number,
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
      LEFT JOIN sales s ON s.id = r.original_sale_id
      LEFT JOIN return_items ri ON ri.return_id = r.id
      WHERE r.company_id = $1
        AND r.customer_id = $2
      GROUP BY
        r.id,
        b.name,
        sl.name,
        s.sale_number
      ORDER BY r.created_at DESC
      LIMIT $3;
      `,
        [companyId, customerId, limit],
      )

      // ======================================================
      // ثالثًا: نعمل ملخص سريع لمرتجعات العميل
      //
      // returns_count:
      // عدد المرتجعات المكتملة
      //
      // total_refunded:
      // إجمالي المبالغ اللي رجعت للعميل
      //
      // total_returned_items:
      // إجمالي عدد القطع المرتجعة
      // ======================================================
      const summaryResult = await db.query(
        `
      SELECT
        COUNT(DISTINCT r.id)::int AS returns_count,
        COALESCE(SUM(DISTINCT r.refund_total), 0) AS total_refunded,
        COALESCE(SUM(ri.quantity), 0) AS total_returned_items
      FROM returns r
      LEFT JOIN return_items ri ON ri.return_id = r.id
      WHERE r.company_id = $1
        AND r.customer_id = $2
        AND r.status = 'completed';
      `,
        [companyId, customerId],
      )

      // ======================================================
      // نرجع كل حاجة في شكل واضح:
      // customer = بيانات العميل
      // summary = ملخص المرتجعات
      // returns = قائمة المرتجعات
      // ======================================================
      res.json({
        data: {
          customer: customerResult.rows[0],
          summary: summaryResult.rows[0],
          returns: returnsResult.rows,
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

// ======================================================
// GET /api/customers/:customerId/activity
// الهدف:
// عرض نشاط العميل بالكامل في مكان واحد
//
// النشاط يشمل:
// 1. فواتير البيع Sales
// 2. المرتجعات Returns
//
// مثال:
// /api/customers/CUSTOMER_ID/activity?companyId=xxx
//
// ليه مهم؟
// في شاشة العميل، بدل ما تفتح المشتريات لوحدها والمرتجعات لوحدها
// نقدر نعرض تاريخ تعاملات العميل كله مرتب بالتاريخ.
// ======================================================
customersRouter.get(
  '/api/customers/:customerId/activity',
  async (req, res, next) => {
    try {
      // customerId جاي من الرابط
      // مثال: /api/customers/123/activity
      const customerId = req.params.customerId

      // companyId جاي من query
      // لازم نستخدمه عشان نضمن إن العميل تابع للشركة الحالية
      const companyId = req.query.companyId

      // limit اختياري
      // عشان لو العميل عنده حركات كتير مانرجعش كل حاجة مرة واحدة
      const limit = Math.min(Number(req.query.limit || 50), 100)

      if (!customerId || typeof customerId !== 'string') {
        return res.status(400).json({ error: 'customerId is required' })
      }

      if (typeof companyId !== 'string' || !companyId.trim()) {
        return res
          .status(400)
          .json({ error: 'companyId query parameter is required' })
      }

      // ======================================================
      // أولًا: نتأكد إن العميل موجود داخل نفس الشركة
      // ده مهم جدًا عشان عزل بيانات الشركات
      // ======================================================
      const customerResult = await db.query(
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
        AND id = $2;
      `,
        [companyId, customerId],
      )

      if ((customerResult.rowCount ?? 0) === 0) {
        return res.status(404).json({ error: 'Customer was not found' })
      }

      // ======================================================
      // ثانيًا: نعمل ملخص مالي للعميل
      //
      // sales_count:
      // عدد فواتير البيع المكتملة
      //
      // total_sales:
      // إجمالي مبيعات العميل
      //
      // returns_count:
      // عدد المرتجعات المكتملة
      //
      // total_refunded:
      // إجمالي المبالغ المرتجعة للعميل
      //
      // net_sales:
      // صافي تعامل العميل = المبيعات - المرتجعات
      // ======================================================
      const summaryResult = await db.query(
        `
      SELECT
        (
          SELECT COUNT(*)::int
          FROM sales
          WHERE company_id = $1
            AND customer_id = $2
            AND status = 'completed'
        ) AS sales_count,

        (
          SELECT COALESCE(SUM(total), 0)
          FROM sales
          WHERE company_id = $1
            AND customer_id = $2
            AND status = 'completed'
        ) AS total_sales,

        (
          SELECT COUNT(*)::int
          FROM returns
          WHERE company_id = $1
            AND customer_id = $2
            AND status = 'completed'
        ) AS returns_count,

        (
          SELECT COALESCE(SUM(refund_total), 0)
          FROM returns
          WHERE company_id = $1
            AND customer_id = $2
            AND status = 'completed'
        ) AS total_refunded,

        (
          (
            SELECT COALESCE(SUM(total), 0)
            FROM sales
            WHERE company_id = $1
              AND customer_id = $2
              AND status = 'completed'
          )
          -
          (
            SELECT COALESCE(SUM(refund_total), 0)
            FROM returns
            WHERE company_id = $1
              AND customer_id = $2
              AND status = 'completed'
          )
        ) AS net_sales;
      `,
        [companyId, customerId],
      )

      // ======================================================
      // ثالثًا: نجيب Timeline موحد
      //
      // هنا بنستخدم UNION ALL عشان ندمج:
      // - sales
      // - returns
      //
      // وكل حركة بنحط لها activity_type:
      // sale أو return
      // ======================================================
      const activityResult = await db.query(
        `
      SELECT
        'sale' AS activity_type,
        s.id AS activity_id,
        s.sale_number AS document_number,
        s.total AS amount,
        s.paid_total AS paid_amount,
        0::numeric AS refund_amount,
        s.status,
        s.created_at,
        b.name AS branch_name,
        sl.name AS stock_location_name,
        COUNT(si.id)::int AS items_count
      FROM sales s
      JOIN branches b ON b.id = s.branch_id
      JOIN stock_locations sl ON sl.id = s.stock_location_id
      LEFT JOIN sale_items si ON si.sale_id = s.id
      WHERE s.company_id = $1
        AND s.customer_id = $2
      GROUP BY
        s.id,
        b.name,
        sl.name

      UNION ALL

      SELECT
        'return' AS activity_type,
        r.id AS activity_id,
        r.return_number AS document_number,
        r.subtotal AS amount,
        0::numeric AS paid_amount,
        r.refund_total AS refund_amount,
        r.status,
        r.created_at,
        b.name AS branch_name,
        sl.name AS stock_location_name,
        COUNT(ri.id)::int AS items_count
      FROM returns r
      JOIN branches b ON b.id = r.branch_id
      JOIN stock_locations sl ON sl.id = r.stock_location_id
      LEFT JOIN return_items ri ON ri.return_id = r.id
      WHERE r.company_id = $1
        AND r.customer_id = $2
      GROUP BY
        r.id,
        b.name,
        sl.name

      ORDER BY created_at DESC
      LIMIT $3;
      `,
        [companyId, customerId, limit],
      )

      // ======================================================
      // نرجع كل حاجة في Response واحد واضح
      // customer = بيانات العميل
      // summary = ملخص التعاملات
      // activity = الحركات مرتبة بالتاريخ
      // ======================================================
      res.json({
        data: {
          customer: customerResult.rows[0],
          summary: summaryResult.rows[0],
          activity: activityResult.rows,
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

// ======================================================
// GET /api/customers/:customerId
// الهدف:
// عرض بيانات عميل واحد
//
// مثال:
// /api/customers/CUSTOMER_ID?companyId=xxx
//
// ليه بنطلب companyId مع customerId؟
// عشان نضمن إن العميل تابع لنفس الشركة
// ======================================================
customersRouter.get('/api/customers/:customerId', async (req, res, next) => {
  try {
    const customerId = req.params.customerId
    const companyId = req.query.companyId

    if (!customerId || typeof customerId !== 'string') {
      return res.status(400).json({ error: 'customerId is required' })
    }

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
        name,
        phone,
        email,
        address,
        is_active,
        created_at,
        updated_at
      FROM customers
      WHERE company_id = $1
        AND id = $2;
      `,
      [companyId, customerId],
    )

    if ((result.rowCount ?? 0) === 0) {
      return res.status(404).json({ error: 'Customer was not found' })
    }

    res.json({ data: result.rows[0] })
  } catch (error) {
    next(error)
  }
})

// ======================================================
// POST /api/customers
// الهدف:
// إضافة عميل جديد
//
// البيانات المطلوبة:
// companyId
// name
//
// البيانات الاختيارية:
// phone
// email
// address
//
// ملاحظة مهمة:
// phone معمول عليه UNIQUE داخل نفس الشركة
// يعني مينفعش نفس رقم التليفون يتكرر لنفس companyId
// ======================================================
customersRouter.post('/api/customers', async (req, res, next) => {
  try {
    const { companyId, name, phone, email, address } = req.body

    if (!companyId || typeof companyId !== 'string') {
      return res.status(400).json({ error: 'companyId is required' })
    }

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Customer name is required' })
    }

    // لو فيه رقم تليفون، نتأكد الأول إنه مش موجود لنفس الشركة
    // عشان نرجع رسالة مفهومة بدل database error
    if (phone && typeof phone === 'string' && phone.trim()) {
      const existingCustomer = await db.query(
        `
        SELECT id, name, phone
        FROM customers
        WHERE company_id = $1
          AND phone = $2;
        `,
        [companyId, phone.trim()],
      )

      if ((existingCustomer.rowCount ?? 0) > 0) {
        return res.status(409).json({
          error: 'Customer phone already exists',
          data: existingCustomer.rows[0],
        })
      }
    }

    const result = await db.query(
      `
      INSERT INTO customers (
        company_id,
        name,
        phone,
        email,
        address
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING
        id,
        company_id,
        name,
        phone,
        email,
        address,
        is_active,
        created_at,
        updated_at;
      `,
      [
        companyId,
        name.trim(),
        phone && typeof phone === 'string' ? phone.trim() : null,
        email && typeof email === 'string' ? email.trim() : null,
        address && typeof address === 'string' ? address.trim() : null,
      ],
    )

    res.status(201).json({ data: result.rows[0] })
  } catch (error) {
    next(error)
  }
})
