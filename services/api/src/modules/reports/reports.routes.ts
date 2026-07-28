import { Router } from 'express'
import { db } from '../../db/pool'
import { getAuthContext } from '../auth/auth.middleware'

export const reportsRouter = Router()

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const allowedShiftStatuses = new Set(['open', 'closed'])

function normalizeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

function parseReportLimit(value: unknown) {
  const numericValue = Number(value ?? 50)

  if (!Number.isFinite(numericValue)) {
    return 50
  }

  return Math.min(Math.max(Math.trunc(numericValue), 1), 100)
}

function parseProductReportLimit(value: unknown) {
  const numericValue = Number(value ?? 20)

  if (!Number.isFinite(numericValue)) {
    return 20
  }

  return Math.min(Math.max(Math.trunc(numericValue), 1), 100)
}

function serializeReportTimestamp(value: unknown) {
  if (value instanceof Date) {
    return value.toISOString()
  }

  return typeof value === 'string' ? value : null
}

function mapProductPerformanceRow(row: Record<string, unknown>) {
  return {
    variantId: String(row.variant_id),

    productId: String(row.product_id),

    productName: String(row.product_name),

    sku: String(row.sku),

    primaryBarcode:
      typeof row.primary_barcode === 'string' ? row.primary_barcode : null,

    sizeName: typeof row.size_name === 'string' ? row.size_name : null,

    colorName: typeof row.color_name === 'string' ? row.color_name : null,

    categoryName:
      typeof row.category_name === 'string' ? row.category_name : null,

    brandName: typeof row.brand_name === 'string' ? row.brand_name : null,

    productStatus:
      typeof row.product_status === 'string' ? row.product_status : null,

    variantStatus:
      typeof row.variant_status === 'string' ? row.variant_status : null,

    salesCount: Number(row.sales_count ?? 0),

    soldQuantity: String(row.sold_quantity ?? '0'),

    grossRevenue: String(row.gross_revenue ?? '0'),

    averageUnitRevenue: String(row.average_unit_revenue ?? '0'),

    currentStock: String(row.current_stock ?? '0'),

    lastSaleAt: serializeReportTimestamp(row.last_sale_at),

    daysSinceLastSale:
      row.days_since_last_sale === null ||
      row.days_since_last_sale === undefined
        ? null
        : Number(row.days_since_last_sale),
  }
}

function isValidReportDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }

  const parsedDate = new Date(`${value}T00:00:00.000Z`)

  return (
    !Number.isNaN(parsedDate.getTime()) &&
    parsedDate.toISOString().slice(0, 10) === value
  )
}

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

// ======================================================
// GET /api/reports/sales-performance
//
// تقرير أداء المبيعات خلال فترة.
//
// Query:
// - dateFrom: YYYY-MM-DD
// - dateTo: YYYY-MM-DD
// - branchId?
// - cashierId?
//
// يعيد:
// - ملخص الفترة.
// - تجميع يومي.
// - تجميع حسب الفرع.
// - تجميع حسب الكاشير.
// ======================================================
reportsRouter.get(
  '/api/reports/sales-performance',

  async (req, res, next) => {
    try {
      const auth = getAuthContext(res)

      const dateFrom =
        typeof req.query.dateFrom === 'string' ? req.query.dateFrom.trim() : ''

      const dateTo =
        typeof req.query.dateTo === 'string' ? req.query.dateTo.trim() : ''

      if (!dateFrom || !isValidReportDate(dateFrom)) {
        return res.status(400).json({
          error: 'dateFrom must be a valid YYYY-MM-DD date',
        })
      }

      if (!dateTo || !isValidReportDate(dateTo)) {
        return res.status(400).json({
          error: 'dateTo must be a valid YYYY-MM-DD date',
        })
      }

      if (dateFrom > dateTo) {
        return res.status(400).json({
          error: 'dateFrom cannot be after dateTo',
        })
      }

      const startTimestamp = new Date(`${dateFrom}T00:00:00.000Z`).getTime()

      const endTimestamp = new Date(`${dateTo}T00:00:00.000Z`).getTime()

      const reportDays =
        Math.floor((endTimestamp - startTimestamp) / (24 * 60 * 60 * 1000)) + 1

      if (reportDays > 366) {
        return res.status(400).json({
          error: 'Report period cannot exceed 366 days',
        })
      }

      const branchId =
        typeof req.query.branchId === 'string'
          ? req.query.branchId.trim().toLowerCase()
          : ''

      if (branchId && !uuidPattern.test(branchId)) {
        return res.status(400).json({
          error: 'branchId is invalid',
        })
      }

      const cashierId =
        typeof req.query.cashierId === 'string'
          ? req.query.cashierId.trim().toLowerCase()
          : ''

      if (cashierId && !uuidPattern.test(cashierId)) {
        return res.status(400).json({
          error: 'cashierId is invalid',
        })
      }

      if (branchId) {
        const branchResult = await db.query(
          `
            SELECT id

            FROM branches

            WHERE company_id = $1
              AND id = $2

            LIMIT 1;
            `,
          [auth.companyId, branchId],
        )

        if ((branchResult.rowCount ?? 0) === 0) {
          return res.status(404).json({
            error: 'Branch was not found in the authenticated company',
          })
        }
      }

      if (cashierId) {
        const cashierResult = await db.query(
          `
            SELECT id

            FROM users

            WHERE company_id = $1
              AND id = $2

            LIMIT 1;
            `,
          [auth.companyId, cashierId],
        )

        if ((cashierResult.rowCount ?? 0) === 0) {
          return res.status(404).json({
            error: 'Cashier was not found in the authenticated company',
          })
        }
      }

      const result = await db.query(
        `
          WITH sale_events AS (
            SELECT
              s.occurred_at::date
                AS event_date,

              s.branch_id,
              s.cashier_id,

              CASE
                WHEN s.status IN (
                  'completed',
                  'pending_review',
                  'refunded'
                )
                THEN 1
                ELSE 0
              END::int
                AS sales_count,

              CASE
                WHEN s.status =
                     'voided'
                THEN 1
                ELSE 0
              END::int
                AS voided_sales_count,

              CASE
                WHEN s.status =
                     'pending_review'
                THEN 1
                ELSE 0
              END::int
                AS pending_review_sales_count,

              CASE
                WHEN s.status IN (
                  'completed',
                  'pending_review',
                  'refunded'
                )
                THEN s.total
                ELSE 0
              END
                AS gross_sales,

              CASE
                WHEN s.status IN (
                  'completed',
                  'pending_review',
                  'refunded'
                )
                THEN
                  COALESCE(
                    sale_items
                      .sold_quantity,
                    0
                  )
                ELSE 0
              END
                AS sold_quantity,

              0::int
                AS returns_count,

              0::numeric
                AS return_refunds,

              0::numeric
                AS returned_quantity,

              0::int
                AS exchanges_count,

              0::numeric
                AS exchange_returned_total,

              0::numeric
                AS exchange_issued_total,

              0::numeric
                AS exchange_net,

              0::numeric
                AS exchange_returned_quantity,

              0::numeric
                AS exchange_issued_quantity

            FROM sales s

            LEFT JOIN LATERAL (
              SELECT
                COALESCE(
                  SUM(si.quantity),
                  0
                )
                  AS sold_quantity

              FROM sale_items si

              WHERE si.company_id =
                    s.company_id

                AND si.sale_id =
                    s.id
            ) sale_items
              ON TRUE

            WHERE s.company_id = $1

              AND (
                $2::uuid IS NULL
                OR s.branch_id =
                   $2::uuid
              )

              AND (
                $3::uuid IS NULL
                OR s.cashier_id =
                   $3::uuid
              )

              AND s.occurred_at >=
                  $4::date

              AND s.occurred_at <
                  (
                    $5::date +
                    INTERVAL '1 day'
                  )

              AND s.status IN (
                'completed',
                'pending_review',
                'refunded',
                'voided'
              )
          ),

          return_events AS (
            SELECT
              r.created_at::date
                AS event_date,

              r.branch_id,

              r.created_by
                AS cashier_id,

              0::int
                AS sales_count,

              0::int
                AS voided_sales_count,

              0::int
                AS pending_review_sales_count,

              0::numeric
                AS gross_sales,

              0::numeric
                AS sold_quantity,

              1::int
                AS returns_count,

              r.refund_total
                AS return_refunds,

              COALESCE(
                return_items
                  .returned_quantity,
                0
              )
                AS returned_quantity,

              0::int
                AS exchanges_count,

              0::numeric
                AS exchange_returned_total,

              0::numeric
                AS exchange_issued_total,

              0::numeric
                AS exchange_net,

              0::numeric
                AS exchange_returned_quantity,

              0::numeric
                AS exchange_issued_quantity

            FROM returns r

            LEFT JOIN LATERAL (
              SELECT
                COALESCE(
                  SUM(ri.quantity),
                  0
                )
                  AS returned_quantity

              FROM return_items ri

              WHERE ri.company_id =
                    r.company_id

                AND ri.return_id =
                    r.id
            ) return_items
              ON TRUE

            WHERE r.company_id = $1

              AND (
                $2::uuid IS NULL
                OR r.branch_id =
                   $2::uuid
              )

              AND (
                $3::uuid IS NULL
                OR r.created_by =
                   $3::uuid
              )

              AND r.created_at >=
                  $4::date

              AND r.created_at <
                  (
                    $5::date +
                    INTERVAL '1 day'
                  )

              AND r.status IN (
                'completed',
                'pending_review'
              )
          ),

          exchange_events AS (
            SELECT
              e.created_at::date
                AS event_date,

              e.branch_id,

              e.created_by
                AS cashier_id,

              0::int
                AS sales_count,

              0::int
                AS voided_sales_count,

              0::int
                AS pending_review_sales_count,

              0::numeric
                AS gross_sales,

              0::numeric
                AS sold_quantity,

              0::int
                AS returns_count,

              0::numeric
                AS return_refunds,

              0::numeric
                AS returned_quantity,

              1::int
                AS exchanges_count,

              e.returned_total
                AS exchange_returned_total,

              e.issued_total
                AS exchange_issued_total,

              (
                e.issued_total -
                e.returned_total
              )
                AS exchange_net,

              COALESCE(
                returned_items
                  .returned_quantity,
                0
              )
                AS exchange_returned_quantity,

              COALESCE(
                issued_items
                  .issued_quantity,
                0
              )
                AS exchange_issued_quantity

            FROM exchanges e

            LEFT JOIN LATERAL (
              SELECT
                COALESCE(
                  SUM(
                    eri.quantity
                  ),
                  0
                )
                  AS returned_quantity

              FROM exchange_return_items
                   eri

              WHERE eri.company_id =
                    e.company_id

                AND eri.exchange_id =
                    e.id
            ) returned_items
              ON TRUE

            LEFT JOIN LATERAL (
              SELECT
                COALESCE(
                  SUM(
                    eii.quantity
                  ),
                  0
                )
                  AS issued_quantity

              FROM exchange_issue_items
                   eii

              WHERE eii.company_id =
                    e.company_id

                AND eii.exchange_id =
                    e.id
            ) issued_items
              ON TRUE

            WHERE e.company_id = $1

              AND (
                $2::uuid IS NULL
                OR e.branch_id =
                   $2::uuid
              )

              AND (
                $3::uuid IS NULL
                OR e.created_by =
                   $3::uuid
              )

              AND e.created_at >=
                  $4::date

              AND e.created_at <
                  (
                    $5::date +
                    INTERVAL '1 day'
                  )

              AND e.status IN (
                'completed',
                'pending_review'
              )
          ),

          report_events AS (
            SELECT *
            FROM sale_events

            UNION ALL

            SELECT *
            FROM return_events

            UNION ALL

            SELECT *
            FROM exchange_events
          ),

          grouped AS (
            SELECT
              event_date,
              branch_id,
              cashier_id,

              GROUPING(
                event_date
              )::int
                AS grouped_date,

              GROUPING(
                branch_id
              )::int
                AS grouped_branch,

              GROUPING(
                cashier_id
              )::int
                AS grouped_cashier,

              COALESCE(
                SUM(sales_count),
                0
              )::int
                AS sales_count,

              COALESCE(
                SUM(
                  voided_sales_count
                ),
                0
              )::int
                AS voided_sales_count,

              COALESCE(
                SUM(
                  pending_review_sales_count
                ),
                0
              )::int
                AS pending_review_sales_count,

              COALESCE(
                SUM(gross_sales),
                0
              )
                AS gross_sales,

              COALESCE(
                SUM(sold_quantity),
                0
              )
                AS sold_quantity,

              COALESCE(
                SUM(returns_count),
                0
              )::int
                AS returns_count,

              COALESCE(
                SUM(return_refunds),
                0
              )
                AS return_refunds,

              COALESCE(
                SUM(
                  returned_quantity
                ),
                0
              )
                AS returned_quantity,

              COALESCE(
                SUM(
                  exchanges_count
                ),
                0
              )::int
                AS exchanges_count,

              COALESCE(
                SUM(
                  exchange_returned_total
                ),
                0
              )
                AS exchange_returned_total,

              COALESCE(
                SUM(
                  exchange_issued_total
                ),
                0
              )
                AS exchange_issued_total,

              COALESCE(
                SUM(exchange_net),
                0
              )
                AS exchange_net,

              COALESCE(
                SUM(
                  exchange_returned_quantity
                ),
                0
              )
                AS exchange_returned_quantity,

              COALESCE(
                SUM(
                  exchange_issued_quantity
                ),
                0
              )
                AS exchange_issued_quantity

            FROM report_events

            GROUP BY GROUPING SETS (
              (),
              (event_date),
              (branch_id),
              (cashier_id)
            )
          )

          SELECT
            CASE
              WHEN grouped_date = 1
               AND grouped_branch = 1
               AND grouped_cashier = 1
              THEN 'summary'

              WHEN grouped_date = 0
              THEN 'day'

              WHEN grouped_branch = 0
              THEN 'branch'

              ELSE 'cashier'
            END
              AS group_type,

            CASE
              WHEN grouped_date = 0
              THEN TO_CHAR(
                event_date,
                'YYYY-MM-DD'
              )
              ELSE NULL
            END
              AS period_date,

            g.branch_id,
            b.code
              AS branch_code,
            b.name
              AS branch_name,

            g.cashier_id,

            cashier.full_name
              AS cashier_name,

            cashier.username
              AS cashier_username,

            g.sales_count,
            g.voided_sales_count,
            g.pending_review_sales_count,

            g.gross_sales,
            g.sold_quantity,

            g.returns_count,
            g.return_refunds,
            g.returned_quantity,

            g.exchanges_count,
            g.exchange_returned_total,
            g.exchange_issued_total,
            g.exchange_net,

            g.exchange_returned_quantity,
            g.exchange_issued_quantity,

            (
              g.gross_sales -
              g.return_refunds +
              g.exchange_net
            )
              AS net_revenue,

            CASE
              WHEN g.sales_count > 0
              THEN ROUND(
                g.gross_sales /
                g.sales_count,
                2
              )
              ELSE 0
            END
              AS average_sale_value

          FROM grouped g

          LEFT JOIN branches b
            ON b.company_id = $1
            AND b.id =
                g.branch_id

          LEFT JOIN users cashier
            ON cashier.company_id =
               $1

            AND cashier.id =
                g.cashier_id;
          `,
        [auth.companyId, branchId || null, cashierId || null, dateFrom, dateTo],
      )

      function mapMetrics(row: Record<string, unknown> | undefined) {
        return {
          salesCount: Number(row?.sales_count ?? 0),

          voidedSalesCount: Number(row?.voided_sales_count ?? 0),

          pendingReviewSalesCount: Number(row?.pending_review_sales_count ?? 0),

          grossSales: String(row?.gross_sales ?? '0'),

          soldQuantity: String(row?.sold_quantity ?? '0'),

          returnsCount: Number(row?.returns_count ?? 0),

          returnRefunds: String(row?.return_refunds ?? '0'),

          returnedQuantity: String(row?.returned_quantity ?? '0'),

          exchangesCount: Number(row?.exchanges_count ?? 0),

          exchangeReturnedTotal: String(row?.exchange_returned_total ?? '0'),

          exchangeIssuedTotal: String(row?.exchange_issued_total ?? '0'),

          exchangeNet: String(row?.exchange_net ?? '0'),

          exchangeReturnedQuantity: String(
            row?.exchange_returned_quantity ?? '0',
          ),

          exchangeIssuedQuantity: String(row?.exchange_issued_quantity ?? '0'),

          netRevenue: String(row?.net_revenue ?? '0'),

          averageSaleValue: String(row?.average_sale_value ?? '0'),
        }
      }

      const rows = result.rows as Array<Record<string, unknown>>

      const summaryRow = rows.find((row) => row.group_type === 'summary')

      const byDay = rows
        .filter((row) => row.group_type === 'day')
        .map((row) => ({
          date: String(row.period_date ?? ''),

          ...mapMetrics(row),
        }))
        .sort((first, second) => first.date.localeCompare(second.date))

      const byBranch = rows
        .filter((row) => row.group_type === 'branch')
        .map((row) => ({
          branchId: String(row.branch_id ?? ''),

          branchCode:
            typeof row.branch_code === 'string' ? row.branch_code : null,

          branchName:
            typeof row.branch_name === 'string'
              ? row.branch_name
              : 'Unknown branch',

          ...mapMetrics(row),
        }))
        .sort((first, second) =>
          first.branchName.localeCompare(second.branchName),
        )

      const byCashier = rows
        .filter((row) => row.group_type === 'cashier')
        .map((row) => ({
          cashierId: typeof row.cashier_id === 'string' ? row.cashier_id : null,

          cashierName:
            typeof row.cashier_name === 'string'
              ? row.cashier_name
              : 'Unknown or deleted user',

          cashierUsername:
            typeof row.cashier_username === 'string'
              ? row.cashier_username
              : null,

          ...mapMetrics(row),
        }))
        .sort((first, second) =>
          first.cashierName.localeCompare(second.cashierName),
        )

      return res.json({
        data: {
          filters: {
            companyId: auth.companyId,

            branchId: branchId || null,

            cashierId: cashierId || null,

            dateFrom,
            dateTo,

            days: reportDays,
          },

          definitions: {
            activeSaleStatuses: ['completed', 'pending_review', 'refunded'],

            activeReturnStatuses: ['completed', 'pending_review'],

            activeExchangeStatuses: ['completed', 'pending_review'],

            netRevenueFormula: 'grossSales - returnRefunds + exchangeNet',
          },

          summary: mapMetrics(summaryRow),

          byDay,
          byBranch,
          byCashier,
        },
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// GET /api/reports/product-performance
//
// تقرير الأصناف الأكثر مبيعًا
// والأصناف بطيئة الحركة.
//
// Query:
// - dateFrom
// - dateTo
// - branchId?
// - limit?
// ======================================================
reportsRouter.get(
  '/api/reports/product-performance',

  async (req, res, next) => {
    try {
      const auth = getAuthContext(res)

      const dateFrom =
        typeof req.query.dateFrom === 'string' ? req.query.dateFrom.trim() : ''

      const dateTo =
        typeof req.query.dateTo === 'string' ? req.query.dateTo.trim() : ''

      if (!dateFrom || !isValidReportDate(dateFrom)) {
        return res.status(400).json({
          error: 'dateFrom must be a valid YYYY-MM-DD date',
        })
      }

      if (!dateTo || !isValidReportDate(dateTo)) {
        return res.status(400).json({
          error: 'dateTo must be a valid YYYY-MM-DD date',
        })
      }

      if (dateFrom > dateTo) {
        return res.status(400).json({
          error: 'dateFrom cannot be after dateTo',
        })
      }

      const startTimestamp = new Date(`${dateFrom}T00:00:00.000Z`).getTime()

      const endTimestamp = new Date(`${dateTo}T00:00:00.000Z`).getTime()

      const reportDays =
        Math.floor((endTimestamp - startTimestamp) / (24 * 60 * 60 * 1000)) + 1

      if (reportDays > 366) {
        return res.status(400).json({
          error: 'Report period cannot exceed 366 days',
        })
      }

      const branchId =
        typeof req.query.branchId === 'string'
          ? req.query.branchId.trim().toLowerCase()
          : ''

      if (branchId && !uuidPattern.test(branchId)) {
        return res.status(400).json({
          error: 'branchId is invalid',
        })
      }

      const limit = parseProductReportLimit(req.query.limit)

      if (branchId) {
        const branchResult = await db.query(
          `
            SELECT id

            FROM branches

            WHERE company_id = $1
              AND id = $2

            LIMIT 1;
            `,
          [auth.companyId, branchId],
        )

        if ((branchResult.rowCount ?? 0) === 0) {
          return res.status(404).json({
            error: 'Branch was not found in the authenticated company',
          })
        }
      }

      const queryValues = [
        auth.companyId,
        branchId || null,
        dateFrom,
        dateTo,
        limit,
      ]

      const [summaryResult, topProductsResult, slowProductsResult] =
        await Promise.all([
          db.query(
            `
          WITH sale_totals AS (
            SELECT
              COUNT(
                DISTINCT s.id
              )::int
                AS sales_count,

              COUNT(
                DISTINCT
                si.variant_id
              )::int
                AS sold_variant_count,

              COALESCE(
                SUM(si.quantity),
                0
              )
                AS sold_quantity,

              COALESCE(
                SUM(si.line_total),
                0
              )
                AS gross_revenue

            FROM sales s

            JOIN sale_items si
              ON si.company_id =
                 s.company_id

              AND si.sale_id =
                  s.id

            WHERE s.company_id = $1

              AND (
                $2::uuid IS NULL
                OR s.branch_id =
                   $2::uuid
              )

              AND s.occurred_at >=
                  $3::date

              AND s.occurred_at <
                  (
                    $4::date +
                    INTERVAL '1 day'
                  )

              AND s.status IN (
                'completed',
                'pending_review',
                'refunded'
              )
          ),

          period_variants AS (
            SELECT DISTINCT
              si.variant_id

            FROM sales s

            JOIN sale_items si
              ON si.company_id =
                 s.company_id

              AND si.sale_id =
                  s.id

            WHERE s.company_id = $1

              AND (
                $2::uuid IS NULL
                OR s.branch_id =
                   $2::uuid
              )

              AND s.occurred_at >=
                  $3::date

              AND s.occurred_at <
                  (
                    $4::date +
                    INTERVAL '1 day'
                  )

              AND s.status IN (
                'completed',
                'pending_review',
                'refunded'
              )
          ),

          current_stock AS (
            SELECT
              sb.variant_id,

              SUM(sb.quantity)
                AS current_stock

            FROM stock_balances sb

            JOIN product_variants pv
              ON pv.company_id =
                 sb.company_id

              AND pv.id =
                  sb.variant_id

              AND pv.status =
                  'active'

            JOIN products p
              ON p.company_id =
                 pv.company_id

              AND p.id =
                  pv.product_id

              AND p.status =
                  'active'

            WHERE sb.company_id = $1

              AND (
                $2::uuid IS NULL
                OR sb.branch_id =
                   $2::uuid
              )

            GROUP BY
              sb.variant_id
          )

          SELECT
            st.sales_count,
            st.sold_variant_count,
            st.sold_quantity,
            st.gross_revenue,

            COALESCE(
              (
                SELECT
                  COUNT(*)::int

                FROM current_stock cs

                WHERE
                  cs.current_stock > 0
              ),
              0
            )
              AS in_stock_variant_count,

            COALESCE(
              (
                SELECT
                  SUM(
                    cs.current_stock
                  )

                FROM current_stock cs

                WHERE
                  cs.current_stock > 0
              ),
              0
            )
              AS current_stock_quantity,

            COALESCE(
              (
                SELECT
                  COUNT(*)::int

                FROM current_stock cs

                LEFT JOIN
                  period_variants period
                  ON period.variant_id =
                     cs.variant_id

                WHERE
                  cs.current_stock > 0

                  AND period.variant_id
                      IS NULL
              ),
              0
            )
              AS no_sale_stock_variant_count

          FROM sale_totals st;
          `,
            queryValues,
          ),

          db.query(
            `
          WITH period_sales AS (
            SELECT
              si.variant_id,

              COUNT(
                DISTINCT s.id
              )::int
                AS sales_count,

              SUM(si.quantity)
                AS sold_quantity,

              SUM(si.line_total)
                AS gross_revenue,

              MAX(s.occurred_at)
                AS last_sale_at

            FROM sales s

            JOIN sale_items si
              ON si.company_id =
                 s.company_id

              AND si.sale_id =
                  s.id

            WHERE s.company_id = $1

              AND (
                $2::uuid IS NULL
                OR s.branch_id =
                   $2::uuid
              )

              AND s.occurred_at >=
                  $3::date

              AND s.occurred_at <
                  (
                    $4::date +
                    INTERVAL '1 day'
                  )

              AND s.status IN (
                'completed',
                'pending_review',
                'refunded'
              )

            GROUP BY
              si.variant_id
          ),

          current_stock AS (
            SELECT
              sb.variant_id,

              SUM(sb.quantity)
                AS current_stock

            FROM stock_balances sb

            WHERE sb.company_id = $1

              AND (
                $2::uuid IS NULL
                OR sb.branch_id =
                   $2::uuid
              )

            GROUP BY
              sb.variant_id
          )

          SELECT
            pv.id
              AS variant_id,

            pv.product_id,

            p.name
              AS product_name,

            pv.sku,
            pv.primary_barcode,

            size.name
              AS size_name,

            color.name
              AS color_name,

            category.name
              AS category_name,

            brand.name
              AS brand_name,

            p.status
              AS product_status,

            pv.status
              AS variant_status,

            ps.sales_count,
            ps.sold_quantity,
            ps.gross_revenue,

            ROUND(
              ps.gross_revenue /
              NULLIF(
                ps.sold_quantity,
                0
              ),
              2
            )
              AS average_unit_revenue,

            COALESCE(
              stock.current_stock,
              0
            )
              AS current_stock,

            ps.last_sale_at,

            NULL::int
              AS days_since_last_sale

          FROM period_sales ps

          JOIN product_variants pv
            ON pv.company_id = $1
            AND pv.id =
                ps.variant_id

          JOIN products p
            ON p.company_id =
               pv.company_id

            AND p.id =
                pv.product_id

          LEFT JOIN fashion_sizes size
            ON size.company_id =
               pv.company_id

            AND size.id =
                pv.size_id

          LEFT JOIN fashion_colors color
            ON color.company_id =
               pv.company_id

            AND color.id =
                pv.color_id

          LEFT JOIN product_categories
                    category
            ON category.company_id =
               p.company_id

            AND category.id =
                p.category_id

          LEFT JOIN brands brand
            ON brand.company_id =
               p.company_id

            AND brand.id =
                p.brand_id

          LEFT JOIN current_stock stock
            ON stock.variant_id =
               pv.id

          ORDER BY
            ps.sold_quantity DESC,
            ps.gross_revenue DESC,
            p.name ASC,
            pv.sku ASC

          LIMIT $5;
          `,
            queryValues,
          ),

          db.query(
            `
          WITH period_sales AS (
            SELECT
              si.variant_id,

              COUNT(
                DISTINCT s.id
              )::int
                AS sales_count,

              SUM(si.quantity)
                AS sold_quantity,

              SUM(si.line_total)
                AS gross_revenue

            FROM sales s

            JOIN sale_items si
              ON si.company_id =
                 s.company_id

              AND si.sale_id =
                  s.id

            WHERE s.company_id = $1

              AND (
                $2::uuid IS NULL
                OR s.branch_id =
                   $2::uuid
              )

              AND s.occurred_at >=
                  $3::date

              AND s.occurred_at <
                  (
                    $4::date +
                    INTERVAL '1 day'
                  )

              AND s.status IN (
                'completed',
                'pending_review',
                'refunded'
              )

            GROUP BY
              si.variant_id
          ),

          last_sales AS (
            SELECT
              si.variant_id,

              MAX(s.occurred_at)
                AS last_sale_at

            FROM sales s

            JOIN sale_items si
              ON si.company_id =
                 s.company_id

              AND si.sale_id =
                  s.id

            WHERE s.company_id = $1

              AND (
                $2::uuid IS NULL
                OR s.branch_id =
                   $2::uuid
              )

              AND s.occurred_at <
                  (
                    $4::date +
                    INTERVAL '1 day'
                  )

              AND s.status IN (
                'completed',
                'pending_review',
                'refunded'
              )

            GROUP BY
              si.variant_id
          ),

          current_stock AS (
            SELECT
              sb.variant_id,

              SUM(sb.quantity)
                AS current_stock

            FROM stock_balances sb

            JOIN product_variants pv
              ON pv.company_id =
                 sb.company_id

              AND pv.id =
                  sb.variant_id

              AND pv.status =
                  'active'

            JOIN products p
              ON p.company_id =
                 pv.company_id

              AND p.id =
                  pv.product_id

              AND p.status =
                  'active'

            WHERE sb.company_id = $1

              AND (
                $2::uuid IS NULL
                OR sb.branch_id =
                   $2::uuid
              )

            GROUP BY
              sb.variant_id

            HAVING
              SUM(sb.quantity) > 0
          )

          SELECT
            pv.id
              AS variant_id,

            pv.product_id,

            p.name
              AS product_name,

            pv.sku,
            pv.primary_barcode,

            size.name
              AS size_name,

            color.name
              AS color_name,

            category.name
              AS category_name,

            brand.name
              AS brand_name,

            p.status
              AS product_status,

            pv.status
              AS variant_status,

            COALESCE(
              ps.sales_count,
              0
            )
              AS sales_count,

            COALESCE(
              ps.sold_quantity,
              0
            )
              AS sold_quantity,

            COALESCE(
              ps.gross_revenue,
              0
            )
              AS gross_revenue,

            CASE
              WHEN COALESCE(
                ps.sold_quantity,
                0
              ) > 0
              THEN ROUND(
                ps.gross_revenue /
                ps.sold_quantity,
                2
              )
              ELSE 0
            END
              AS average_unit_revenue,

            stock.current_stock,
            last_sale.last_sale_at,

            CASE
              WHEN
                last_sale.last_sale_at
                IS NULL
              THEN NULL

              ELSE GREATEST(
                FLOOR(
                  EXTRACT(
                    EPOCH FROM (
                      (
                        $4::date +
                        INTERVAL '1 day'
                      )::timestamptz
                      -
                      last_sale
                        .last_sale_at
                    )
                  ) /
                  86400
                )::int,
                0
              )
            END
              AS days_since_last_sale

          FROM current_stock stock

          JOIN product_variants pv
            ON pv.company_id = $1
            AND pv.id =
                stock.variant_id

          JOIN products p
            ON p.company_id =
               pv.company_id

            AND p.id =
                pv.product_id

          LEFT JOIN fashion_sizes size
            ON size.company_id =
               pv.company_id

            AND size.id =
                pv.size_id

          LEFT JOIN fashion_colors color
            ON color.company_id =
               pv.company_id

            AND color.id =
                pv.color_id

          LEFT JOIN product_categories
                    category
            ON category.company_id =
               p.company_id

            AND category.id =
                p.category_id

          LEFT JOIN brands brand
            ON brand.company_id =
               p.company_id

            AND brand.id =
                p.brand_id

          LEFT JOIN period_sales ps
            ON ps.variant_id =
               pv.id

          LEFT JOIN last_sales last_sale
            ON last_sale.variant_id =
               pv.id

          ORDER BY
            COALESCE(
              ps.sold_quantity,
              0
            ) ASC,

            last_sale.last_sale_at
              ASC NULLS FIRST,

            stock.current_stock DESC,
            p.name ASC,
            pv.sku ASC

          LIMIT $5;
          `,
            queryValues,
          ),
        ])

      const summaryRow = summaryResult.rows[0] as
        | Record<string, unknown>
        | undefined

      const topProducts = (
        topProductsResult.rows as Array<Record<string, unknown>>
      ).map(mapProductPerformanceRow)

      const slowMovingProducts = (
        slowProductsResult.rows as Array<Record<string, unknown>>
      ).map((row) => {
        const product = mapProductPerformanceRow(row)

        return {
          ...product,

          movementClass:
            Number(product.soldQuantity) === 0
              ? 'no_sales_in_period'
              : 'low_sales_in_period',
        }
      })

      return res.json({
        data: {
          filters: {
            companyId: auth.companyId,

            branchId: branchId || null,

            dateFrom,
            dateTo,
            days: reportDays,

            limit,
          },

          definitions: {
            includedSaleStatuses: ['completed', 'pending_review', 'refunded'],

            topProductsOrder: 'soldQuantity DESC, grossRevenue DESC',

            slowMovingOrder:
              'soldQuantity ASC, lastSaleAt ASC, currentStock DESC',

            stockBasis: 'Current PostgreSQL stock balance',

            salesBasis: 'Gross sale item quantities before returns',
          },

          summary: {
            salesCount: Number(summaryRow?.sales_count ?? 0),

            soldVariantCount: Number(summaryRow?.sold_variant_count ?? 0),

            soldQuantity: String(summaryRow?.sold_quantity ?? '0'),

            grossRevenue: String(summaryRow?.gross_revenue ?? '0'),

            inStockVariantCount: Number(
              summaryRow?.in_stock_variant_count ?? 0,
            ),

            currentStockQuantity: String(
              summaryRow?.current_stock_quantity ?? '0',
            ),

            noSaleStockVariantCount: Number(
              summaryRow?.no_sale_stock_variant_count ?? 0,
            ),
          },

          topProducts,
          slowMovingProducts,
        },
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// GET /api/reports/cashier-shifts
//
// يعرض سجل الورديات وSnapshot التسوية المحفوظة.
//
// Query:
// - cashierId?
// - status?
// - dateFrom?
// - dateTo?
// - limit?
// ======================================================
reportsRouter.get(
  '/api/reports/cashier-shifts',

  async (req, res, next) => {
    try {
      const auth = getAuthContext(res)

      const cashierId =
        typeof req.query.cashierId === 'string'
          ? req.query.cashierId.trim().toLowerCase()
          : ''

      if (cashierId && !uuidPattern.test(cashierId)) {
        return res.status(400).json({
          error: 'cashierId is invalid',
        })
      }

      const status =
        typeof req.query.status === 'string'
          ? req.query.status.trim().toLowerCase()
          : ''

      if (status && !allowedShiftStatuses.has(status)) {
        return res.status(400).json({
          error: 'status must be open or closed',
        })
      }

      const dateFrom =
        typeof req.query.dateFrom === 'string' ? req.query.dateFrom.trim() : ''

      const dateTo =
        typeof req.query.dateTo === 'string' ? req.query.dateTo.trim() : ''

      if (dateFrom && !isValidReportDate(dateFrom)) {
        return res.status(400).json({
          error: 'dateFrom must be a valid YYYY-MM-DD date',
        })
      }

      if (dateTo && !isValidReportDate(dateTo)) {
        return res.status(400).json({
          error: 'dateTo must be a valid YYYY-MM-DD date',
        })
      }

      if (dateFrom && dateTo && dateFrom > dateTo) {
        return res.status(400).json({
          error: 'dateFrom cannot be after dateTo',
        })
      }

      const queryParameters = [
        auth.companyId,
        auth.branchId,
        cashierId || null,
        status || null,
        dateFrom || null,
        dateTo || null,
      ]

      const [summaryResult, shiftsResult] = await Promise.all([
        db.query(
          `
          SELECT
            COUNT(*)::int
              AS total_shifts,

            COUNT(*) FILTER (
              WHERE cs.status =
                    'open'
            )::int
              AS open_shifts,

            COUNT(*) FILTER (
              WHERE cs.status =
                    'closed'
            )::int
              AS closed_shifts,

            COALESCE(
              SUM(
                cs.expected_cash
              ) FILTER (
                WHERE cs.status =
                      'closed'
              ),
              0
            )
              AS total_expected_cash,

            COALESCE(
              SUM(
                cs.closing_cash
              ) FILTER (
                WHERE cs.status =
                      'closed'
              ),
              0
            )
              AS total_closing_cash,

            COALESCE(
              SUM(
                cs.difference
              ) FILTER (
                WHERE cs.status =
                      'closed'
              ),
              0
            )
              AS total_difference

          FROM cashier_shifts cs

          WHERE cs.company_id = $1

            AND (
              $2::uuid IS NULL
              OR cs.branch_id =
                 $2::uuid
            )

            AND (
              $3::uuid IS NULL
              OR cs.cashier_id =
                 $3::uuid
            )

            AND (
              $4::text IS NULL
              OR cs.status =
                 $4::text
            )

            AND (
              $5::date IS NULL
              OR cs.opened_at >=
                 $5::date
            )

            AND (
              $6::date IS NULL
              OR cs.opened_at <
                 (
                   $6::date +
                   INTERVAL '1 day'
                 )
            );
          `,
          queryParameters,
        ),

        db.query(
          `
          SELECT
            cs.id,
            cs.company_id,
            cs.branch_id,

            b.code
              AS branch_code,

            b.name
              AS branch_name,

            cs.cashier_id,

            cashier.full_name
              AS cashier_name,

            cashier.username
              AS cashier_username,

            cs.pos_device_id,

            pd.device_code,
            pd.device_name,

            cs.shift_number,

            cs.opening_cash,
            cs.closing_cash,
            cs.expected_cash,
            cs.difference,

            cs.net_sales_cash,
            cs.cash_returns,
            cs.net_exchange_cash,

            cs.sales_count,
            cs.voided_sales_count,
            cs.returns_count,
            cs.exchanges_count,

            cs.status,
            cs.opened_at,
            cs.closed_at,

            cs.closed_by,

            closer.full_name
              AS closed_by_name,

            cs.closing_note,

            (
              cs.settlement_snapshot
              IS NOT NULL
            )
              AS has_settlement_snapshot,

            cs.settlement_snapshot
              ->> 'version'
              AS settlement_version

          FROM cashier_shifts cs

          JOIN branches b
            ON b.id =
               cs.branch_id
            AND b.company_id =
                cs.company_id

          JOIN users cashier
            ON cashier.id =
               cs.cashier_id
            AND cashier.company_id =
                cs.company_id

          LEFT JOIN pos_devices pd
            ON pd.id =
               cs.pos_device_id
            AND pd.company_id =
                cs.company_id

          LEFT JOIN users closer
            ON closer.id =
               cs.closed_by
            AND closer.company_id =
                cs.company_id

          WHERE cs.company_id = $1

            AND (
              $2::uuid IS NULL
              OR cs.branch_id =
                 $2::uuid
            )

            AND (
              $3::uuid IS NULL
              OR cs.cashier_id =
                 $3::uuid
            )

            AND (
              $4::text IS NULL
              OR cs.status =
                 $4::text
            )

            AND (
              $5::date IS NULL
              OR cs.opened_at >=
                 $5::date
            )

            AND (
              $6::date IS NULL
              OR cs.opened_at <
                 (
                   $6::date +
                   INTERVAL '1 day'
                 )
            )

          ORDER BY
            cs.opened_at DESC,
            cs.id DESC

          LIMIT $7;
          `,
          [...queryParameters, parseReportLimit(req.query.limit)],
        ),
      ])

      const summary = summaryResult.rows[0]

      return res.json({
        data: {
          filters: {
            branchId: auth.branchId,

            cashierId: cashierId || null,

            status: status || null,

            dateFrom: dateFrom || null,

            dateTo: dateTo || null,
          },

          summary: {
            totalShifts: Number(summary.total_shifts),

            openShifts: Number(summary.open_shifts),

            closedShifts: Number(summary.closed_shifts),

            totalExpectedCash: String(summary.total_expected_cash),

            totalClosingCash: String(summary.total_closing_cash),

            totalDifference: String(summary.total_difference),
          },

          shifts: shiftsResult.rows,
        },
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// GET /api/reports/cashier-shifts/:shiftId
//
// يعرض:
// - بيانات الوردية.
// - Snapshot التسوية.
// - فواتير البيع.
// - المرتجعات.
// - الاستبدالات.
//
// المرتجعات والاستبدالات تُربط بالوردية بنفس قاعدة
// التسوية الحالية:
// الفرع + الكاشير + الفترة الزمنية.
// ======================================================
reportsRouter.get(
  '/api/reports/cashier-shifts/:shiftId',

  async (req, res, next) => {
    try {
      const auth = getAuthContext(res)

      const shiftId =
        normalizeParam(req.params.shiftId)?.trim().toLowerCase() || ''

      if (!uuidPattern.test(shiftId)) {
        return res.status(400).json({
          error: 'shiftId is invalid',
        })
      }

      const shiftResult = await db.query(
        `
          SELECT
            cs.*,

            b.code
              AS branch_code,

            b.name
              AS branch_name,

            cashier.full_name
              AS cashier_name,

            cashier.username
              AS cashier_username,

            pd.device_code,
            pd.device_name,

            closer.full_name
              AS closed_by_name

          FROM cashier_shifts cs

          JOIN branches b
            ON b.id =
               cs.branch_id
            AND b.company_id =
                cs.company_id

          JOIN users cashier
            ON cashier.id =
               cs.cashier_id
            AND cashier.company_id =
                cs.company_id

          LEFT JOIN pos_devices pd
            ON pd.id =
               cs.pos_device_id
            AND pd.company_id =
                cs.company_id

          LEFT JOIN users closer
            ON closer.id =
               cs.closed_by
            AND closer.company_id =
                cs.company_id

          WHERE cs.company_id = $1
            AND cs.id = $2

            AND (
              $3::uuid IS NULL
              OR cs.branch_id =
                 $3::uuid
            )

          LIMIT 1;
          `,
        [auth.companyId, shiftId, auth.branchId],
      )

      if ((shiftResult.rowCount ?? 0) === 0) {
        return res.status(404).json({
          error: 'Cashier shift was not found or belongs to another branch',
        })
      }

      const shift = shiftResult.rows[0]

      const [salesResult, returnsResult, exchangesResult] = await Promise.all([
        db.query(
          `
          SELECT
            s.id,
            s.sale_number,
            s.source,
            s.local_sale_id,

            s.customer_id,

            c.name
              AS customer_name,

            s.subtotal,
            s.discount_total,
            s.tax_total,
            s.total,
            s.paid_total,
            s.change_total,

            s.status,
            s.occurred_at,
            s.created_at,
            s.synced_at,

            s.void_reason,
            s.voided_at,

            payment_summary
              .cash_collected,

            payment_summary
              .cash_refunded,

            (
              payment_summary
                .cash_collected
              -
              COALESCE(
                s.change_total,
                0
              )
              -
              payment_summary
                .cash_refunded
            )
              AS net_cash_effect

          FROM sales s

          LEFT JOIN customers c
            ON c.id =
               s.customer_id
            AND c.company_id =
                s.company_id

          LEFT JOIN LATERAL (
            SELECT
              COALESCE(
                SUM(p.amount) FILTER (
                  WHERE p.method =
                        'cash'

                    AND p.payment_role =
                        'sale_collection'

                    AND p.payment_direction =
                        'received_from_customer'
                ),
                0
              )
                AS cash_collected,

              COALESCE(
                SUM(p.amount) FILTER (
                  WHERE p.method =
                        'cash'

                    AND p.payment_role =
                        'void_reversal'

                    AND p.payment_direction =
                        'refunded_to_customer'
                ),
                0
              )
                AS cash_refunded

            FROM payments p

            WHERE p.company_id =
                  s.company_id

              AND p.sale_id =
                  s.id
          ) payment_summary
            ON TRUE

          WHERE s.company_id = $1
            AND s.shift_id = $2

          ORDER BY
            s.occurred_at ASC,
            s.id ASC;
          `,
          [auth.companyId, shiftId],
        ),

        db.query(
          `
          SELECT
            r.id,
            r.return_number,
            r.original_sale_id,

            original_sale.sale_number
              AS original_sale_number,

            r.customer_id,

            c.name
              AS customer_name,

            r.subtotal,
            r.refund_total,
            r.status,
            r.reason,

            r.created_at,
            r.void_reason,
            r.voided_at,

            refund_summary
              .cash_refunded,

            refund_summary
              .cash_collected,

            (
              refund_summary
                .cash_collected
              -
              refund_summary
                .cash_refunded
            )
              AS net_cash_effect

          FROM returns r

          LEFT JOIN sales
            original_sale
            ON original_sale.id =
               r.original_sale_id
            AND original_sale.company_id =
                r.company_id

          LEFT JOIN customers c
            ON c.id =
               r.customer_id
            AND c.company_id =
                r.company_id

          LEFT JOIN LATERAL (
            SELECT
              COALESCE(
                SUM(rr.amount) FILTER (
                  WHERE rr.method =
                        'cash'

                    AND rr.payment_direction =
                        'refunded_to_customer'
                ),
                0
              )
                AS cash_refunded,

              COALESCE(
                SUM(rr.amount) FILTER (
                  WHERE rr.method =
                        'cash'

                    AND rr.payment_direction =
                        'collected_from_customer'
                ),
                0
              )
                AS cash_collected

            FROM return_refunds rr

            WHERE rr.company_id =
                  r.company_id

              AND rr.return_id =
                  r.id
          ) refund_summary
            ON TRUE

          WHERE r.company_id = $1
            AND r.branch_id = $2
            AND r.created_by = $3

            AND r.created_at >=
                $4::timestamptz

            AND r.created_at <=
                COALESCE(
                  $5::timestamptz,
                  NOW()
                )

          ORDER BY
            r.created_at ASC,
            r.id ASC;
          `,
          [
            auth.companyId,
            shift.branch_id,
            shift.cashier_id,
            shift.opened_at,
            shift.closed_at,
          ],
        ),

        db.query(
          `
          SELECT
            e.id,
            e.exchange_number,
            e.original_sale_id,

            original_sale.sale_number
              AS original_sale_number,

            e.customer_id,

            c.name
              AS customer_name,

            e.returned_total,
            e.issued_total,
            e.difference_total,

            e.paid_difference_total,
            e.refunded_difference_total,

            e.status,
            e.reason,

            e.created_at,
            e.void_reason,
            e.voided_at,

            payment_summary
              .net_cash_effect

          FROM exchanges e

          LEFT JOIN sales
            original_sale
            ON original_sale.id =
               e.original_sale_id
            AND original_sale.company_id =
                e.company_id

          LEFT JOIN customers c
            ON c.id =
               e.customer_id
            AND c.company_id =
                e.company_id

          LEFT JOIN LATERAL (
            SELECT
              COALESCE(
                SUM(
                  CASE
                    WHEN ep.method =
                         'cash'
                     AND ep.payment_direction =
                         'paid_by_customer'
                    THEN ep.amount

                    WHEN ep.method =
                         'cash'
                     AND ep.payment_direction =
                         'refunded_to_customer'
                    THEN -ep.amount

                    ELSE 0
                  END
                ),
                0
              )
                AS net_cash_effect

            FROM exchange_payments ep

            WHERE ep.company_id =
                  e.company_id

              AND ep.exchange_id =
                  e.id
          ) payment_summary
            ON TRUE

          WHERE e.company_id = $1
            AND e.branch_id = $2
            AND e.created_by = $3

            AND e.created_at >=
                $4::timestamptz

            AND e.created_at <=
                COALESCE(
                  $5::timestamptz,
                  NOW()
                )

          ORDER BY
            e.created_at ASC,
            e.id ASC;
          `,
          [
            auth.companyId,
            shift.branch_id,
            shift.cashier_id,
            shift.opened_at,
            shift.closed_at,
          ],
        ),
      ])

      return res.json({
        data: {
          shift,

          settlement: {
            snapshot: shift.settlement_snapshot,

            isFinal:
              shift.status === 'closed' && shift.settlement_snapshot !== null,

            version: shift.settlement_snapshot?.version ?? null,
          },

          documents: {
            sales: salesResult.rows,

            returns: returnsResult.rows,

            exchanges: exchangesResult.rows,
          },
        },
      })
    } catch (error) {
      return next(error)
    }
  },
)
