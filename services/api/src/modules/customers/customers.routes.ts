import { Router } from "express"
import { db } from "../../db/pool"

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
customersRouter.get("/api/customers", async (req, res, next) => {
  try {
    const companyId = req.query.companyId
    const q = req.query.q

    // limit عشان ما نرجعش عدد ضخم من العملاء مرة واحدة
    const limit = Math.min(Number(req.query.limit || 50), 100)

    if (typeof companyId !== "string" || !companyId.trim()) {
      return res.status(400).json({ error: "companyId query parameter is required" })
    }

    // لو المستخدم كتب q نبحث به
    // لو ماكتبش q نرجع كل العملاء داخل الشركة
    const searchText = typeof q === "string" && q.trim() ? `%${q.trim()}%` : null

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
customersRouter.get("/api/customers/:customerId", async (req, res, next) => {
  try {
    const customerId = req.params.customerId
    const companyId = req.query.companyId

    if (!customerId || typeof customerId !== "string") {
      return res.status(400).json({ error: "customerId is required" })
    }

    if (typeof companyId !== "string" || !companyId.trim()) {
      return res.status(400).json({ error: "companyId query parameter is required" })
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
      return res.status(404).json({ error: "Customer was not found" })
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
customersRouter.post("/api/customers", async (req, res, next) => {
  try {
    const { companyId, name, phone, email, address } = req.body

    if (!companyId || typeof companyId !== "string") {
      return res.status(400).json({ error: "companyId is required" })
    }

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Customer name is required" })
    }

    // لو فيه رقم تليفون، نتأكد الأول إنه مش موجود لنفس الشركة
    // عشان نرجع رسالة مفهومة بدل database error
    if (phone && typeof phone === "string" && phone.trim()) {
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
          error: "Customer phone already exists",
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
        phone && typeof phone === "string" ? phone.trim() : null,
        email && typeof email === "string" ? email.trim() : null,
        address && typeof address === "string" ? address.trim() : null,
      ],
    )

    res.status(201).json({ data: result.rows[0] })
  } catch (error) {
    next(error)
  }
})