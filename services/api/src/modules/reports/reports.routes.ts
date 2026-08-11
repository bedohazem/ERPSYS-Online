import { Router } from 'express'
import { db } from '../../db/pool'
import { getAuthContext } from '../auth/auth.middleware'

export const reportsRouter = Router()

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const allowedShiftStatuses = new Set(['open', 'closed'])

const allowedInventoryShortageStatuses = new Set([
  'alerts',
  'critical',
  'low',
  'healthy',
  'all',
])

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

      const branchOptionsResult = await db.query(
        `
        SELECT
          id,
          code,
          name,
          is_active

        FROM branches

        WHERE company_id = $1

          AND (
            $2::uuid IS NULL
            OR id = $2::uuid
          )

        ORDER BY
          is_active DESC,
          name ASC,
          code ASC;
        `,
        [auth.companyId, auth.branchId || null],
      )

      const baseQueryValues = [
        auth.companyId,
        branchId || null,
        dateFrom,
        dateTo,
      ]

      const limitedQueryValues = [...baseQueryValues, limit]

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
            baseQueryValues,
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
            limitedQueryValues,
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
            limitedQueryValues,
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

            branchSelectionLocked: Boolean(auth.branchId),

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

          branchOptions: branchOptionsResult.rows.map((row) => ({
            id: String(row.id),
            code: String(row.code),
            name: String(row.name),
            isActive: Boolean(row.is_active),
          })),

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
// GET /api/reports/profitability
//
// تقرير ربحية المبيعات بناءً على Cost Snapshots
// المحفوظة داخل sale_items.
//
// Query:
// - dateFrom: YYYY-MM-DD
// - dateTo: YYYY-MM-DD
// - branchId?
// - cashierId?
// - limit?
//
// يرجع:
// - summary
// - byDay
// - byBranch
// - byCashier
// - topProducts
// ======================================================
reportsRouter.get(
  '/api/reports/profitability',

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

      const requestedBranchId =
        typeof req.query.branchId === 'string'
          ? req.query.branchId.trim().toLowerCase()
          : ''

      if (requestedBranchId && !uuidPattern.test(requestedBranchId)) {
        return res.status(400).json({
          error: 'branchId is invalid',
        })
      }

      if (
        auth.branchId &&
        requestedBranchId &&
        requestedBranchId !== auth.branchId
      ) {
        return res.status(403).json({
          error: 'Requested branch is outside the authenticated branch scope',
        })
      }

      const branchId = auth.branchId || requestedBranchId || ''

      const cashierId =
        typeof req.query.cashierId === 'string'
          ? req.query.cashierId.trim().toLowerCase()
          : ''

      if (cashierId && !uuidPattern.test(cashierId)) {
        return res.status(400).json({
          error: 'cashierId is invalid',
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
        WITH sale_lines AS (
          SELECT
            s.id
              AS sale_id,

            s.occurred_at::date
              AS event_date,

            s.branch_id,
            s.cashier_id,

            si.variant_id,

            si.quantity,

            si.line_total
              AS gross_revenue,

            COALESCE(
              si.cost_total_snapshot,
              0
            )
              AS total_cost,

            COALESCE(
              si.gross_profit_snapshot,
              (
                si.line_total -
                COALESCE(
                  si.cost_total_snapshot,
                  0
                )
              )
            )
              AS gross_profit,

            CASE
              WHEN si.cost_total_snapshot IS NULL
                OR si.gross_profit_snapshot IS NULL
              THEN 1
              ELSE 0
            END
              AS missing_cost_snapshot

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
              'refunded'
            )
        ),

        grouped AS (
          SELECT
            event_date,
            branch_id,
            cashier_id,
            variant_id,

            GROUPING(event_date)::int
              AS grouped_date,

            GROUPING(branch_id)::int
              AS grouped_branch,

            GROUPING(cashier_id)::int
              AS grouped_cashier,

            GROUPING(variant_id)::int
              AS grouped_variant,

            COUNT(
              DISTINCT sale_id
            )::int
              AS sales_count,

            COUNT(*)::int
              AS line_count,

            COALESCE(
              SUM(quantity),
              0
            )
              AS sold_quantity,

            COALESCE(
              SUM(gross_revenue),
              0
            )
              AS gross_revenue,

            COALESCE(
              SUM(total_cost),
              0
            )
              AS total_cost,

            COALESCE(
              SUM(gross_profit),
              0
            )
              AS gross_profit,

            COALESCE(
              SUM(missing_cost_snapshot),
              0
            )::int
              AS missing_cost_snapshot_lines

          FROM sale_lines

          GROUP BY GROUPING SETS (
            (),
            (event_date),
            (branch_id),
            (cashier_id),
            (variant_id)
          )
        )

        SELECT
          CASE
            WHEN grouped_date = 1
             AND grouped_branch = 1
             AND grouped_cashier = 1
             AND grouped_variant = 1
            THEN 'summary'

            WHEN grouped_date = 0
            THEN 'day'

            WHEN grouped_branch = 0
            THEN 'branch'

            WHEN grouped_cashier = 0
            THEN 'cashier'

            ELSE 'product'
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

          branch.code
            AS branch_code,

          branch.name
            AS branch_name,

          g.cashier_id,

          cashier.full_name
            AS cashier_name,

          cashier.username
            AS cashier_username,

          g.variant_id,

          pv.product_id,

          p.name
            AS product_name,

          pv.sku,

          pv.primary_barcode,

          size.name
            AS size_name,

          color.name
            AS color_name,

          g.sales_count,
          g.line_count,
          g.sold_quantity,

          g.gross_revenue,
          g.total_cost,
          g.gross_profit,

          CASE
            WHEN g.gross_revenue <> 0
            THEN ROUND(
              (
                g.gross_profit /
                g.gross_revenue
              ) * 100,
              4
            )
            ELSE 0
          END
            AS gross_margin_percent,

          g.missing_cost_snapshot_lines

        FROM grouped g

        LEFT JOIN branches branch
          ON branch.company_id = $1
          AND branch.id =
              g.branch_id

        LEFT JOIN users cashier
          ON cashier.company_id = $1
          AND cashier.id =
              g.cashier_id

        LEFT JOIN product_variants pv
          ON pv.company_id = $1
          AND pv.id =
              g.variant_id

        LEFT JOIN products p
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

        ORDER BY
          group_type ASC,
          period_date ASC NULLS LAST,
          branch_name ASC NULLS LAST,
          cashier_name ASC NULLS LAST,
          gross_profit DESC,
          product_name ASC NULLS LAST,
          sku ASC NULLS LAST;
        `,
        [auth.companyId, branchId || null, cashierId || null, dateFrom, dateTo],
      )

      function mapProfitMetrics(row: Record<string, unknown> | undefined) {
        return {
          salesCount: Number(row?.sales_count ?? 0),

          lineCount: Number(row?.line_count ?? 0),

          soldQuantity: String(row?.sold_quantity ?? '0'),

          grossRevenue: String(row?.gross_revenue ?? '0'),

          totalCost: String(row?.total_cost ?? '0'),

          grossProfit: String(row?.gross_profit ?? '0'),

          grossMarginPercent: String(row?.gross_margin_percent ?? '0'),

          missingCostSnapshotLines: Number(
            row?.missing_cost_snapshot_lines ?? 0,
          ),
        }
      }

      const rows = result.rows as Array<Record<string, unknown>>

      const summaryRow = rows.find((row) => row.group_type === 'summary')

      const byDay = rows
        .filter((row) => row.group_type === 'day')
        .map((row) => ({
          date: String(row.period_date ?? ''),

          ...mapProfitMetrics(row),
        }))
        .sort((first, second) => first.date.localeCompare(second.date))

      const byBranch = rows
        .filter((row) => row.group_type === 'branch')
        .map((row) => ({
          branchId: typeof row.branch_id === 'string' ? row.branch_id : null,

          branchCode:
            typeof row.branch_code === 'string' ? row.branch_code : null,

          branchName:
            typeof row.branch_name === 'string'
              ? row.branch_name
              : 'Unknown branch',

          ...mapProfitMetrics(row),
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

          ...mapProfitMetrics(row),
        }))
        .sort((first, second) =>
          first.cashierName.localeCompare(second.cashierName),
        )

      const topProducts = rows
        .filter((row) => row.group_type === 'product')
        .map((row) => ({
          variantId: typeof row.variant_id === 'string' ? row.variant_id : null,

          productId: typeof row.product_id === 'string' ? row.product_id : null,

          productName:
            typeof row.product_name === 'string'
              ? row.product_name
              : 'Unknown product',

          sku: typeof row.sku === 'string' ? row.sku : null,

          primaryBarcode:
            typeof row.primary_barcode === 'string'
              ? row.primary_barcode
              : null,

          sizeName: typeof row.size_name === 'string' ? row.size_name : null,

          colorName: typeof row.color_name === 'string' ? row.color_name : null,

          ...mapProfitMetrics(row),
        }))
        .sort((first, second) => {
          const profitDifference =
            Number(second.grossProfit) - Number(first.grossProfit)

          if (profitDifference !== 0) {
            return profitDifference
          }

          return first.productName.localeCompare(second.productName)
        })
        .slice(0, limit)

      return res.json({
        data: {
          filters: {
            companyId: auth.companyId,

            branchId: branchId || null,

            branchSelectionLocked: Boolean(auth.branchId),

            cashierId: cashierId || null,

            dateFrom,
            dateTo,
            days: reportDays,

            limit,
          },

          definitions: {
            includedSaleStatuses: ['completed', 'pending_review', 'refunded'],

            revenueBasis: 'sale_items.line_total',

            costBasis: 'sale_items.cost_total_snapshot',

            profitFormula: 'grossRevenue - totalCost',

            grossMarginFormula: '(grossProfit / grossRevenue) * 100',

            missingCostSnapshotMeaning:
              'Older sale lines created before costing snapshots may not have stored cost fields',
          },

          summary: mapProfitMetrics(summaryRow),

          byDay,
          byBranch,
          byCashier,
          topProducts,
        },
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// GET /api/reports/stock-valuation
//
// تقرير تقييم المخزون الحالي بناءً على:
// stock_balances.quantity
// stock_balances.average_cost
//
// Query:
// - branchId?
// - stockLocationId?
// - status? positive | zero | negative | all
// - search?
// - limit?
//
// يرجع:
// - summary
// - byBranch
// - byLocation
// - byCategory
// - topItems
// ======================================================
reportsRouter.get(
  '/api/reports/stock-valuation',

  async (req, res, next) => {
    try {
      const auth = getAuthContext(res)

      const requestedBranchId =
        typeof req.query.branchId === 'string'
          ? req.query.branchId.trim().toLowerCase()
          : ''

      if (requestedBranchId && !uuidPattern.test(requestedBranchId)) {
        return res.status(400).json({
          error: 'branchId is invalid',
        })
      }

      if (
        auth.branchId &&
        requestedBranchId &&
        requestedBranchId !== auth.branchId
      ) {
        return res.status(403).json({
          error: 'Requested branch is outside the authenticated branch scope',
        })
      }

      const branchId = auth.branchId || requestedBranchId || ''

      const stockLocationId =
        typeof req.query.stockLocationId === 'string'
          ? req.query.stockLocationId.trim().toLowerCase()
          : ''

      if (stockLocationId && !uuidPattern.test(stockLocationId)) {
        return res.status(400).json({
          error: 'stockLocationId is invalid',
        })
      }

      const valuationStatus =
        typeof req.query.status === 'string'
          ? req.query.status.trim().toLowerCase()
          : 'positive'

      if (!['positive', 'zero', 'negative', 'all'].includes(valuationStatus)) {
        return res.status(400).json({
          error: 'status must be positive, zero, negative, or all',
        })
      }

      const search =
        typeof req.query.search === 'string' && req.query.search.trim()
          ? req.query.search.trim()
          : ''

      const searchPattern = search ? `%${search}%` : null

      const limit = parseReportLimit(req.query.limit)

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

      if (stockLocationId) {
        const locationResult = await db.query(
          `
          SELECT id

          FROM stock_locations

          WHERE company_id = $1
            AND id = $2

            AND (
              $3::uuid IS NULL
              OR branch_id =
                 $3::uuid
            )

          LIMIT 1;
          `,
          [auth.companyId, stockLocationId, branchId || null],
        )

        if ((locationResult.rowCount ?? 0) === 0) {
          return res.status(404).json({
            error:
              'Stock location was not found or is outside the authenticated branch scope',
          })
        }
      }

      const result = await db.query(
        `
        WITH valuation_lines AS (
          SELECT
            sb.branch_id,
            sb.stock_location_id,
            sb.variant_id,

            pv.product_id,

            p.category_id,
            p.brand_id,

            sb.quantity,

            COALESCE(
              sb.average_cost,
              0
            )
              AS average_cost,

            ROUND(
              (
                sb.quantity *
                COALESCE(
                  sb.average_cost,
                  0
                )
              )::numeric,
              2
            )
              AS inventory_value

          FROM stock_balances sb

          JOIN stock_locations sl
            ON sl.company_id =
               sb.company_id
            AND sl.id =
                sb.stock_location_id

          JOIN product_variants pv
            ON pv.company_id =
               sb.company_id
            AND pv.id =
                sb.variant_id

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

          LEFT JOIN product_categories category
            ON category.company_id =
               p.company_id
            AND category.id =
                p.category_id

          LEFT JOIN brands brand
            ON brand.company_id =
               p.company_id
            AND brand.id =
                p.brand_id

          WHERE sb.company_id = $1

            AND (
              $2::uuid IS NULL
              OR sb.branch_id =
                 $2::uuid
            )

            AND (
              $3::uuid IS NULL
              OR sb.stock_location_id =
                 $3::uuid
            )

            AND (
              $4::text = 'all'

              OR (
                $4::text = 'positive'
                AND sb.quantity > 0
              )

              OR (
                $4::text = 'zero'
                AND sb.quantity = 0
              )

              OR (
                $4::text = 'negative'
                AND sb.quantity < 0
              )
            )

            AND (
              $5::text IS NULL

              OR p.name ILIKE $5::text

              OR pv.sku ILIKE $5::text

              OR COALESCE(
                   pv.primary_barcode,
                   ''
                 ) ILIKE $5::text

              OR sl.name ILIKE $5::text

              OR sl.code ILIKE $5::text

              OR COALESCE(
                   category.name,
                   ''
                 ) ILIKE $5::text

              OR COALESCE(
                   brand.name,
                   ''
                 ) ILIKE $5::text

              OR COALESCE(
                   size.name,
                   ''
                 ) ILIKE $5::text

              OR COALESCE(
                   color.name,
                   ''
                 ) ILIKE $5::text
            )
        ),

        grouped AS (
          SELECT
            branch_id,
            stock_location_id,
            category_id,
            variant_id,

            GROUPING(branch_id)::int
              AS grouped_branch,

            GROUPING(stock_location_id)::int
              AS grouped_location,

            GROUPING(category_id)::int
              AS grouped_category,

            GROUPING(variant_id)::int
              AS grouped_variant,

            COUNT(*)::int
              AS line_count,

            COUNT(
              DISTINCT variant_id
            )::int
              AS variant_count,

            COUNT(
              DISTINCT stock_location_id
            )::int
              AS stock_location_count,

            COALESCE(
              SUM(quantity),
              0
            )
              AS total_quantity,

            CASE
              WHEN COALESCE(
                SUM(quantity),
                0
              ) <> 0
              THEN ROUND(
                (
                  COALESCE(
                    SUM(inventory_value),
                    0
                  ) /
                  NULLIF(
                    SUM(quantity),
                    0
                  )
                )::numeric,
                4
              )
              ELSE 0
            END
              AS weighted_average_cost,

            COALESCE(
              SUM(inventory_value),
              0
            )
              AS inventory_value,

            COALESCE(
              SUM(
                CASE
                  WHEN quantity < 0
                  THEN 1
                  ELSE 0
                END
              ),
              0
            )::int
              AS negative_quantity_lines,

            COALESCE(
              SUM(
                CASE
                  WHEN quantity <> 0
                   AND average_cost = 0
                  THEN 1
                  ELSE 0
                END
              ),
              0
            )::int
              AS zero_cost_quantity_lines

          FROM valuation_lines

          GROUP BY GROUPING SETS (
            (),
            (branch_id),
            (stock_location_id),
            (category_id),
            (stock_location_id, variant_id)
          )
        )

        SELECT
          CASE
            WHEN grouped_branch = 1
             AND grouped_location = 1
             AND grouped_category = 1
             AND grouped_variant = 1
            THEN 'summary'

            WHEN grouped_variant = 0
            THEN 'item'

            WHEN grouped_location = 0
            THEN 'location'

            WHEN grouped_branch = 0
            THEN 'branch'

            ELSE 'category'
          END
            AS group_type,

          COALESCE(
            g.branch_id,
            item_location.branch_id
          )
            AS branch_id,

          branch.code
            AS branch_code,

          branch.name
            AS branch_name,

          g.stock_location_id,

          item_location.code
            AS stock_location_code,

          item_location.name
            AS stock_location_name,

          item_location.location_type,

          g.category_id,

          category.name
            AS category_name,

          g.variant_id,

          pv.product_id,

          p.name
            AS product_name,

          pv.sku,

          pv.primary_barcode,

          size.name
            AS size_name,

          color.name
            AS color_name,

          brand.name
            AS brand_name,

          p.status
            AS product_status,

          pv.status
            AS variant_status,

          g.line_count,
          g.variant_count,
          g.stock_location_count,

          g.total_quantity,
          g.weighted_average_cost,
          g.inventory_value,

          g.negative_quantity_lines,
          g.zero_cost_quantity_lines

        FROM grouped g

        LEFT JOIN stock_locations item_location
          ON item_location.company_id = $1
          AND item_location.id =
              g.stock_location_id

        LEFT JOIN branches branch
          ON branch.company_id = $1
          AND branch.id =
              COALESCE(
                g.branch_id,
                item_location.branch_id
              )

        LEFT JOIN product_categories category
          ON category.company_id = $1
          AND category.id =
              g.category_id

        LEFT JOIN product_variants pv
          ON pv.company_id = $1
          AND pv.id =
              g.variant_id

        LEFT JOIN products p
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

        LEFT JOIN brands brand
          ON brand.company_id =
             p.company_id
          AND brand.id =
              p.brand_id

        ORDER BY
          group_type ASC,
          inventory_value DESC,
          branch_name ASC NULLS LAST,
          stock_location_name ASC NULLS LAST,
          category_name ASC NULLS LAST,
          product_name ASC NULLS LAST,
          sku ASC NULLS LAST;
        `,
        [
          auth.companyId,
          branchId || null,
          stockLocationId || null,
          valuationStatus,
          searchPattern,
        ],
      )

      function mapValuationMetrics(row: Record<string, unknown> | undefined) {
        return {
          lineCount: Number(row?.line_count ?? 0),

          variantCount: Number(row?.variant_count ?? 0),

          stockLocationCount: Number(row?.stock_location_count ?? 0),

          totalQuantity: String(row?.total_quantity ?? '0'),

          weightedAverageCost: String(row?.weighted_average_cost ?? '0'),

          inventoryValue: String(row?.inventory_value ?? '0'),

          negativeQuantityLines: Number(row?.negative_quantity_lines ?? 0),

          zeroCostQuantityLines: Number(row?.zero_cost_quantity_lines ?? 0),
        }
      }

      const rows = result.rows as Array<Record<string, unknown>>

      const summaryRow = rows.find((row) => row.group_type === 'summary')

      const byBranch = rows
        .filter((row) => row.group_type === 'branch')
        .map((row) => ({
          branchId: typeof row.branch_id === 'string' ? row.branch_id : null,

          branchCode:
            typeof row.branch_code === 'string' ? row.branch_code : null,

          branchName:
            typeof row.branch_name === 'string' ? row.branch_name : 'No branch',

          ...mapValuationMetrics(row),
        }))
        .sort((first, second) =>
          first.branchName.localeCompare(second.branchName),
        )

      const byLocation = rows
        .filter((row) => row.group_type === 'location')
        .map((row) => ({
          stockLocationId:
            typeof row.stock_location_id === 'string'
              ? row.stock_location_id
              : null,

          stockLocationCode:
            typeof row.stock_location_code === 'string'
              ? row.stock_location_code
              : null,

          stockLocationName:
            typeof row.stock_location_name === 'string'
              ? row.stock_location_name
              : 'Unknown location',

          locationType:
            typeof row.location_type === 'string' ? row.location_type : null,

          branchId: typeof row.branch_id === 'string' ? row.branch_id : null,

          branchName:
            typeof row.branch_name === 'string' ? row.branch_name : null,

          ...mapValuationMetrics(row),
        }))
        .sort((first, second) =>
          first.stockLocationName.localeCompare(second.stockLocationName),
        )

      const byCategory = rows
        .filter((row) => row.group_type === 'category')
        .map((row) => ({
          categoryId:
            typeof row.category_id === 'string' ? row.category_id : null,

          categoryName:
            typeof row.category_name === 'string'
              ? row.category_name
              : 'Uncategorized',

          ...mapValuationMetrics(row),
        }))
        .sort((first, second) =>
          first.categoryName.localeCompare(second.categoryName),
        )

      const topItems = rows
        .filter((row) => row.group_type === 'item')
        .map((row) => ({
          stockLocationId:
            typeof row.stock_location_id === 'string'
              ? row.stock_location_id
              : null,

          stockLocationName:
            typeof row.stock_location_name === 'string'
              ? row.stock_location_name
              : 'Unknown location',

          branchId: typeof row.branch_id === 'string' ? row.branch_id : null,

          branchName:
            typeof row.branch_name === 'string' ? row.branch_name : null,

          variantId: typeof row.variant_id === 'string' ? row.variant_id : null,

          productId: typeof row.product_id === 'string' ? row.product_id : null,

          productName:
            typeof row.product_name === 'string'
              ? row.product_name
              : 'Unknown product',

          sku: typeof row.sku === 'string' ? row.sku : null,

          primaryBarcode:
            typeof row.primary_barcode === 'string'
              ? row.primary_barcode
              : null,

          sizeName: typeof row.size_name === 'string' ? row.size_name : null,

          colorName: typeof row.color_name === 'string' ? row.color_name : null,

          brandName: typeof row.brand_name === 'string' ? row.brand_name : null,

          productStatus:
            typeof row.product_status === 'string' ? row.product_status : null,

          variantStatus:
            typeof row.variant_status === 'string' ? row.variant_status : null,

          ...mapValuationMetrics(row),
        }))
        .sort((first, second) => {
          const valueDifference =
            Number(second.inventoryValue) - Number(first.inventoryValue)

          if (valueDifference !== 0) {
            return valueDifference
          }

          return first.productName.localeCompare(second.productName)
        })
        .slice(0, limit)

      return res.json({
        data: {
          filters: {
            companyId: auth.companyId,

            branchId: branchId || null,

            branchSelectionLocked: Boolean(auth.branchId),

            stockLocationId: stockLocationId || null,

            status: valuationStatus,

            search: search || null,

            limit,
          },

          definitions: {
            quantityBasis: 'stock_balances.quantity',

            costBasis: 'stock_balances.average_cost',

            inventoryValueFormula: 'quantity * averageCost',

            statusPositive: 'quantity > 0',

            statusZero: 'quantity = 0',

            statusNegative: 'quantity < 0',

            zeroCostQuantityLinesMeaning:
              'Lines with non-zero quantity but average cost equal to zero',
          },

          summary: mapValuationMetrics(summaryRow),

          byBranch,
          byLocation,
          byCategory,
          topItems,
        },
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// GET /api/reports/inventory-movement-ledger
//
// تقرير دفتر حركات المخزون.
//
// Query:
// - dateFrom: YYYY-MM-DD
// - dateTo: YYYY-MM-DD
// - branchId?
// - stockLocationId?
// - variantId?
// - movementType?
// - referenceType?
// - search?
// - page?
// - pageSize?
//
// يرجع:
// - summary
// - byMovementType
// - movements
// - pagination
// ======================================================
reportsRouter.get(
  '/api/reports/inventory-movement-ledger',

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

      const requestedBranchId =
        typeof req.query.branchId === 'string'
          ? req.query.branchId.trim().toLowerCase()
          : ''

      if (requestedBranchId && !uuidPattern.test(requestedBranchId)) {
        return res.status(400).json({
          error: 'branchId is invalid',
        })
      }

      if (
        auth.branchId &&
        requestedBranchId &&
        requestedBranchId !== auth.branchId
      ) {
        return res.status(403).json({
          error: 'Requested branch is outside the authenticated branch scope',
        })
      }

      const branchId = auth.branchId || requestedBranchId || ''

      const stockLocationId =
        typeof req.query.stockLocationId === 'string'
          ? req.query.stockLocationId.trim().toLowerCase()
          : ''

      if (stockLocationId && !uuidPattern.test(stockLocationId)) {
        return res.status(400).json({
          error: 'stockLocationId is invalid',
        })
      }

      const variantId =
        typeof req.query.variantId === 'string'
          ? req.query.variantId.trim().toLowerCase()
          : ''

      if (variantId && !uuidPattern.test(variantId)) {
        return res.status(400).json({
          error: 'variantId is invalid',
        })
      }

      const movementType =
        typeof req.query.movementType === 'string' &&
        req.query.movementType.trim()
          ? req.query.movementType.trim().toLowerCase()
          : ''

      const referenceType =
        typeof req.query.referenceType === 'string' &&
        req.query.referenceType.trim()
          ? req.query.referenceType.trim().toLowerCase()
          : ''

      const search =
        typeof req.query.search === 'string' && req.query.search.trim()
          ? req.query.search.trim()
          : ''

      const searchPattern = search ? `%${search}%` : null

      const rawPage = Number(req.query.page ?? 1)

      const page = Number.isFinite(rawPage)
        ? Math.max(Math.trunc(rawPage), 1)
        : 1

      const rawPageSize = Number(req.query.pageSize ?? 50)

      const pageSize = Number.isFinite(rawPageSize)
        ? Math.min(Math.max(Math.trunc(rawPageSize), 1), 100)
        : 50

      const offset = (page - 1) * pageSize

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

      if (stockLocationId) {
        const locationResult = await db.query(
          `
          SELECT id

          FROM stock_locations

          WHERE company_id = $1
            AND id = $2

            AND (
              $3::uuid IS NULL
              OR branch_id =
                 $3::uuid
            )

          LIMIT 1;
          `,
          [auth.companyId, stockLocationId, branchId || null],
        )

        if ((locationResult.rowCount ?? 0) === 0) {
          return res.status(404).json({
            error:
              'Stock location was not found or is outside the authenticated branch scope',
          })
        }
      }

      if (variantId) {
        const variantResult = await db.query(
          `
          SELECT id

          FROM product_variants

          WHERE company_id = $1
            AND id = $2

          LIMIT 1;
          `,
          [auth.companyId, variantId],
        )

        if ((variantResult.rowCount ?? 0) === 0) {
          return res.status(404).json({
            error: 'Variant was not found in the authenticated company',
          })
        }
      }

      const baseValues = [
        auth.companyId,
        branchId || null,
        stockLocationId || null,
        variantId || null,
        movementType || null,
        referenceType || null,
        dateFrom,
        dateTo,
        searchPattern,
      ]

      const movementScopeSql = `
        SELECT
          sm.id,
          sm.company_id,
          sm.branch_id,

          branch.code
            AS branch_code,

          branch.name
            AS branch_name,

          sm.stock_location_id,

          sl.code
            AS stock_location_code,

          sl.name
            AS stock_location_name,

          sl.location_type,

          sm.variant_id,

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

          sm.movement_type,
          sm.quantity,
          sm.quantity_before,
          sm.quantity_after,

          sm.unit_cost,
          sm.average_cost_before,
          sm.average_cost_after,
          sm.inventory_value_before,
          sm.inventory_value_after,

          sm.reference_type,
          sm.reference_id,

          sm.note,

          sm.created_by,

          creator.full_name
            AS created_by_name,

          creator.username
            AS created_by_username,

          sm.created_at

        FROM stock_movements sm

        JOIN stock_locations sl
          ON sl.company_id =
             sm.company_id
          AND sl.id =
              sm.stock_location_id

        LEFT JOIN branches branch
          ON branch.company_id =
             sm.company_id
          AND branch.id =
              sm.branch_id

        JOIN product_variants pv
          ON pv.company_id =
             sm.company_id
          AND pv.id =
              sm.variant_id

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

        LEFT JOIN product_categories category
          ON category.company_id =
             p.company_id
          AND category.id =
              p.category_id

        LEFT JOIN brands brand
          ON brand.company_id =
             p.company_id
          AND brand.id =
              p.brand_id

        LEFT JOIN users creator
          ON creator.company_id =
             sm.company_id
          AND creator.id =
              sm.created_by

        WHERE sm.company_id = $1

          AND (
            $2::uuid IS NULL
            OR sm.branch_id =
               $2::uuid
          )

          AND (
            $3::uuid IS NULL
            OR sm.stock_location_id =
               $3::uuid
          )

          AND (
            $4::uuid IS NULL
            OR sm.variant_id =
               $4::uuid
          )

          AND (
            $5::text IS NULL
            OR sm.movement_type =
               $5::text
          )

          AND (
            $6::text IS NULL
            OR sm.reference_type =
               $6::text
          )

          AND sm.created_at >=
              $7::date

          AND sm.created_at <
              (
                $8::date +
                INTERVAL '1 day'
              )

          AND (
            $9::text IS NULL

            OR p.name ILIKE $9::text

            OR pv.sku ILIKE $9::text

            OR COALESCE(
                 pv.primary_barcode,
                 ''
               ) ILIKE $9::text

            OR sl.name ILIKE $9::text

            OR sl.code ILIKE $9::text

            OR COALESCE(
                 branch.name,
                 ''
               ) ILIKE $9::text

            OR COALESCE(
                 category.name,
                 ''
               ) ILIKE $9::text

            OR COALESCE(
                 brand.name,
                 ''
               ) ILIKE $9::text

            OR COALESCE(
                 sm.reference_type,
                 ''
               ) ILIKE $9::text

            OR COALESCE(
                 sm.note,
                 ''
               ) ILIKE $9::text
          )
      `

      const [summaryResult, byMovementTypeResult, movementsResult] =
        await Promise.all([
          db.query(
            `
            WITH movement_rows AS (
              ${movementScopeSql}
            )

            SELECT
              COUNT(*)::int
                AS total_movements,

              COUNT(
                DISTINCT variant_id
              )::int
                AS variant_count,

              COUNT(
                DISTINCT stock_location_id
              )::int
                AS stock_location_count,

              COALESCE(
                SUM(
                  CASE
                    WHEN quantity > 0
                    THEN quantity
                    ELSE 0
                  END
                ),
                0
              )
                AS incoming_quantity,

              COALESCE(
                SUM(
                  CASE
                    WHEN quantity < 0
                    THEN ABS(quantity)
                    ELSE 0
                  END
                ),
                0
              )
                AS outgoing_quantity,

              COALESCE(
                SUM(quantity),
                0
              )
                AS net_quantity,

              COALESCE(
                SUM(
                  COALESCE(
                    inventory_value_after,
                    0
                  )
                  -
                  COALESCE(
                    inventory_value_before,
                    0
                  )
                ),
                0
              )
                AS inventory_value_delta,

              COUNT(*) FILTER (
                WHERE unit_cost IS NOT NULL
                  OR average_cost_before IS NOT NULL
                  OR average_cost_after IS NOT NULL
                  OR inventory_value_before IS NOT NULL
                  OR inventory_value_after IS NOT NULL
              )::int
                AS costed_movement_count,

              COUNT(*) FILTER (
                WHERE unit_cost IS NULL
                  AND average_cost_before IS NULL
                  AND average_cost_after IS NULL
                  AND inventory_value_before IS NULL
                  AND inventory_value_after IS NULL
              )::int
                AS missing_cost_movement_count,

              MIN(created_at)
                AS first_movement_at,

              MAX(created_at)
                AS last_movement_at

            FROM movement_rows;
            `,
            baseValues,
          ),

          db.query(
            `
            WITH movement_rows AS (
              ${movementScopeSql}
            )

            SELECT
              movement_type,

              COUNT(*)::int
                AS movement_count,

              COALESCE(
                SUM(
                  CASE
                    WHEN quantity > 0
                    THEN quantity
                    ELSE 0
                  END
                ),
                0
              )
                AS incoming_quantity,

              COALESCE(
                SUM(
                  CASE
                    WHEN quantity < 0
                    THEN ABS(quantity)
                    ELSE 0
                  END
                ),
                0
              )
                AS outgoing_quantity,

              COALESCE(
                SUM(quantity),
                0
              )
                AS net_quantity,

              COALESCE(
                SUM(
                  COALESCE(
                    inventory_value_after,
                    0
                  )
                  -
                  COALESCE(
                    inventory_value_before,
                    0
                  )
                ),
                0
              )
                AS inventory_value_delta

            FROM movement_rows

            GROUP BY
              movement_type

            ORDER BY
              movement_count DESC,
              movement_type ASC;
            `,
            baseValues,
          ),

          db.query(
            `
            WITH movement_rows AS (
              ${movementScopeSql}
            )

            SELECT *

            FROM movement_rows

            ORDER BY
              created_at DESC,
              id DESC

            LIMIT $10
            OFFSET $11;
            `,
            [...baseValues, pageSize, offset],
          ),
        ])

      const summaryRow = summaryResult.rows[0] as
        | Record<string, unknown>
        | undefined

      const totalItems = Number(summaryRow?.total_movements ?? 0)

      const totalPages = totalItems > 0 ? Math.ceil(totalItems / pageSize) : 0

      const summary = {
        totalMovements: totalItems,

        variantCount: Number(summaryRow?.variant_count ?? 0),

        stockLocationCount: Number(summaryRow?.stock_location_count ?? 0),

        incomingQuantity: String(summaryRow?.incoming_quantity ?? '0'),

        outgoingQuantity: String(summaryRow?.outgoing_quantity ?? '0'),

        netQuantity: String(summaryRow?.net_quantity ?? '0'),

        inventoryValueDelta: String(summaryRow?.inventory_value_delta ?? '0'),

        costedMovementCount: Number(summaryRow?.costed_movement_count ?? 0),

        missingCostMovementCount: Number(
          summaryRow?.missing_cost_movement_count ?? 0,
        ),

        firstMovementAt: serializeReportTimestamp(
          summaryRow?.first_movement_at,
        ),

        lastMovementAt: serializeReportTimestamp(summaryRow?.last_movement_at),
      }

      const byMovementType = (
        byMovementTypeResult.rows as Array<Record<string, unknown>>
      ).map((row) => ({
        movementType: String(row.movement_type),

        movementCount: Number(row.movement_count ?? 0),

        incomingQuantity: String(row.incoming_quantity ?? '0'),

        outgoingQuantity: String(row.outgoing_quantity ?? '0'),

        netQuantity: String(row.net_quantity ?? '0'),

        inventoryValueDelta: String(row.inventory_value_delta ?? '0'),
      }))

      const movements = (
        movementsResult.rows as Array<Record<string, unknown>>
      ).map((row) => ({
        id: String(row.id),

        branchId: typeof row.branch_id === 'string' ? row.branch_id : null,

        branchCode:
          typeof row.branch_code === 'string' ? row.branch_code : null,

        branchName:
          typeof row.branch_name === 'string' ? row.branch_name : null,

        stockLocationId: String(row.stock_location_id),

        stockLocationCode: String(row.stock_location_code),

        stockLocationName: String(row.stock_location_name),

        locationType: String(row.location_type),

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

        movementType: String(row.movement_type),

        quantity: String(row.quantity ?? '0'),

        quantityBefore:
          row.quantity_before === null || row.quantity_before === undefined
            ? null
            : String(row.quantity_before),

        quantityAfter:
          row.quantity_after === null || row.quantity_after === undefined
            ? null
            : String(row.quantity_after),

        unitCost:
          row.unit_cost === null || row.unit_cost === undefined
            ? null
            : String(row.unit_cost),

        averageCostBefore:
          row.average_cost_before === null ||
          row.average_cost_before === undefined
            ? null
            : String(row.average_cost_before),

        averageCostAfter:
          row.average_cost_after === null ||
          row.average_cost_after === undefined
            ? null
            : String(row.average_cost_after),

        inventoryValueBefore:
          row.inventory_value_before === null ||
          row.inventory_value_before === undefined
            ? null
            : String(row.inventory_value_before),

        inventoryValueAfter:
          row.inventory_value_after === null ||
          row.inventory_value_after === undefined
            ? null
            : String(row.inventory_value_after),

        referenceType:
          typeof row.reference_type === 'string' ? row.reference_type : null,

        referenceId:
          typeof row.reference_id === 'string' ? row.reference_id : null,

        note: typeof row.note === 'string' ? row.note : null,

        createdBy: typeof row.created_by === 'string' ? row.created_by : null,

        createdByName:
          typeof row.created_by_name === 'string' ? row.created_by_name : null,

        createdByUsername:
          typeof row.created_by_username === 'string'
            ? row.created_by_username
            : null,

        createdAt: serializeReportTimestamp(row.created_at),
      }))

      return res.json({
        data: {
          filters: {
            companyId: auth.companyId,

            branchId: branchId || null,

            branchSelectionLocked: Boolean(auth.branchId),

            stockLocationId: stockLocationId || null,

            variantId: variantId || null,

            movementType: movementType || null,

            referenceType: referenceType || null,

            dateFrom,
            dateTo,
            days: reportDays,

            search: search || null,

            page,
            pageSize,
          },

          definitions: {
            quantityBasis: 'stock_movements.quantity',

            incomingQuantityRule: 'quantity > 0',

            outgoingQuantityRule: 'quantity < 0',

            netQuantityFormula: 'sum(quantity)',

            inventoryValueDeltaFormula:
              'sum(inventory_value_after - inventory_value_before)',

            costBasis:
              'stock_movements unit_cost and average-cost snapshot columns where available',
          },

          summary,

          byMovementType,

          movements,

          pagination: {
            page,
            pageSize,
            totalItems,
            totalPages,

            hasPreviousPage: page > 1,

            hasNextPage: totalPages > 0 && page < totalPages,
          },
        },
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// GET /api/reports/purchase-supplier-summary
//
// تقرير مشتريات وموردين شامل.
//
// Query:
// - dateFrom: YYYY-MM-DD
// - dateTo: YYYY-MM-DD
// - branchId?
// - supplierId?
// - search?
// - limit?
//
// يرجع:
// - summary
// - bySupplier
// - recentReceipts
// - recentInvoices
// - recentPayments
// - recentReturns
// ======================================================
reportsRouter.get(
  '/api/reports/purchase-supplier-summary',

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

      const requestedBranchId =
        typeof req.query.branchId === 'string'
          ? req.query.branchId.trim().toLowerCase()
          : ''

      if (requestedBranchId && !uuidPattern.test(requestedBranchId)) {
        return res.status(400).json({
          error: 'branchId is invalid',
        })
      }

      if (
        auth.branchId &&
        requestedBranchId &&
        requestedBranchId !== auth.branchId
      ) {
        return res.status(403).json({
          error: 'Requested branch is outside the authenticated branch scope',
        })
      }

      const branchId = auth.branchId || requestedBranchId || ''

      const supplierId =
        typeof req.query.supplierId === 'string'
          ? req.query.supplierId.trim().toLowerCase()
          : ''

      if (supplierId && !uuidPattern.test(supplierId)) {
        return res.status(400).json({
          error: 'supplierId is invalid',
        })
      }

      const search =
        typeof req.query.search === 'string' && req.query.search.trim()
          ? req.query.search.trim()
          : ''

      const searchPattern = search ? `%${search}%` : null

      const limit = parseReportLimit(req.query.limit)

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

      if (supplierId) {
        const supplierResult = await db.query(
          `
          SELECT id

          FROM suppliers

          WHERE company_id = $1
            AND id = $2

          LIMIT 1;
          `,
          [auth.companyId, supplierId],
        )

        if ((supplierResult.rowCount ?? 0) === 0) {
          return res.status(404).json({
            error: 'Supplier was not found in the authenticated company',
          })
        }
      }

      const baseValues = [
        auth.companyId,
        branchId || null,
        supplierId || null,
        dateFrom,
        dateTo,
        searchPattern,
      ]

      const limitedValues = [...baseValues, limit]

      const supplierScopeSql = `
        SELECT
          supplier.id,
          supplier.code,
          supplier.name,
          supplier.phone,
          supplier.email,
          supplier.tax_number,
          supplier.is_active

        FROM suppliers supplier

        WHERE supplier.company_id = $1

          AND (
            $3::uuid IS NULL
            OR supplier.id =
               $3::uuid
          )

          AND (
            $6::text IS NULL

            OR supplier.name ILIKE $6::text

            OR supplier.code ILIKE $6::text

            OR COALESCE(
                 supplier.phone,
                 ''
               ) ILIKE $6::text

            OR COALESCE(
                 supplier.email,
                 ''
               ) ILIKE $6::text

            OR COALESCE(
                 supplier.tax_number,
                 ''
               ) ILIKE $6::text
          )
      `

      const [
        summaryResult,
        bySupplierResult,
        receiptsResult,
        invoicesResult,
        paymentsResult,
        returnsResult,
      ] = await Promise.all([
        db.query(
          `
            WITH supplier_scope AS (
              ${supplierScopeSql}
            ),

            receipt_scope AS (
              SELECT
                receipt.*

              FROM purchase_receipts receipt

              JOIN supplier_scope supplier
                ON supplier.id =
                   receipt.supplier_id

              WHERE receipt.company_id = $1

                AND (
                  $2::uuid IS NULL
                  OR receipt.branch_id =
                     $2::uuid
                )

                AND receipt.received_at >=
                    $4::date

                AND receipt.received_at <
                    (
                      $5::date +
                      INTERVAL '1 day'
                    )

                AND receipt.status <> 'cancelled'
            ),

            receipt_item_scope AS (
              SELECT
                item.purchase_receipt_id,

                COUNT(*)::int
                  AS line_count,

                COALESCE(
                  SUM(item.quantity),
                  0
                )
                  AS received_quantity

              FROM purchase_receipt_items item

              JOIN receipt_scope receipt
                ON receipt.company_id =
                   item.company_id

                AND receipt.id =
                    item.purchase_receipt_id

              GROUP BY
                item.purchase_receipt_id
            ),

            invoice_scope AS (
              SELECT
                invoice.*

              FROM supplier_invoices invoice

              JOIN supplier_scope supplier
                ON supplier.id =
                   invoice.supplier_id

              WHERE invoice.company_id = $1

                AND (
                  $2::uuid IS NULL
                  OR invoice.branch_id =
                     $2::uuid
                )

                AND invoice.invoice_date >=
                    $4::date

                AND invoice.invoice_date <
                    (
                      $5::date +
                      INTERVAL '1 day'
                    )

                AND invoice.status <> 'cancelled'
            ),

            payment_scope AS (
              SELECT
                payment.*

              FROM supplier_payments payment

              JOIN supplier_scope supplier
                ON supplier.id =
                   payment.supplier_id

              WHERE payment.company_id = $1

                AND (
                  $2::uuid IS NULL
                  OR payment.branch_id =
                     $2::uuid
                )

                AND payment.paid_at >=
                    $4::date

                AND payment.paid_at <
                    (
                      $5::date +
                      INTERVAL '1 day'
                    )
            ),

            return_scope AS (
              SELECT
                supplier_return.*

              FROM supplier_returns supplier_return

              JOIN supplier_scope supplier
                ON supplier.id =
                   supplier_return.supplier_id

              WHERE supplier_return.company_id = $1

                AND (
                  $2::uuid IS NULL
                  OR supplier_return.branch_id =
                     $2::uuid
                )

                AND supplier_return.created_at >=
                    $4::date

                AND supplier_return.created_at <
                    (
                      $5::date +
                      INTERVAL '1 day'
                    )

                AND supplier_return.status = 'posted'
            ),

            return_item_scope AS (
              SELECT
                item.supplier_return_id,

                COUNT(*)::int
                  AS line_count,

                COALESCE(
                  SUM(item.quantity),
                  0
                )
                  AS returned_quantity

              FROM supplier_return_items item

              JOIN return_scope supplier_return
                ON supplier_return.company_id =
                   item.company_id

                AND supplier_return.id =
                    item.supplier_return_id

              GROUP BY
                item.supplier_return_id
            ),

            credit_note_scope AS (
              SELECT
                credit_note.*

              FROM supplier_credit_notes credit_note

              JOIN supplier_scope supplier
                ON supplier.id =
                   credit_note.supplier_id

              WHERE credit_note.company_id = $1

                AND (
                  $2::uuid IS NULL
                  OR credit_note.branch_id =
                     $2::uuid
                )

                AND credit_note.created_at >=
                    $4::date

                AND credit_note.created_at <
                    (
                      $5::date +
                      INTERVAL '1 day'
                    )
            )

            SELECT
              (
                SELECT COUNT(*)::int
                FROM supplier_scope
              )
                AS supplier_count,

              (
                SELECT COUNT(*)::int
                FROM supplier_scope
                WHERE is_active = TRUE
              )
                AS active_supplier_count,

              (
                SELECT COUNT(*)::int
                FROM receipt_scope
              )
                AS receipt_count,

              COALESCE(
                (
                  SELECT SUM(total)
                  FROM receipt_scope
                ),
                0
              )
                AS purchase_total,

              COALESCE(
                (
                  SELECT SUM(received_quantity)
                  FROM receipt_item_scope
                ),
                0
              )
                AS received_quantity,

              (
                SELECT COUNT(*)::int
                FROM invoice_scope
              )
                AS invoice_count,

              COALESCE(
                (
                  SELECT SUM(total)
                  FROM invoice_scope
                ),
                0
              )
                AS invoice_total,

              COALESCE(
                (
                  SELECT SUM(paid_total)
                  FROM invoice_scope
                ),
                0
              )
                AS invoice_paid_total,

              COALESCE(
                (
                  SELECT SUM(credit_total)
                  FROM invoice_scope
                ),
                0
              )
                AS invoice_credit_total,

              COALESCE(
                (
                  SELECT SUM(balance)
                  FROM invoice_scope
                ),
                0
              )
                AS invoice_balance_total,

              COALESCE(
                (
                  SELECT SUM(supplier_credit_balance)
                  FROM invoice_scope
                ),
                0
              )
                AS supplier_credit_balance_total,

              (
                SELECT COUNT(*)::int
                FROM payment_scope
              )
                AS payment_count,

              COALESCE(
                (
                  SELECT SUM(amount)
                  FROM payment_scope
                ),
                0
              )
                AS payment_total,

              (
                SELECT COUNT(*)::int
                FROM return_scope
              )
                AS supplier_return_count,

              COALESCE(
                (
                  SELECT SUM(total)
                  FROM return_scope
                ),
                0
              )
                AS supplier_return_total,

              COALESCE(
                (
                  SELECT SUM(returned_quantity)
                  FROM return_item_scope
                ),
                0
              )
                AS returned_quantity,

              (
                SELECT COUNT(*)::int
                FROM credit_note_scope
              )
                AS credit_note_count,

              COALESCE(
                (
                  SELECT SUM(amount)
                  FROM credit_note_scope
                ),
                0
              )
                AS credit_note_total;
            `,
          baseValues,
        ),

        db.query(
          `
            WITH supplier_scope AS (
              ${supplierScopeSql}
            ),

            receipt_totals AS (
              SELECT
                receipt.supplier_id,

                COUNT(*)::int
                  AS receipt_count,

                COALESCE(
                  SUM(receipt.total),
                  0
                )
                  AS purchase_total,

                COALESCE(
                  SUM(item_summary.received_quantity),
                  0
                )
                  AS received_quantity

              FROM purchase_receipts receipt

              JOIN supplier_scope supplier
                ON supplier.id =
                   receipt.supplier_id

              LEFT JOIN LATERAL (
                SELECT
                  COALESCE(
                    SUM(item.quantity),
                    0
                  )
                    AS received_quantity

                FROM purchase_receipt_items item

                WHERE item.company_id =
                      receipt.company_id

                  AND item.purchase_receipt_id =
                      receipt.id
              ) item_summary
                ON TRUE

              WHERE receipt.company_id = $1

                AND (
                  $2::uuid IS NULL
                  OR receipt.branch_id =
                     $2::uuid
                )

                AND receipt.received_at >=
                    $4::date

                AND receipt.received_at <
                    (
                      $5::date +
                      INTERVAL '1 day'
                    )

                AND receipt.status <> 'cancelled'

              GROUP BY
                receipt.supplier_id
            ),

            invoice_totals AS (
              SELECT
                invoice.supplier_id,

                COUNT(*)::int
                  AS invoice_count,

                COALESCE(
                  SUM(invoice.total),
                  0
                )
                  AS invoice_total,

                COALESCE(
                  SUM(invoice.paid_total),
                  0
                )
                  AS paid_total,

                COALESCE(
                  SUM(invoice.credit_total),
                  0
                )
                  AS credit_total,

                COALESCE(
                  SUM(invoice.balance),
                  0
                )
                  AS balance_total,

                COALESCE(
                  SUM(invoice.supplier_credit_balance),
                  0
                )
                  AS supplier_credit_balance_total

              FROM supplier_invoices invoice

              JOIN supplier_scope supplier
                ON supplier.id =
                   invoice.supplier_id

              WHERE invoice.company_id = $1

                AND (
                  $2::uuid IS NULL
                  OR invoice.branch_id =
                     $2::uuid
                )

                AND invoice.invoice_date >=
                    $4::date

                AND invoice.invoice_date <
                    (
                      $5::date +
                      INTERVAL '1 day'
                    )

                AND invoice.status <> 'cancelled'

              GROUP BY
                invoice.supplier_id
            ),

            payment_totals AS (
              SELECT
                payment.supplier_id,

                COUNT(*)::int
                  AS payment_count,

                COALESCE(
                  SUM(payment.amount),
                  0
                )
                  AS payment_total

              FROM supplier_payments payment

              JOIN supplier_scope supplier
                ON supplier.id =
                   payment.supplier_id

              WHERE payment.company_id = $1

                AND (
                  $2::uuid IS NULL
                  OR payment.branch_id =
                     $2::uuid
                )

                AND payment.paid_at >=
                    $4::date

                AND payment.paid_at <
                    (
                      $5::date +
                      INTERVAL '1 day'
                    )

              GROUP BY
                payment.supplier_id
            ),

            return_totals AS (
              SELECT
                supplier_return.supplier_id,

                COUNT(*)::int
                  AS supplier_return_count,

                COALESCE(
                  SUM(supplier_return.total),
                  0
                )
                  AS supplier_return_total

              FROM supplier_returns supplier_return

              JOIN supplier_scope supplier
                ON supplier.id =
                   supplier_return.supplier_id

              WHERE supplier_return.company_id = $1

                AND (
                  $2::uuid IS NULL
                  OR supplier_return.branch_id =
                     $2::uuid
                )

                AND supplier_return.created_at >=
                    $4::date

                AND supplier_return.created_at <
                    (
                      $5::date +
                      INTERVAL '1 day'
                    )

                AND supplier_return.status = 'posted'

              GROUP BY
                supplier_return.supplier_id
            )

            SELECT
              supplier.id
                AS supplier_id,

              supplier.code
                AS supplier_code,

              supplier.name
                AS supplier_name,

              supplier.phone,
              supplier.email,
              supplier.tax_number,
              supplier.is_active,

              COALESCE(
                receipt_totals.receipt_count,
                0
              )
                AS receipt_count,

              COALESCE(
                receipt_totals.purchase_total,
                0
              )
                AS purchase_total,

              COALESCE(
                receipt_totals.received_quantity,
                0
              )
                AS received_quantity,

              COALESCE(
                invoice_totals.invoice_count,
                0
              )
                AS invoice_count,

              COALESCE(
                invoice_totals.invoice_total,
                0
              )
                AS invoice_total,

              COALESCE(
                invoice_totals.paid_total,
                0
              )
                AS paid_total,

              COALESCE(
                invoice_totals.credit_total,
                0
              )
                AS credit_total,

              COALESCE(
                invoice_totals.balance_total,
                0
              )
                AS balance_total,

              COALESCE(
                invoice_totals.supplier_credit_balance_total,
                0
              )
                AS supplier_credit_balance_total,

              COALESCE(
                payment_totals.payment_count,
                0
              )
                AS payment_count,

              COALESCE(
                payment_totals.payment_total,
                0
              )
                AS payment_total,

              COALESCE(
                return_totals.supplier_return_count,
                0
              )
                AS supplier_return_count,

              COALESCE(
                return_totals.supplier_return_total,
                0
              )
                AS supplier_return_total

            FROM supplier_scope supplier

            LEFT JOIN receipt_totals
              ON receipt_totals.supplier_id =
                 supplier.id

            LEFT JOIN invoice_totals
              ON invoice_totals.supplier_id =
                 supplier.id

            LEFT JOIN payment_totals
              ON payment_totals.supplier_id =
                 supplier.id

            LEFT JOIN return_totals
              ON return_totals.supplier_id =
                 supplier.id

            ORDER BY
              balance_total DESC,
              invoice_total DESC,
              purchase_total DESC,
              supplier.name ASC

            LIMIT $7;
            `,
          limitedValues,
        ),

        db.query(
          `
            WITH supplier_scope AS (
              ${supplierScopeSql}
            )

            SELECT
              receipt.id,
              receipt.receipt_number,
              receipt.status,

              receipt.branch_id,

              branch.code
                AS branch_code,

              branch.name
                AS branch_name,

              receipt.stock_location_id,

              location.code
                AS stock_location_code,

              location.name
                AS stock_location_name,

              supplier.id
                AS supplier_id,

              supplier.code
                AS supplier_code,

              supplier.name
                AS supplier_name,

              receipt.subtotal,
              receipt.discount_total,
              receipt.tax_total,
              receipt.total,

              item_summary.line_count,
              item_summary.received_quantity,

              receipt.received_at,
              receipt.created_at

            FROM purchase_receipts receipt

            JOIN supplier_scope supplier
              ON supplier.id =
                 receipt.supplier_id

            LEFT JOIN branches branch
              ON branch.company_id =
                 receipt.company_id

              AND branch.id =
                  receipt.branch_id

            JOIN stock_locations location
              ON location.company_id =
                 receipt.company_id

              AND location.id =
                  receipt.stock_location_id

            LEFT JOIN LATERAL (
              SELECT
                COUNT(*)::int
                  AS line_count,

                COALESCE(
                  SUM(item.quantity),
                  0
                )
                  AS received_quantity

              FROM purchase_receipt_items item

              WHERE item.company_id =
                    receipt.company_id

                AND item.purchase_receipt_id =
                    receipt.id
            ) item_summary
              ON TRUE

            WHERE receipt.company_id = $1

              AND (
                $2::uuid IS NULL
                OR receipt.branch_id =
                   $2::uuid
              )

              AND receipt.received_at >=
                  $4::date

              AND receipt.received_at <
                  (
                    $5::date +
                    INTERVAL '1 day'
                  )

              AND receipt.status <> 'cancelled'

            ORDER BY
              receipt.received_at DESC,
              receipt.id DESC

            LIMIT $7;
            `,
          limitedValues,
        ),

        db.query(
          `
            WITH supplier_scope AS (
              ${supplierScopeSql}
            )

            SELECT
              invoice.id,
              invoice.invoice_number,
              invoice.supplier_invoice_number,

              invoice.branch_id,

              branch.code
                AS branch_code,

              branch.name
                AS branch_name,

              supplier.id
                AS supplier_id,

              supplier.code
                AS supplier_code,

              supplier.name
                AS supplier_name,

              invoice.purchase_receipt_id,
              receipt.receipt_number,

              invoice.invoice_date,
              invoice.due_date,
              invoice.status,

              invoice.subtotal,
              invoice.discount_total,
              invoice.tax_total,
              invoice.total,

              invoice.paid_total,
              invoice.credit_total,
              invoice.balance,
              invoice.supplier_credit_balance,

              invoice.created_at,
              invoice.updated_at

            FROM supplier_invoices invoice

            JOIN supplier_scope supplier
              ON supplier.id =
                 invoice.supplier_id

            LEFT JOIN branches branch
              ON branch.company_id =
                 invoice.company_id

              AND branch.id =
                  invoice.branch_id

            JOIN purchase_receipts receipt
              ON receipt.company_id =
                 invoice.company_id

              AND receipt.id =
                  invoice.purchase_receipt_id

            WHERE invoice.company_id = $1

              AND (
                $2::uuid IS NULL
                OR invoice.branch_id =
                   $2::uuid
              )

              AND invoice.invoice_date >=
                  $4::date

              AND invoice.invoice_date <
                  (
                    $5::date +
                    INTERVAL '1 day'
                  )

              AND invoice.status <> 'cancelled'

            ORDER BY
              invoice.invoice_date DESC,
              invoice.created_at DESC,
              invoice.id DESC

            LIMIT $7;
            `,
          limitedValues,
        ),

        db.query(
          `
            WITH supplier_scope AS (
              ${supplierScopeSql}
            )

            SELECT
              payment.id,
              payment.payment_number,

              payment.branch_id,

              branch.code
                AS branch_code,

              branch.name
                AS branch_name,

              supplier.id
                AS supplier_id,

              supplier.code
                AS supplier_code,

              supplier.name
                AS supplier_name,

              payment.supplier_invoice_id,
              invoice.invoice_number,

              payment.amount,
              payment.payment_method,
              payment.reference_number,

              payment.paid_at,
              payment.created_at

            FROM supplier_payments payment

            JOIN supplier_scope supplier
              ON supplier.id =
                 payment.supplier_id

            LEFT JOIN branches branch
              ON branch.company_id =
                 payment.company_id

              AND branch.id =
                  payment.branch_id

            JOIN supplier_invoices invoice
              ON invoice.company_id =
                 payment.company_id

              AND invoice.id =
                  payment.supplier_invoice_id

            WHERE payment.company_id = $1

              AND (
                $2::uuid IS NULL
                OR payment.branch_id =
                   $2::uuid
              )

              AND payment.paid_at >=
                  $4::date

              AND payment.paid_at <
                  (
                    $5::date +
                    INTERVAL '1 day'
                  )

            ORDER BY
              payment.paid_at DESC,
              payment.id DESC

            LIMIT $7;
            `,
          limitedValues,
        ),

        db.query(
          `
            WITH supplier_scope AS (
              ${supplierScopeSql}
            )

            SELECT
              supplier_return.id,
              supplier_return.return_number,
              supplier_return.status,

              supplier_return.branch_id,

              branch.code
                AS branch_code,

              branch.name
                AS branch_name,

              supplier.id
                AS supplier_id,

              supplier.code
                AS supplier_code,

              supplier.name
                AS supplier_name,

              supplier_return.supplier_invoice_id,
              invoice.invoice_number,

              supplier_return.purchase_receipt_id,
              receipt.receipt_number,

              supplier_return.stock_location_id,

              location.code
                AS stock_location_code,

              location.name
                AS stock_location_name,

              supplier_return.subtotal,
              supplier_return.discount_total,
              supplier_return.tax_total,
              supplier_return.total,

              item_summary.line_count,
              item_summary.returned_quantity,

              credit_note.id
                AS credit_note_id,

              credit_note.credit_note_number,

              credit_note.amount
                AS credit_note_amount,

              supplier_return.created_at

            FROM supplier_returns supplier_return

            JOIN supplier_scope supplier
              ON supplier.id =
                 supplier_return.supplier_id

            LEFT JOIN branches branch
              ON branch.company_id =
                 supplier_return.company_id

              AND branch.id =
                  supplier_return.branch_id

            JOIN supplier_invoices invoice
              ON invoice.company_id =
                 supplier_return.company_id

              AND invoice.id =
                  supplier_return.supplier_invoice_id

            JOIN purchase_receipts receipt
              ON receipt.company_id =
                 supplier_return.company_id

              AND receipt.id =
                  supplier_return.purchase_receipt_id

            JOIN stock_locations location
              ON location.company_id =
                 supplier_return.company_id

              AND location.id =
                  supplier_return.stock_location_id

            LEFT JOIN supplier_credit_notes credit_note
              ON credit_note.company_id =
                 supplier_return.company_id

              AND credit_note.supplier_return_id =
                  supplier_return.id

            LEFT JOIN LATERAL (
              SELECT
                COUNT(*)::int
                  AS line_count,

                COALESCE(
                  SUM(item.quantity),
                  0
                )
                  AS returned_quantity

              FROM supplier_return_items item

              WHERE item.company_id =
                    supplier_return.company_id

                AND item.supplier_return_id =
                    supplier_return.id
            ) item_summary
              ON TRUE

            WHERE supplier_return.company_id = $1

              AND (
                $2::uuid IS NULL
                OR supplier_return.branch_id =
                   $2::uuid
              )

              AND supplier_return.created_at >=
                  $4::date

              AND supplier_return.created_at <
                  (
                    $5::date +
                    INTERVAL '1 day'
                  )

              AND supplier_return.status = 'posted'

            ORDER BY
              supplier_return.created_at DESC,
              supplier_return.id DESC

            LIMIT $7;
            `,
          limitedValues,
        ),
      ])

      const summaryRow = summaryResult.rows[0] as
        | Record<string, unknown>
        | undefined

      const summary = {
        supplierCount: Number(summaryRow?.supplier_count ?? 0),

        activeSupplierCount: Number(summaryRow?.active_supplier_count ?? 0),

        receiptCount: Number(summaryRow?.receipt_count ?? 0),

        purchaseTotal: String(summaryRow?.purchase_total ?? '0'),

        receivedQuantity: String(summaryRow?.received_quantity ?? '0'),

        invoiceCount: Number(summaryRow?.invoice_count ?? 0),

        invoiceTotal: String(summaryRow?.invoice_total ?? '0'),

        invoicePaidTotal: String(summaryRow?.invoice_paid_total ?? '0'),

        invoiceCreditTotal: String(summaryRow?.invoice_credit_total ?? '0'),

        invoiceBalanceTotal: String(summaryRow?.invoice_balance_total ?? '0'),

        supplierCreditBalanceTotal: String(
          summaryRow?.supplier_credit_balance_total ?? '0',
        ),

        paymentCount: Number(summaryRow?.payment_count ?? 0),

        paymentTotal: String(summaryRow?.payment_total ?? '0'),

        supplierReturnCount: Number(summaryRow?.supplier_return_count ?? 0),

        supplierReturnTotal: String(summaryRow?.supplier_return_total ?? '0'),

        returnedQuantity: String(summaryRow?.returned_quantity ?? '0'),

        creditNoteCount: Number(summaryRow?.credit_note_count ?? 0),

        creditNoteTotal: String(summaryRow?.credit_note_total ?? '0'),
      }

      const bySupplier = (
        bySupplierResult.rows as Array<Record<string, unknown>>
      ).map((row) => ({
        supplierId: String(row.supplier_id),

        supplierCode: String(row.supplier_code),

        supplierName: String(row.supplier_name),

        phone: typeof row.phone === 'string' ? row.phone : null,

        email: typeof row.email === 'string' ? row.email : null,

        taxNumber: typeof row.tax_number === 'string' ? row.tax_number : null,

        isActive: Boolean(row.is_active),

        receiptCount: Number(row.receipt_count ?? 0),

        purchaseTotal: String(row.purchase_total ?? '0'),

        receivedQuantity: String(row.received_quantity ?? '0'),

        invoiceCount: Number(row.invoice_count ?? 0),

        invoiceTotal: String(row.invoice_total ?? '0'),

        paidTotal: String(row.paid_total ?? '0'),

        creditTotal: String(row.credit_total ?? '0'),

        balanceTotal: String(row.balance_total ?? '0'),

        supplierCreditBalanceTotal: String(
          row.supplier_credit_balance_total ?? '0',
        ),

        paymentCount: Number(row.payment_count ?? 0),

        paymentTotal: String(row.payment_total ?? '0'),

        supplierReturnCount: Number(row.supplier_return_count ?? 0),

        supplierReturnTotal: String(row.supplier_return_total ?? '0'),
      }))

      const recentReceipts = (
        receiptsResult.rows as Array<Record<string, unknown>>
      ).map((row) => ({
        id: String(row.id),

        receiptNumber: String(row.receipt_number),

        status: String(row.status),

        branchId: typeof row.branch_id === 'string' ? row.branch_id : null,

        branchCode:
          typeof row.branch_code === 'string' ? row.branch_code : null,

        branchName:
          typeof row.branch_name === 'string' ? row.branch_name : null,

        stockLocationId: String(row.stock_location_id),

        stockLocationCode: String(row.stock_location_code),

        stockLocationName: String(row.stock_location_name),

        supplierId: String(row.supplier_id),

        supplierCode: String(row.supplier_code),

        supplierName: String(row.supplier_name),

        subtotal: String(row.subtotal ?? '0'),

        discountTotal: String(row.discount_total ?? '0'),

        taxTotal: String(row.tax_total ?? '0'),

        total: String(row.total ?? '0'),

        lineCount: Number(row.line_count ?? 0),

        receivedQuantity: String(row.received_quantity ?? '0'),

        receivedAt: serializeReportTimestamp(row.received_at),

        createdAt: serializeReportTimestamp(row.created_at),
      }))

      const recentInvoices = (
        invoicesResult.rows as Array<Record<string, unknown>>
      ).map((row) => ({
        id: String(row.id),

        invoiceNumber: String(row.invoice_number),

        supplierInvoiceNumber:
          typeof row.supplier_invoice_number === 'string'
            ? row.supplier_invoice_number
            : null,

        branchId: typeof row.branch_id === 'string' ? row.branch_id : null,

        branchCode:
          typeof row.branch_code === 'string' ? row.branch_code : null,

        branchName:
          typeof row.branch_name === 'string' ? row.branch_name : null,

        supplierId: String(row.supplier_id),

        supplierCode: String(row.supplier_code),

        supplierName: String(row.supplier_name),

        purchaseReceiptId: String(row.purchase_receipt_id),

        receiptNumber: String(row.receipt_number),

        invoiceDate:
          row.invoice_date instanceof Date
            ? row.invoice_date.toISOString().slice(0, 10)
            : String(row.invoice_date ?? ''),

        dueDate:
          row.due_date instanceof Date
            ? row.due_date.toISOString().slice(0, 10)
            : row.due_date === null || row.due_date === undefined
              ? null
              : String(row.due_date),

        status: String(row.status),

        subtotal: String(row.subtotal ?? '0'),

        discountTotal: String(row.discount_total ?? '0'),

        taxTotal: String(row.tax_total ?? '0'),

        total: String(row.total ?? '0'),

        paidTotal: String(row.paid_total ?? '0'),

        creditTotal: String(row.credit_total ?? '0'),

        balance: String(row.balance ?? '0'),

        supplierCreditBalance: String(row.supplier_credit_balance ?? '0'),

        createdAt: serializeReportTimestamp(row.created_at),

        updatedAt: serializeReportTimestamp(row.updated_at),
      }))

      const recentPayments = (
        paymentsResult.rows as Array<Record<string, unknown>>
      ).map((row) => ({
        id: String(row.id),

        paymentNumber: String(row.payment_number),

        branchId: typeof row.branch_id === 'string' ? row.branch_id : null,

        branchCode:
          typeof row.branch_code === 'string' ? row.branch_code : null,

        branchName:
          typeof row.branch_name === 'string' ? row.branch_name : null,

        supplierId: String(row.supplier_id),

        supplierCode: String(row.supplier_code),

        supplierName: String(row.supplier_name),

        supplierInvoiceId: String(row.supplier_invoice_id),

        invoiceNumber: String(row.invoice_number),

        amount: String(row.amount ?? '0'),

        paymentMethod: String(row.payment_method),

        referenceNumber:
          typeof row.reference_number === 'string'
            ? row.reference_number
            : null,

        paidAt: serializeReportTimestamp(row.paid_at),

        createdAt: serializeReportTimestamp(row.created_at),
      }))

      const recentReturns = (
        returnsResult.rows as Array<Record<string, unknown>>
      ).map((row) => ({
        id: String(row.id),

        returnNumber: String(row.return_number),

        status: String(row.status),

        branchId: typeof row.branch_id === 'string' ? row.branch_id : null,

        branchCode:
          typeof row.branch_code === 'string' ? row.branch_code : null,

        branchName:
          typeof row.branch_name === 'string' ? row.branch_name : null,

        supplierId: String(row.supplier_id),

        supplierCode: String(row.supplier_code),

        supplierName: String(row.supplier_name),

        supplierInvoiceId: String(row.supplier_invoice_id),

        invoiceNumber: String(row.invoice_number),

        purchaseReceiptId: String(row.purchase_receipt_id),

        receiptNumber: String(row.receipt_number),

        stockLocationId: String(row.stock_location_id),

        stockLocationCode: String(row.stock_location_code),

        stockLocationName: String(row.stock_location_name),

        subtotal: String(row.subtotal ?? '0'),

        discountTotal: String(row.discount_total ?? '0'),

        taxTotal: String(row.tax_total ?? '0'),

        total: String(row.total ?? '0'),

        lineCount: Number(row.line_count ?? 0),

        returnedQuantity: String(row.returned_quantity ?? '0'),

        creditNoteId:
          typeof row.credit_note_id === 'string' ? row.credit_note_id : null,

        creditNoteNumber:
          typeof row.credit_note_number === 'string'
            ? row.credit_note_number
            : null,

        creditNoteAmount:
          row.credit_note_amount === null ||
          row.credit_note_amount === undefined
            ? null
            : String(row.credit_note_amount),

        createdAt: serializeReportTimestamp(row.created_at),
      }))

      return res.json({
        data: {
          filters: {
            companyId: auth.companyId,

            branchId: branchId || null,

            branchSelectionLocked: Boolean(auth.branchId),

            supplierId: supplierId || null,

            dateFrom,
            dateTo,
            days: reportDays,

            search: search || null,

            limit,
          },

          definitions: {
            purchaseBasis:
              'purchase_receipts and purchase_receipt_items excluding cancelled receipts',

            invoiceBasis: 'supplier_invoices excluding cancelled invoices',

            paymentBasis: 'supplier_payments.paid_at',

            returnBasis:
              'supplier_returns with posted status and linked supplier_credit_notes where available',

            outstandingFormula:
              'supplier_invoices.balance = total - paid_total - credit_total',
          },

          summary,

          bySupplier,

          recentReceipts,
          recentInvoices,
          recentPayments,
          recentReturns,
        },
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// GET /api/reports/transfer-stock-count-summary
//
// تقرير التحويلات والجرد.
//
// Query:
// - dateFrom: YYYY-MM-DD
// - dateTo: YYYY-MM-DD
// - branchId?
// - transferStatus?
// - stockCountStatus?
// - search?
// - limit?
// ======================================================
reportsRouter.get(
  '/api/reports/transfer-stock-count-summary',

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

      const requestedBranchId =
        typeof req.query.branchId === 'string'
          ? req.query.branchId.trim().toLowerCase()
          : ''

      if (requestedBranchId && !uuidPattern.test(requestedBranchId)) {
        return res.status(400).json({
          error: 'branchId is invalid',
        })
      }

      if (
        auth.branchId &&
        requestedBranchId &&
        requestedBranchId !== auth.branchId
      ) {
        return res.status(403).json({
          error: 'Requested branch is outside the authenticated branch scope',
        })
      }

      const branchId = auth.branchId || requestedBranchId || ''

      const transferStatus =
        typeof req.query.transferStatus === 'string' &&
        req.query.transferStatus.trim()
          ? req.query.transferStatus.trim().toLowerCase()
          : 'all'

      if (
        ![
          'all',
          'draft',
          'pending',
          'approved',
          'in_transit',
          'received',
          'cancelled',
        ].includes(transferStatus)
      ) {
        return res.status(400).json({
          error:
            'transferStatus must be all, draft, pending, approved, in_transit, received, or cancelled',
        })
      }

      const stockCountStatus =
        typeof req.query.stockCountStatus === 'string' &&
        req.query.stockCountStatus.trim()
          ? req.query.stockCountStatus.trim().toLowerCase()
          : 'all'

      if (
        !['all', 'draft', 'completed', 'cancelled'].includes(stockCountStatus)
      ) {
        return res.status(400).json({
          error: 'stockCountStatus must be all, draft, completed, or cancelled',
        })
      }

      const search =
        typeof req.query.search === 'string' && req.query.search.trim()
          ? req.query.search.trim()
          : ''

      const searchPattern = search ? `%${search}%` : null
      const limit = parseReportLimit(req.query.limit)

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

      const baseValues = [
        auth.companyId,
        branchId || null,
        dateFrom,
        dateTo,
        transferStatus,
        stockCountStatus,
        searchPattern,
      ]

      const limitedValues = [...baseValues, limit]

      const transferScopeSql = `
        SELECT
          t.id,
          t.transfer_number,
          t.status,

          t.from_branch_id,
          from_branch.code AS from_branch_code,
          from_branch.name AS from_branch_name,

          t.to_branch_id,
          to_branch.code AS to_branch_code,
          to_branch.name AS to_branch_name,

          t.from_location_id,
          from_location.code AS from_location_code,
          from_location.name AS from_location_name,

          t.to_location_id,
          to_location.code AS to_location_code,
          to_location.name AS to_location_name,

          COALESCE(item_summary.line_count, 0)::int AS line_count,
          COALESCE(item_summary.requested_quantity, 0) AS requested_quantity,
          COALESCE(item_summary.approved_quantity, 0) AS approved_quantity,
          COALESCE(item_summary.received_quantity, 0) AS received_quantity,

          t.note,
          t.requested_at,
          t.approved_at,
          t.received_at,
          t.created_at,
          t.updated_at

        FROM transfers t

        JOIN stock_locations from_location
          ON from_location.company_id = t.company_id
          AND from_location.id = t.from_location_id

        JOIN stock_locations to_location
          ON to_location.company_id = t.company_id
          AND to_location.id = t.to_location_id

        LEFT JOIN branches from_branch
          ON from_branch.company_id = t.company_id
          AND from_branch.id = t.from_branch_id

        LEFT JOIN branches to_branch
          ON to_branch.company_id = t.company_id
          AND to_branch.id = t.to_branch_id

        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)::int AS line_count,
            COALESCE(SUM(item.requested_quantity), 0) AS requested_quantity,
            COALESCE(SUM(COALESCE(item.approved_quantity, 0)), 0) AS approved_quantity,
            COALESCE(SUM(COALESCE(item.received_quantity, 0)), 0) AS received_quantity

          FROM transfer_items item

          WHERE item.company_id = t.company_id
            AND item.transfer_id = t.id
        ) item_summary
          ON TRUE

        WHERE t.company_id = $1

          AND (
            $2::uuid IS NULL
            OR t.from_branch_id = $2::uuid
            OR t.to_branch_id = $2::uuid
          )

          AND t.requested_at >= $3::date

          AND t.requested_at < ($4::date + INTERVAL '1 day')

          AND (
            $5::text = 'all'
            OR t.status = $5::text
          )

          AND (
            $7::text IS NULL

            OR t.transfer_number ILIKE $7::text

            OR from_location.name ILIKE $7::text
            OR from_location.code ILIKE $7::text

            OR to_location.name ILIKE $7::text
            OR to_location.code ILIKE $7::text

            OR COALESCE(from_branch.name, '') ILIKE $7::text
            OR COALESCE(to_branch.name, '') ILIKE $7::text
            OR COALESCE(t.note, '') ILIKE $7::text
          )
      `

      const stockCountScopeSql = `
        SELECT
          count_doc.id,
          count_doc.count_number,
          count_doc.status,

          count_doc.branch_id,
          branch.code AS branch_code,
          branch.name AS branch_name,

          count_doc.stock_location_id,
          location.code AS stock_location_code,
          location.name AS stock_location_name,
          location.location_type,

          COALESCE(item_summary.line_count, 0)::int AS line_count,
          COALESCE(item_summary.counted_line_count, 0)::int AS counted_line_count,
          COALESCE(item_summary.expected_quantity, 0) AS expected_quantity,
          COALESCE(item_summary.counted_quantity, 0) AS counted_quantity,
          COALESCE(item_summary.difference_quantity, 0) AS difference_quantity,
          COALESCE(item_summary.absolute_difference_quantity, 0) AS absolute_difference_quantity,

          count_doc.notes,
          count_doc.created_at,
          count_doc.completed_at,
          count_doc.cancelled_at,
          count_doc.updated_at

        FROM inventory_stock_counts count_doc

        JOIN stock_locations location
          ON location.company_id = count_doc.company_id
          AND location.id = count_doc.stock_location_id

        LEFT JOIN branches branch
          ON branch.company_id = count_doc.company_id
          AND branch.id = count_doc.branch_id

        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)::int AS line_count,

            COUNT(*) FILTER (
              WHERE item.counted_quantity IS NOT NULL
            )::int AS counted_line_count,

            COALESCE(SUM(item.expected_quantity), 0) AS expected_quantity,
            COALESCE(SUM(COALESCE(item.counted_quantity, 0)), 0) AS counted_quantity,
            COALESCE(SUM(COALESCE(item.difference_quantity, 0)), 0) AS difference_quantity,
            COALESCE(SUM(ABS(COALESCE(item.difference_quantity, 0))), 0) AS absolute_difference_quantity

          FROM inventory_stock_count_items item

          WHERE item.company_id = count_doc.company_id
            AND item.stock_count_id = count_doc.id
        ) item_summary
          ON TRUE

        WHERE count_doc.company_id = $1

          AND (
            $2::uuid IS NULL
            OR count_doc.branch_id = $2::uuid
          )

          AND count_doc.created_at >= $3::date

          AND count_doc.created_at < ($4::date + INTERVAL '1 day')

          AND (
            $6::text = 'all'
            OR count_doc.status = $6::text
          )

          AND (
            $7::text IS NULL

            OR count_doc.count_number ILIKE $7::text
            OR location.name ILIKE $7::text
            OR location.code ILIKE $7::text
            OR COALESCE(branch.name, '') ILIKE $7::text
            OR COALESCE(count_doc.notes, '') ILIKE $7::text
          )
      `

      const [summaryResult, transfersResult, stockCountsResult] =
        await Promise.all([
          db.query(
            `
            WITH transfer_rows AS (
              ${transferScopeSql}
            ),

            stock_count_rows AS (
              ${stockCountScopeSql}
            )

            SELECT
              (SELECT COUNT(*)::int FROM transfer_rows) AS transfer_count,

              (
                SELECT COUNT(*)::int
                FROM transfer_rows
                WHERE status = 'received'
              ) AS received_transfer_count,

              (
                SELECT COUNT(*)::int
                FROM transfer_rows
                WHERE status = 'cancelled'
              ) AS cancelled_transfer_count,

              COALESCE(
                (SELECT SUM(requested_quantity) FROM transfer_rows),
                0
              ) AS transfer_requested_quantity,

              COALESCE(
                (SELECT SUM(approved_quantity) FROM transfer_rows),
                0
              ) AS transfer_approved_quantity,

              COALESCE(
                (SELECT SUM(received_quantity) FROM transfer_rows),
                0
              ) AS transfer_received_quantity,

              (SELECT COUNT(*)::int FROM stock_count_rows) AS stock_count_count,

              (
                SELECT COUNT(*)::int
                FROM stock_count_rows
                WHERE status = 'completed'
              ) AS completed_stock_count_count,

              (
                SELECT COUNT(*)::int
                FROM stock_count_rows
                WHERE status = 'cancelled'
              ) AS cancelled_stock_count_count,

              COALESCE(
                (SELECT SUM(expected_quantity) FROM stock_count_rows),
                0
              ) AS stock_count_expected_quantity,

              COALESCE(
                (SELECT SUM(counted_quantity) FROM stock_count_rows),
                0
              ) AS stock_count_counted_quantity,

              COALESCE(
                (SELECT SUM(difference_quantity) FROM stock_count_rows),
                0
              ) AS stock_count_difference_quantity,

              COALESCE(
                (SELECT SUM(absolute_difference_quantity) FROM stock_count_rows),
                0
              ) AS stock_count_absolute_difference_quantity;
            `,
            baseValues,
          ),

          db.query(
            `
            WITH transfer_rows AS (
              ${transferScopeSql}
            )

            SELECT *

            FROM transfer_rows

            ORDER BY
              requested_at DESC,
              id DESC

            LIMIT $8;
            `,
            limitedValues,
          ),

          db.query(
            `
            WITH stock_count_rows AS (
              ${stockCountScopeSql}
            )

            SELECT *

            FROM stock_count_rows

            ORDER BY
              created_at DESC,
              id DESC

            LIMIT $8;
            `,
            limitedValues,
          ),
        ])

      const summaryRow = summaryResult.rows[0] as
        | Record<string, unknown>
        | undefined

      const recentTransfers = (
        transfersResult.rows as Array<Record<string, unknown>>
      ).map((row) => ({
        id: String(row.id),
        transferNumber: String(row.transfer_number),
        status: String(row.status),

        fromBranchId:
          typeof row.from_branch_id === 'string' ? row.from_branch_id : null,
        fromBranchCode:
          typeof row.from_branch_code === 'string'
            ? row.from_branch_code
            : null,
        fromBranchName:
          typeof row.from_branch_name === 'string'
            ? row.from_branch_name
            : null,

        toBranchId:
          typeof row.to_branch_id === 'string' ? row.to_branch_id : null,
        toBranchCode:
          typeof row.to_branch_code === 'string' ? row.to_branch_code : null,
        toBranchName:
          typeof row.to_branch_name === 'string' ? row.to_branch_name : null,

        fromLocationId: String(row.from_location_id),
        fromLocationCode: String(row.from_location_code),
        fromLocationName: String(row.from_location_name),

        toLocationId: String(row.to_location_id),
        toLocationCode: String(row.to_location_code),
        toLocationName: String(row.to_location_name),

        lineCount: Number(row.line_count ?? 0),
        requestedQuantity: String(row.requested_quantity ?? '0'),
        approvedQuantity: String(row.approved_quantity ?? '0'),
        receivedQuantity: String(row.received_quantity ?? '0'),

        note: typeof row.note === 'string' ? row.note : null,

        requestedAt: serializeReportTimestamp(row.requested_at),
        approvedAt: serializeReportTimestamp(row.approved_at),
        receivedAt: serializeReportTimestamp(row.received_at),
        createdAt: serializeReportTimestamp(row.created_at),
        updatedAt: serializeReportTimestamp(row.updated_at),
      }))

      const recentStockCounts = (
        stockCountsResult.rows as Array<Record<string, unknown>>
      ).map((row) => ({
        id: String(row.id),
        countNumber: String(row.count_number),
        status: String(row.status),

        branchId: typeof row.branch_id === 'string' ? row.branch_id : null,
        branchCode:
          typeof row.branch_code === 'string' ? row.branch_code : null,
        branchName:
          typeof row.branch_name === 'string' ? row.branch_name : null,

        stockLocationId: String(row.stock_location_id),
        stockLocationCode: String(row.stock_location_code),
        stockLocationName: String(row.stock_location_name),
        locationType: String(row.location_type),

        lineCount: Number(row.line_count ?? 0),
        countedLineCount: Number(row.counted_line_count ?? 0),

        expectedQuantity: String(row.expected_quantity ?? '0'),
        countedQuantity: String(row.counted_quantity ?? '0'),
        differenceQuantity: String(row.difference_quantity ?? '0'),
        absoluteDifferenceQuantity: String(
          row.absolute_difference_quantity ?? '0',
        ),

        notes: typeof row.notes === 'string' ? row.notes : null,

        createdAt: serializeReportTimestamp(row.created_at),
        completedAt: serializeReportTimestamp(row.completed_at),
        cancelledAt: serializeReportTimestamp(row.cancelled_at),
        updatedAt: serializeReportTimestamp(row.updated_at),
      }))

      return res.json({
        data: {
          filters: {
            companyId: auth.companyId,
            branchId: branchId || null,
            branchSelectionLocked: Boolean(auth.branchId),
            transferStatus,
            stockCountStatus,
            dateFrom,
            dateTo,
            days: reportDays,
            search: search || null,
            limit,
          },

          definitions: {
            transferBasis:
              'transfers and transfer_items using requested_at as report date',
            stockCountBasis:
              'inventory_stock_counts and inventory_stock_count_items using created_at as report date',
            branchScope:
              'Transfers match either source or destination branch; stock counts match document branch',
          },

          summary: {
            transferCount: Number(summaryRow?.transfer_count ?? 0),
            receivedTransferCount: Number(
              summaryRow?.received_transfer_count ?? 0,
            ),
            cancelledTransferCount: Number(
              summaryRow?.cancelled_transfer_count ?? 0,
            ),
            transferRequestedQuantity: String(
              summaryRow?.transfer_requested_quantity ?? '0',
            ),
            transferApprovedQuantity: String(
              summaryRow?.transfer_approved_quantity ?? '0',
            ),
            transferReceivedQuantity: String(
              summaryRow?.transfer_received_quantity ?? '0',
            ),

            stockCountCount: Number(summaryRow?.stock_count_count ?? 0),
            completedStockCountCount: Number(
              summaryRow?.completed_stock_count_count ?? 0,
            ),
            cancelledStockCountCount: Number(
              summaryRow?.cancelled_stock_count_count ?? 0,
            ),
            stockCountExpectedQuantity: String(
              summaryRow?.stock_count_expected_quantity ?? '0',
            ),
            stockCountCountedQuantity: String(
              summaryRow?.stock_count_counted_quantity ?? '0',
            ),
            stockCountDifferenceQuantity: String(
              summaryRow?.stock_count_difference_quantity ?? '0',
            ),
            stockCountAbsoluteDifferenceQuantity: String(
              summaryRow?.stock_count_absolute_difference_quantity ?? '0',
            ),
          },

          recentTransfers,
          recentStockCounts,
        },
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// GET /api/reports/damage-inspection-stock
//
// تقرير مخزون التالف والتفتيش.
//
// Query:
// - dateFrom: YYYY-MM-DD
// - dateTo: YYYY-MM-DD
// - branchId?
// - stockLocationId?
// - locationType? all | damaged | inspection
// - search?
// - limit?
// ======================================================
reportsRouter.get(
  '/api/reports/damage-inspection-stock',

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

      const requestedBranchId =
        typeof req.query.branchId === 'string'
          ? req.query.branchId.trim().toLowerCase()
          : ''

      if (requestedBranchId && !uuidPattern.test(requestedBranchId)) {
        return res.status(400).json({
          error: 'branchId is invalid',
        })
      }

      if (
        auth.branchId &&
        requestedBranchId &&
        requestedBranchId !== auth.branchId
      ) {
        return res.status(403).json({
          error: 'Requested branch is outside the authenticated branch scope',
        })
      }

      const branchId = auth.branchId || requestedBranchId || ''

      const stockLocationId =
        typeof req.query.stockLocationId === 'string'
          ? req.query.stockLocationId.trim().toLowerCase()
          : ''

      if (stockLocationId && !uuidPattern.test(stockLocationId)) {
        return res.status(400).json({
          error: 'stockLocationId is invalid',
        })
      }

      const locationType =
        typeof req.query.locationType === 'string' &&
        req.query.locationType.trim()
          ? req.query.locationType.trim().toLowerCase()
          : 'all'

      if (!['all', 'damaged', 'inspection'].includes(locationType)) {
        return res.status(400).json({
          error: 'locationType must be all, damaged, or inspection',
        })
      }

      const search =
        typeof req.query.search === 'string' && req.query.search.trim()
          ? req.query.search.trim()
          : ''

      const searchPattern = search ? `%${search}%` : null
      const limit = parseReportLimit(req.query.limit)

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

      if (stockLocationId) {
        const locationResult = await db.query(
          `
          SELECT id
          FROM stock_locations
          WHERE company_id = $1
            AND id = $2
            AND location_type IN ('damaged', 'inspection')
            AND (
              $3::uuid IS NULL
              OR branch_id = $3::uuid
            )
          LIMIT 1;
          `,
          [auth.companyId, stockLocationId, branchId || null],
        )

        if ((locationResult.rowCount ?? 0) === 0) {
          return res.status(404).json({
            error:
              'Damage or inspection stock location was not found in the authenticated scope',
          })
        }
      }

      const baseValues = [
        auth.companyId,
        branchId || null,
        stockLocationId || null,
        locationType,
        dateFrom,
        dateTo,
        searchPattern,
      ]

      const limitedValues = [...baseValues, limit]

      const currentScopeSql = `
        SELECT
          location.id AS stock_location_id,
          location.code AS stock_location_code,
          location.name AS stock_location_name,
          location.location_type,

          location.branch_id,

          branch.code AS branch_code,
          branch.name AS branch_name,

          sb.variant_id,
          pv.product_id,
          p.name AS product_name,
          pv.sku,
          pv.primary_barcode,

          size.name AS size_name,
          color.name AS color_name,
          category.name AS category_name,
          brand.name AS brand_name,

          sb.quantity,
          COALESCE(sb.average_cost, 0) AS average_cost,

          ROUND(
            (
              sb.quantity *
              COALESCE(sb.average_cost, 0)
            )::numeric,
            2
          ) AS inventory_value

        FROM stock_balances sb

        JOIN stock_locations location
          ON location.company_id = sb.company_id
          AND location.id = sb.stock_location_id

        LEFT JOIN branches branch
          ON branch.company_id = sb.company_id
          AND branch.id = location.branch_id

        JOIN product_variants pv
          ON pv.company_id = sb.company_id
          AND pv.id = sb.variant_id

        JOIN products p
          ON p.company_id = pv.company_id
          AND p.id = pv.product_id

        LEFT JOIN fashion_sizes size
          ON size.company_id = pv.company_id
          AND size.id = pv.size_id

        LEFT JOIN fashion_colors color
          ON color.company_id = pv.company_id
          AND color.id = pv.color_id

        LEFT JOIN product_categories category
          ON category.company_id = p.company_id
          AND category.id = p.category_id

        LEFT JOIN brands brand
          ON brand.company_id = p.company_id
          AND brand.id = p.brand_id

        WHERE sb.company_id = $1

          AND location.location_type IN ('damaged', 'inspection')

          AND (
            $2::uuid IS NULL
            OR location.branch_id = $2::uuid
          )

          AND (
            $3::uuid IS NULL
            OR location.id = $3::uuid
          )

          AND (
            $4::text = 'all'
            OR location.location_type = $4::text
          )

          AND (
            $7::text IS NULL

            OR p.name ILIKE $7::text
            OR pv.sku ILIKE $7::text
            OR COALESCE(pv.primary_barcode, '') ILIKE $7::text
            OR location.name ILIKE $7::text
            OR location.code ILIKE $7::text
            OR COALESCE(branch.name, '') ILIKE $7::text
            OR COALESCE(category.name, '') ILIKE $7::text
            OR COALESCE(brand.name, '') ILIKE $7::text
          )
      `

      const movementScopeSql = `
        SELECT
          sm.id,
          sm.stock_location_id,

          location.code AS stock_location_code,
          location.name AS stock_location_name,
          location.location_type,

          location.branch_id,

          branch.code AS branch_code,
          branch.name AS branch_name,

          sm.variant_id,
          pv.product_id,
          p.name AS product_name,
          pv.sku,
          pv.primary_barcode,

          size.name AS size_name,
          color.name AS color_name,
          category.name AS category_name,
          brand.name AS brand_name,

          sm.movement_type,
          sm.quantity,
          sm.quantity_before,
          sm.quantity_after,

          sm.unit_cost,
          sm.average_cost_before,
          sm.average_cost_after,
          sm.inventory_value_before,
          sm.inventory_value_after,

          sm.reference_type,
          sm.reference_id,
          sm.note,
          sm.created_at

        FROM stock_movements sm

        JOIN stock_locations location
          ON location.company_id = sm.company_id
          AND location.id = sm.stock_location_id

        LEFT JOIN branches branch
          ON branch.company_id = sm.company_id
          AND branch.id = location.branch_id

        JOIN product_variants pv
          ON pv.company_id = sm.company_id
          AND pv.id = sm.variant_id

        JOIN products p
          ON p.company_id = pv.company_id
          AND p.id = pv.product_id

        LEFT JOIN fashion_sizes size
          ON size.company_id = pv.company_id
          AND size.id = pv.size_id

        LEFT JOIN fashion_colors color
          ON color.company_id = pv.company_id
          AND color.id = pv.color_id

        LEFT JOIN product_categories category
          ON category.company_id = p.company_id
          AND category.id = p.category_id

        LEFT JOIN brands brand
          ON brand.company_id = p.company_id
          AND brand.id = p.brand_id

        WHERE sm.company_id = $1

          AND location.location_type IN ('damaged', 'inspection')

          AND (
            $2::uuid IS NULL
            OR location.branch_id = $2::uuid
          )

          AND (
            $3::uuid IS NULL
            OR location.id = $3::uuid
          )

          AND (
            $4::text = 'all'
            OR location.location_type = $4::text
          )

          AND sm.created_at >= $5::date

          AND sm.created_at < ($6::date + INTERVAL '1 day')

          AND (
            $7::text IS NULL

            OR p.name ILIKE $7::text
            OR pv.sku ILIKE $7::text
            OR COALESCE(pv.primary_barcode, '') ILIKE $7::text
            OR location.name ILIKE $7::text
            OR location.code ILIKE $7::text
            OR COALESCE(branch.name, '') ILIKE $7::text
            OR COALESCE(category.name, '') ILIKE $7::text
            OR COALESCE(brand.name, '') ILIKE $7::text
            OR COALESCE(sm.note, '') ILIKE $7::text
          )
      `

      const [summaryResult, byLocationResult, topItemsResult, movementsResult] =
        await Promise.all([
          db.query(
            `
            WITH current_rows AS (
              ${currentScopeSql}
            ),

            movement_rows AS (
              ${movementScopeSql}
            )

            SELECT
              (SELECT COUNT(DISTINCT stock_location_id)::int FROM current_rows)
                AS current_location_count,

              (SELECT COUNT(DISTINCT variant_id)::int FROM current_rows)
                AS current_variant_count,

              COALESCE(
                (SELECT SUM(quantity) FROM current_rows),
                0
              ) AS current_quantity,

              COALESCE(
                (SELECT SUM(inventory_value) FROM current_rows),
                0
              ) AS current_inventory_value,

              COALESCE(
                (
                  SELECT SUM(quantity)
                  FROM current_rows
                  WHERE location_type = 'damaged'
                ),
                0
              ) AS damaged_quantity,

              COALESCE(
                (
                  SELECT SUM(inventory_value)
                  FROM current_rows
                  WHERE location_type = 'damaged'
                ),
                0
              ) AS damaged_inventory_value,

              COALESCE(
                (
                  SELECT SUM(quantity)
                  FROM current_rows
                  WHERE location_type = 'inspection'
                ),
                0
              ) AS inspection_quantity,

              COALESCE(
                (
                  SELECT SUM(inventory_value)
                  FROM current_rows
                  WHERE location_type = 'inspection'
                ),
                0
              ) AS inspection_inventory_value,

              (SELECT COUNT(*)::int FROM movement_rows) AS movement_count,

              COALESCE(
                (
                  SELECT SUM(
                    CASE
                      WHEN quantity > 0 THEN quantity
                      ELSE 0
                    END
                  )
                  FROM movement_rows
                ),
                0
              ) AS incoming_quantity,

              COALESCE(
                (
                  SELECT SUM(
                    CASE
                      WHEN quantity < 0 THEN ABS(quantity)
                      ELSE 0
                    END
                  )
                  FROM movement_rows
                ),
                0
              ) AS outgoing_quantity,

              COALESCE(
                (SELECT SUM(quantity) FROM movement_rows),
                0
              ) AS net_quantity,

              (
                SELECT COUNT(*)::int
                FROM movement_rows
                WHERE movement_type = 'damage'
              ) AS damage_movement_count;
            `,
            baseValues,
          ),

          db.query(
            `
            WITH current_rows AS (
              ${currentScopeSql}
            )

            SELECT
              stock_location_id,
              stock_location_code,
              stock_location_name,
              location_type,

              branch_id,
              branch_code,
              branch_name,

              COUNT(DISTINCT variant_id)::int AS variant_count,
              COALESCE(SUM(quantity), 0) AS quantity,
              COALESCE(SUM(inventory_value), 0) AS inventory_value

            FROM current_rows

            GROUP BY
              stock_location_id,
              stock_location_code,
              stock_location_name,
              location_type,
              branch_id,
              branch_code,
              branch_name

            ORDER BY
              inventory_value DESC,
              stock_location_name ASC;
            `,
            baseValues,
          ),

          db.query(
            `
            WITH current_rows AS (
              ${currentScopeSql}
            )

            SELECT *

            FROM current_rows

            ORDER BY
              inventory_value DESC,
              quantity DESC,
              product_name ASC,
              sku ASC

            LIMIT $8;
            `,
            limitedValues,
          ),

          db.query(
            `
            WITH movement_rows AS (
              ${movementScopeSql}
            )

            SELECT *

            FROM movement_rows

            ORDER BY
              created_at DESC,
              id DESC

            LIMIT $8;
            `,
            limitedValues,
          ),
        ])

      const summaryRow = summaryResult.rows[0] as
        | Record<string, unknown>
        | undefined

      const byLocation = (
        byLocationResult.rows as Array<Record<string, unknown>>
      ).map((row) => ({
        stockLocationId: String(row.stock_location_id),
        stockLocationCode: String(row.stock_location_code),
        stockLocationName: String(row.stock_location_name),
        locationType: String(row.location_type),

        branchId: typeof row.branch_id === 'string' ? row.branch_id : null,
        branchCode:
          typeof row.branch_code === 'string' ? row.branch_code : null,
        branchName:
          typeof row.branch_name === 'string' ? row.branch_name : null,

        variantCount: Number(row.variant_count ?? 0),
        quantity: String(row.quantity ?? '0'),
        inventoryValue: String(row.inventory_value ?? '0'),
      }))

      const topItems = (
        topItemsResult.rows as Array<Record<string, unknown>>
      ).map((row) => ({
        stockLocationId: String(row.stock_location_id),
        stockLocationCode: String(row.stock_location_code),
        stockLocationName: String(row.stock_location_name),
        locationType: String(row.location_type),

        branchId: typeof row.branch_id === 'string' ? row.branch_id : null,
        branchName:
          typeof row.branch_name === 'string' ? row.branch_name : null,

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

        quantity: String(row.quantity ?? '0'),
        averageCost: String(row.average_cost ?? '0'),
        inventoryValue: String(row.inventory_value ?? '0'),
      }))

      const recentMovements = (
        movementsResult.rows as Array<Record<string, unknown>>
      ).map((row) => ({
        id: String(row.id),

        stockLocationId: String(row.stock_location_id),
        stockLocationCode: String(row.stock_location_code),
        stockLocationName: String(row.stock_location_name),
        locationType: String(row.location_type),

        branchId: typeof row.branch_id === 'string' ? row.branch_id : null,
        branchName:
          typeof row.branch_name === 'string' ? row.branch_name : null,

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

        movementType: String(row.movement_type),
        quantity: String(row.quantity ?? '0'),

        quantityBefore:
          row.quantity_before === null || row.quantity_before === undefined
            ? null
            : String(row.quantity_before),

        quantityAfter:
          row.quantity_after === null || row.quantity_after === undefined
            ? null
            : String(row.quantity_after),

        unitCost:
          row.unit_cost === null || row.unit_cost === undefined
            ? null
            : String(row.unit_cost),

        averageCostBefore:
          row.average_cost_before === null ||
          row.average_cost_before === undefined
            ? null
            : String(row.average_cost_before),

        averageCostAfter:
          row.average_cost_after === null ||
          row.average_cost_after === undefined
            ? null
            : String(row.average_cost_after),

        inventoryValueBefore:
          row.inventory_value_before === null ||
          row.inventory_value_before === undefined
            ? null
            : String(row.inventory_value_before),

        inventoryValueAfter:
          row.inventory_value_after === null ||
          row.inventory_value_after === undefined
            ? null
            : String(row.inventory_value_after),

        referenceType:
          typeof row.reference_type === 'string' ? row.reference_type : null,

        referenceId:
          typeof row.reference_id === 'string' ? row.reference_id : null,

        note: typeof row.note === 'string' ? row.note : null,

        createdAt: serializeReportTimestamp(row.created_at),
      }))

      return res.json({
        data: {
          filters: {
            companyId: auth.companyId,
            branchId: branchId || null,
            branchSelectionLocked: Boolean(auth.branchId),
            stockLocationId: stockLocationId || null,
            locationType,
            dateFrom,
            dateTo,
            days: reportDays,
            search: search || null,
            limit,
          },

          definitions: {
            currentStockBasis:
              'stock_balances for stock_locations with location_type damaged or inspection',
            movementBasis:
              'stock_movements in damaged or inspection locations within date range',
            inventoryValueFormula: 'quantity * averageCost',
          },

          summary: {
            currentLocationCount: Number(
              summaryRow?.current_location_count ?? 0,
            ),
            currentVariantCount: Number(summaryRow?.current_variant_count ?? 0),
            currentQuantity: String(summaryRow?.current_quantity ?? '0'),
            currentInventoryValue: String(
              summaryRow?.current_inventory_value ?? '0',
            ),
            damagedQuantity: String(summaryRow?.damaged_quantity ?? '0'),
            damagedInventoryValue: String(
              summaryRow?.damaged_inventory_value ?? '0',
            ),
            inspectionQuantity: String(summaryRow?.inspection_quantity ?? '0'),
            inspectionInventoryValue: String(
              summaryRow?.inspection_inventory_value ?? '0',
            ),
            movementCount: Number(summaryRow?.movement_count ?? 0),
            incomingQuantity: String(summaryRow?.incoming_quantity ?? '0'),
            outgoingQuantity: String(summaryRow?.outgoing_quantity ?? '0'),
            netQuantity: String(summaryRow?.net_quantity ?? '0'),
            damageMovementCount: Number(summaryRow?.damage_movement_count ?? 0),
          },

          byLocation,
          topItems,
          recentMovements,
        },
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// GET /api/reports/inventory-shortages
//
// تقرير نواقص المخزون حسب حدود إعادة الطلب.
//
// Query:
// - branchId?
// - stockLocationId?
// - status?
// - search?
// - page?
// - pageSize?
//
// status:
// - alerts    critical + low
// - critical
// - low
// - healthy
// - all
// ======================================================
reportsRouter.get(
  '/api/reports/inventory-shortages',

  async (req, res, next) => {
    try {
      const auth = getAuthContext(res)

      const branchId =
        typeof req.query.branchId === 'string'
          ? req.query.branchId.trim().toLowerCase()
          : ''

      if (branchId && !uuidPattern.test(branchId)) {
        return res.status(400).json({
          error: 'branchId is invalid',
        })
      }

      const stockLocationId =
        typeof req.query.stockLocationId === 'string'
          ? req.query.stockLocationId.trim().toLowerCase()
          : ''

      if (stockLocationId && !uuidPattern.test(stockLocationId)) {
        return res.status(400).json({
          error: 'stockLocationId is invalid',
        })
      }

      const stockStatus =
        typeof req.query.status === 'string'
          ? req.query.status.trim().toLowerCase()
          : 'alerts'

      if (!allowedInventoryShortageStatuses.has(stockStatus)) {
        return res.status(400).json({
          error: 'status must be alerts, critical, low, healthy or all',
        })
      }

      const search =
        typeof req.query.search === 'string' ? req.query.search.trim() : ''

      if (search.length > 100) {
        return res.status(400).json({
          error: 'search cannot exceed 100 characters',
        })
      }

      const requestedPage = Number(req.query.page ?? 1)

      const page = Number.isFinite(requestedPage)
        ? Math.min(Math.max(Math.trunc(requestedPage), 1), 100000)
        : 1

      const pageSize = parseReportLimit(req.query.pageSize)

      const offset = (page - 1) * pageSize

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

      if (stockLocationId) {
        const locationResult = await db.query(
          `
            SELECT id

            FROM stock_locations

            WHERE company_id = $1
              AND id = $2
              AND is_active = TRUE

              AND (
                $3::uuid IS NULL
                OR branch_id =
                   $3::uuid
              )

            LIMIT 1;
            `,
          [auth.companyId, stockLocationId, branchId || null],
        )

        if ((locationResult.rowCount ?? 0) === 0) {
          return res.status(404).json({
            error: 'Stock location was not found in the accessible scope',
          })
        }
      }

      const shortageScopeSql = `
        SELECT
          rule.id,
          rule.company_id,
          rule.stock_location_id,
          rule.variant_id,

          rule.reorder_point,
          rule.safety_stock,
          rule.reorder_quantity,
          rule.updated_at,

          location.branch_id,

          branch.code
            AS branch_code,

          branch.name
            AS branch_name,

          location.code
            AS stock_location_code,

          location.name
            AS stock_location_name,

          location.location_type,

          variant.product_id,
          variant.sku,
          variant.primary_barcode,

          product.name
            AS product_name,

          size.name
            AS size_name,

          color.name
            AS color_name,

          category.name
            AS category_name,

          brand.name
            AS brand_name,

          COALESCE(
            balance.quantity,
            0
          )
            AS current_quantity,

          CASE
            WHEN COALESCE(
              balance.quantity,
              0
            ) <= rule.safety_stock
            THEN 'critical'

            WHEN COALESCE(
              balance.quantity,
              0
            ) <= rule.reorder_point
            THEN 'low'

            ELSE 'healthy'
          END
            AS stock_status,

          GREATEST(
            rule.reorder_point -
            COALESCE(
              balance.quantity,
              0
            ),
            0
          )
            AS shortage_quantity,

          CASE
            WHEN COALESCE(
              balance.quantity,
              0
            ) <= rule.reorder_point
            THEN GREATEST(
              rule.reorder_quantity,

              rule.reorder_point -
              COALESCE(
                balance.quantity,
                0
              )
            )

            ELSE 0
          END
            AS suggested_order_quantity

        FROM inventory_reorder_rules
             rule

        JOIN stock_locations
             location
          ON location.company_id =
             rule.company_id

          AND location.id =
              rule.stock_location_id

          AND location.is_active =
              TRUE

        LEFT JOIN branches branch
          ON branch.company_id =
             location.company_id

          AND branch.id =
              location.branch_id

        JOIN product_variants
             variant
          ON variant.company_id =
             rule.company_id

          AND variant.id =
              rule.variant_id

          AND variant.status =
              'active'

        JOIN products product
          ON product.company_id =
             variant.company_id

          AND product.id =
              variant.product_id

          AND product.status =
              'active'

        LEFT JOIN fashion_sizes size
          ON size.company_id =
             variant.company_id

          AND size.id =
              variant.size_id

        LEFT JOIN fashion_colors color
          ON color.company_id =
             variant.company_id

          AND color.id =
              variant.color_id

        LEFT JOIN product_categories
                  category
          ON category.company_id =
             product.company_id

          AND category.id =
              product.category_id

        LEFT JOIN brands brand
          ON brand.company_id =
             product.company_id

          AND brand.id =
              product.brand_id

        LEFT JOIN stock_balances
                  balance
          ON balance.company_id =
             rule.company_id

          AND balance
                .stock_location_id =
              rule.stock_location_id

          AND balance.variant_id =
              rule.variant_id

        WHERE rule.company_id = $1
          AND rule.is_active = TRUE

          AND (
            $2::uuid IS NULL
            OR location.branch_id =
               $2::uuid
          )

          AND (
            $3::uuid IS NULL
            OR rule.stock_location_id =
               $3::uuid
          )
      `

      const baseValues = [
        auth.companyId,
        branchId || null,
        stockLocationId || null,
      ]

      const searchPattern = search ? `%${search}%` : null

      const filterValues = [...baseValues, stockStatus, searchPattern]

      const pageValues = [...filterValues, pageSize, offset]

      const [
        summaryResult,
        countResult,
        itemsResult,
        branchOptionsResult,
        locationOptionsResult,
      ] = await Promise.all([
        db.query(
          `
          WITH classified_rules AS (
            ${shortageScopeSql}
          )

          SELECT
            COUNT(*)::int
              AS total_active_rules,

            COUNT(
              DISTINCT stock_location_id
            )::int
              AS stock_location_count,

            COUNT(
              DISTINCT variant_id
            )::int
              AS variant_count,

            COUNT(*) FILTER (
              WHERE stock_status =
                    'critical'
            )::int
              AS critical_count,

            COUNT(*) FILTER (
              WHERE stock_status =
                    'low'
            )::int
              AS low_count,

            COUNT(*) FILTER (
              WHERE stock_status =
                    'healthy'
            )::int
              AS healthy_count,

            COUNT(*) FILTER (
              WHERE current_quantity <= 0
            )::int
              AS out_of_stock_count,

            COALESCE(
              SUM(shortage_quantity)
                FILTER (
                  WHERE stock_status
                        IN (
                          'critical',
                          'low'
                        )
                ),
              0
            )
              AS total_shortage_quantity,

            COALESCE(
              SUM(
                suggested_order_quantity
              ) FILTER (
                WHERE stock_status
                      IN (
                        'critical',
                        'low'
                      )
              ),
              0
            )
              AS total_suggested_order_quantity

          FROM classified_rules;
          `,
          baseValues,
        ),

        db.query(
          `
          WITH classified_rules AS (
            ${shortageScopeSql}
          ),

          filtered_rules AS (
            SELECT *

            FROM classified_rules

            WHERE (
              $4::text = 'all'

              OR (
                $4::text = 'alerts'
                AND stock_status
                    IN (
                      'critical',
                      'low'
                    )
              )

              OR stock_status =
                 $4::text
            )

            AND (
              $5::text IS NULL

              OR product_name
                 ILIKE $5::text

              OR sku
                 ILIKE $5::text

              OR COALESCE(
                   primary_barcode,
                   ''
                 )
                 ILIKE $5::text

              OR stock_location_name
                 ILIKE $5::text

              OR stock_location_code
                 ILIKE $5::text

              OR COALESCE(
                   branch_name,
                   ''
                 )
                 ILIKE $5::text

              OR COALESCE(
                   category_name,
                   ''
                 )
                 ILIKE $5::text

              OR COALESCE(
                   brand_name,
                   ''
                 )
                 ILIKE $5::text
            )
          )

          SELECT
            COUNT(*)::int
              AS total_count

          FROM filtered_rules;
          `,
          filterValues,
        ),

        db.query(
          `
          WITH classified_rules AS (
            ${shortageScopeSql}
          ),

          filtered_rules AS (
            SELECT *

            FROM classified_rules

            WHERE (
              $4::text = 'all'

              OR (
                $4::text = 'alerts'
                AND stock_status
                    IN (
                      'critical',
                      'low'
                    )
              )

              OR stock_status =
                 $4::text
            )

            AND (
              $5::text IS NULL

              OR product_name
                 ILIKE $5::text

              OR sku
                 ILIKE $5::text

              OR COALESCE(
                   primary_barcode,
                   ''
                 )
                 ILIKE $5::text

              OR stock_location_name
                 ILIKE $5::text

              OR stock_location_code
                 ILIKE $5::text

              OR COALESCE(
                   branch_name,
                   ''
                 )
                 ILIKE $5::text

              OR COALESCE(
                   category_name,
                   ''
                 )
                 ILIKE $5::text

              OR COALESCE(
                   brand_name,
                   ''
                 )
                 ILIKE $5::text
            )
          )

          SELECT *

          FROM filtered_rules

          ORDER BY
            CASE stock_status
              WHEN 'critical' THEN 1
              WHEN 'low' THEN 2
              ELSE 3
            END ASC,

            shortage_quantity DESC,
            current_quantity ASC,
            product_name ASC,
            sku ASC,
            stock_location_name ASC

          LIMIT $6
          OFFSET $7;
          `,
          pageValues,
        ),

        db.query(
          `
          SELECT
            id,
            code,
            name,
            is_active

          FROM branches

          WHERE company_id = $1

            AND (
              $2::uuid IS NULL
              OR id = $2::uuid
            )

          ORDER BY
            is_active DESC,
            name ASC,
            code ASC;
          `,
          [auth.companyId, auth.branchId],
        ),

        db.query(
          `
          SELECT
            location.id,
            location.branch_id,
            location.code,
            location.name,
            location.location_type,

            branch.code
              AS branch_code,

            branch.name
              AS branch_name

          FROM stock_locations
               location

          LEFT JOIN branches branch
            ON branch.company_id =
               location.company_id

            AND branch.id =
                location.branch_id

          WHERE location.company_id = $1
            AND location.is_active = TRUE

            AND (
              $2::uuid IS NULL
              OR location.branch_id =
                 $2::uuid
            )

          ORDER BY
            branch.name
              ASC NULLS FIRST,

            location.name ASC,
            location.code ASC;
          `,
          [auth.companyId, branchId || null],
        ),
      ])

      const summaryRow = summaryResult.rows[0] as
        | Record<string, unknown>
        | undefined

      const countRow = countResult.rows[0] as
        | Record<string, unknown>
        | undefined

      const totalItems = Number(countRow?.total_count ?? 0)

      const totalPages = totalItems > 0 ? Math.ceil(totalItems / pageSize) : 0

      const items = (itemsResult.rows as Array<Record<string, unknown>>).map(
        (row) => ({
          ruleId: String(row.id),

          branchId: typeof row.branch_id === 'string' ? row.branch_id : null,

          branchCode:
            typeof row.branch_code === 'string' ? row.branch_code : null,

          branchName:
            typeof row.branch_name === 'string' ? row.branch_name : null,

          stockLocationId: String(row.stock_location_id),

          stockLocationCode: String(row.stock_location_code),

          stockLocationName: String(row.stock_location_name),

          stockLocationType: String(row.location_type),

          variantId: String(row.variant_id),

          productId: String(row.product_id),

          productName: String(row.product_name),

          sku: String(row.sku),

          primaryBarcode:
            typeof row.primary_barcode === 'string'
              ? row.primary_barcode
              : null,

          sizeName: typeof row.size_name === 'string' ? row.size_name : null,

          colorName: typeof row.color_name === 'string' ? row.color_name : null,

          categoryName:
            typeof row.category_name === 'string' ? row.category_name : null,

          brandName: typeof row.brand_name === 'string' ? row.brand_name : null,

          reorderPoint: String(row.reorder_point ?? '0'),

          safetyStock: String(row.safety_stock ?? '0'),

          reorderQuantity: String(row.reorder_quantity ?? '0'),

          currentQuantity: String(row.current_quantity ?? '0'),

          shortageQuantity: String(row.shortage_quantity ?? '0'),

          suggestedOrderQuantity: String(row.suggested_order_quantity ?? '0'),

          stockStatus: String(row.stock_status),

          updatedAt: serializeReportTimestamp(row.updated_at),
        }),
      )

      return res.json({
        data: {
          filters: {
            companyId: auth.companyId,

            branchId: branchId || null,

            stockLocationId: stockLocationId || null,

            status: stockStatus,

            search: search || null,

            page,
            pageSize,
          },

          scope: {
            branchSelectionLocked: Boolean(auth.branchId),
          },

          definitions: {
            alertStatuses: ['critical', 'low'],

            criticalRule: 'currentQuantity <= safetyStock',

            lowRule: 'safetyStock < currentQuantity <= reorderPoint',

            healthyRule: 'currentQuantity > reorderPoint',

            shortageFormula: 'max(reorderPoint - currentQuantity, 0)',

            suggestedOrderFormula: 'max(reorderQuantity, shortageQuantity)',

            inventorySource: 'Current PostgreSQL stock balance',

            activeSourcesOnly: true,
          },

          branchOptions: branchOptionsResult.rows.map((row) => ({
            id: String(row.id),

            code: String(row.code),

            name: String(row.name),

            isActive: Boolean(row.is_active),
          })),

          stockLocationOptions: locationOptionsResult.rows.map((row) => ({
            id: String(row.id),

            branchId: typeof row.branch_id === 'string' ? row.branch_id : null,

            branchCode:
              typeof row.branch_code === 'string' ? row.branch_code : null,

            branchName:
              typeof row.branch_name === 'string' ? row.branch_name : null,

            code: String(row.code),

            name: String(row.name),

            locationType: String(row.location_type),
          })),

          summary: {
            totalActiveRules: Number(summaryRow?.total_active_rules ?? 0),

            stockLocationCount: Number(summaryRow?.stock_location_count ?? 0),

            variantCount: Number(summaryRow?.variant_count ?? 0),

            criticalCount: Number(summaryRow?.critical_count ?? 0),

            lowCount: Number(summaryRow?.low_count ?? 0),

            healthyCount: Number(summaryRow?.healthy_count ?? 0),

            outOfStockCount: Number(summaryRow?.out_of_stock_count ?? 0),

            totalShortageQuantity: String(
              summaryRow?.total_shortage_quantity ?? '0',
            ),

            totalSuggestedOrderQuantity: String(
              summaryRow?.total_suggested_order_quantity ?? '0',
            ),
          },

          items,

          pagination: {
            page,
            pageSize,
            totalItems,
            totalPages,

            hasPreviousPage: page > 1,

            hasNextPage: totalPages > 0 && page < totalPages,
          },
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
