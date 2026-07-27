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
