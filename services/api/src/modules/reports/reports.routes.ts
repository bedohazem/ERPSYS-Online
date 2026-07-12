import { Router } from 'express'
import { db } from '../../db/pool'

export const reportsRouter = Router()

// ======================================================
// GET /api/reports/daily-summary
// الهدف:
// تقرير يومي مختصر عن المبيعات والمرتجعات وصافي اليوم
//
// مثال:
// /api/reports/daily-summary?companyId=xxx&date=2026-07-12
//
// ممكن كمان نفلتر بفرع معين:
// /api/reports/daily-summary?companyId=xxx&branchId=yyy&date=2026-07-12
//
// companyId:
// مهم عشان نجيب تقرير الشركة الحالية فقط
//
// branchId:
// اختياري لو عايز تقرير فرع معين
//
// date:
// اليوم المطلوب التقرير عنه بصيغة YYYY-MM-DD
// ======================================================
reportsRouter.get('/api/reports/daily-summary', async (req, res, next) => {
  try {
    const companyId = req.query.companyId
    const branchId = req.query.branchId
    const date = req.query.date

    // =========================
    // Validation
    // =========================
    // لازم companyId عشان التقرير يبقى تابع لشركة معينة
    if (typeof companyId !== 'string' || !companyId.trim()) {
      return res
        .status(400)
        .json({ error: 'companyId query parameter is required' })
    }

    // لازم date عشان نعرف التقرير بتاع أنهي يوم
    if (typeof date !== 'string' || !date.trim()) {
      return res.status(400).json({ error: 'date query parameter is required' })
    }

    // Regex بسيط يتأكد إن التاريخ شكله YYYY-MM-DD
    // مثال صحيح: 2026-07-12
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res
        .status(400)
        .json({ error: 'date must be in YYYY-MM-DD format' })
    }

    // branchId اختياري
    // لو موجود نستخدمه في الفلترة
    // لو مش موجود نخليه null عشان التقرير يبقى على كل الفروع
    const selectedBranchId =
      typeof branchId === 'string' && branchId.trim() ? branchId : null

    // ======================================================
    // Sales summary
    // هنا بنحسب:
    // - عدد فواتير البيع
    // - إجمالي المبيعات
    // - إجمالي المدفوع
    //
    // created_at >= date
    // created_at < date + 1 day
    //
    // يعني بنجيب حركات نفس اليوم فقط
    // ======================================================
    const salesSummaryResult = await db.query(
      `
      SELECT
        COUNT(*)::int AS sales_count,
        COALESCE(SUM(total), 0) AS total_sales,
        COALESCE(SUM(paid_total), 0) AS total_paid
      FROM sales
      WHERE company_id = $1
        AND status = 'completed'
        AND created_at >= $2::date
        AND created_at < ($2::date + INTERVAL '1 day')
        AND ($3::uuid IS NULL OR branch_id = $3::uuid);
      `,
      [companyId, date, selectedBranchId],
    )

    // ======================================================
    // Sold items summary
    // هنا بنحسب إجمالي عدد القطع المباعة في نفس اليوم
    //
    // بنعمل JOIN بين sales و sale_items
    // عشان نجمع quantity من الأصناف
    // ======================================================
    const soldItemsResult = await db.query(
      `
      SELECT
        COALESCE(SUM(si.quantity), 0) AS sold_items_quantity
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      WHERE s.company_id = $1
        AND s.status = 'completed'
        AND s.created_at >= $2::date
        AND s.created_at < ($2::date + INTERVAL '1 day')
        AND ($3::uuid IS NULL OR s.branch_id = $3::uuid);
      `,
      [companyId, date, selectedBranchId],
    )

    // ======================================================
    // Returns summary
    // هنا بنحسب:
    // - عدد المرتجعات
    // - إجمالي المبالغ المرجعة
    // ======================================================
    const returnsSummaryResult = await db.query(
      `
      SELECT
        COUNT(*)::int AS returns_count,
        COALESCE(SUM(refund_total), 0) AS total_refunded
      FROM returns
      WHERE company_id = $1
        AND status = 'completed'
        AND created_at >= $2::date
        AND created_at < ($2::date + INTERVAL '1 day')
        AND ($3::uuid IS NULL OR branch_id = $3::uuid);
      `,
      [companyId, date, selectedBranchId],
    )

    // ======================================================
    // Returned items summary
    // هنا بنحسب إجمالي عدد القطع المرتجعة في نفس اليوم
    // ======================================================
    const returnedItemsResult = await db.query(
      `
      SELECT
        COALESCE(SUM(ri.quantity), 0) AS returned_items_quantity
      FROM returns r
      JOIN return_items ri ON ri.return_id = r.id
      WHERE r.company_id = $1
        AND r.status = 'completed'
        AND r.created_at >= $2::date
        AND r.created_at < ($2::date + INTERVAL '1 day')
        AND ($3::uuid IS NULL OR r.branch_id = $3::uuid);
      `,
      [companyId, date, selectedBranchId],
    )

    const salesSummary = salesSummaryResult.rows[0]
    const returnsSummary = returnsSummaryResult.rows[0]
    const soldItems = soldItemsResult.rows[0]
    const returnedItems = returnedItemsResult.rows[0]

    // نحول الأرقام من string ل Number عشان response يبقى أوضح
    const totalSales = Number(salesSummary.total_sales)
    const totalRefunded = Number(returnsSummary.total_refunded)

    // صافي اليوم = المبيعات - المرتجعات
    const netSales = totalSales - totalRefunded

    res.json({
      data: {
        companyId,
        branchId: selectedBranchId,
        date,

        sales: {
          count: Number(salesSummary.sales_count),
          total: totalSales,
          paid: Number(salesSummary.total_paid),
          soldItemsQuantity: Number(soldItems.sold_items_quantity),
        },

        returns: {
          count: Number(returnsSummary.returns_count),
          totalRefunded,
          returnedItemsQuantity: Number(returnedItems.returned_items_quantity),
        },

        net: {
          netSales,
        },
      },
    })
  } catch (error) {
    next(error)
  }
})
