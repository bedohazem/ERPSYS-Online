import { randomBytes } from 'node:crypto'
import type { NextFunction, Response } from 'express'
import { Router } from 'express'

import { db } from '../../db/pool'
import { getAuthContext } from '../auth/auth.middleware'

export const exchangesRouter = Router()

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const allowedPaymentMethods = new Set([
  'cash',
  'card',
  'wallet',
  'bank_transfer',
  'other',
])

type PreparedReturnItem = {
  originalSaleItemId: string
  variantId: string

  skuSnapshot: string
  barcodeSnapshot: string | null
  productNameSnapshot: string
  sizeSnapshot: string | null
  colorSnapshot: string | null

  quantity: number
  unitPrice: number
  lineTotal: number
}

type PreparedIssueItem = {
  variantId: string

  skuSnapshot: string
  barcodeSnapshot: string | null
  productNameSnapshot: string
  sizeSnapshot: string | null
  colorSnapshot: string | null

  quantity: number
  unitPrice: number
  discountAmount: number
  lineTotal: number
}

type PreparedPayment = {
  paymentDirection: 'paid_by_customer' | 'refunded_to_customer'

  method: string
  amount: number
  reference: string | null
}

class ExchangeApiError extends Error {
  statusCode: number
  details?: unknown

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message)

    this.statusCode = statusCode
    this.details = details
  }
}

function handleExchangeError(
  error: unknown,
  res: Response,
  next: NextFunction,
) {
  if (error instanceof ExchangeApiError) {
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
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    (
      error as {
        code?: string
      }
    ).code === '23505'
  )
}

function roundMoney(value: number) {
  return Number(value.toFixed(2))
}

function roundQuantity(value: number) {
  return Number(value.toFixed(3))
}

function createExchangeNumber() {
  const datePart = new Date().toISOString().slice(0, 10).replaceAll('-', '')

  const randomPart = randomBytes(4).toString('hex').toUpperCase()

  return `EX-${datePart}-${randomPart}`
}

function parseLimit(value: unknown) {
  const parsedValue = Number(value)

  if (!Number.isFinite(parsedValue)) {
    return 50
  }

  return Math.min(Math.max(Math.trunc(parsedValue), 1), 100)
}

function normalizeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

function reversePaymentDirection(
  direction: string,
): 'paid_by_customer' | 'refunded_to_customer' {
  if (direction === 'paid_by_customer') {
    return 'refunded_to_customer'
  }

  if (direction === 'refunded_to_customer') {
    return 'paid_by_customer'
  }

  throw new ExchangeApiError(
    409,
    'Exchange payment direction is invalid and cannot be reversed',
  )
}

async function loadExchangeDetails(companyId: string, exchangeId: string) {
  const exchangeResult = await db.query(
    `
      SELECT
        e.*,

        b.name
          AS branch_name,

        sl.name
          AS stock_location_name,

        c.name
          AS customer_name,

        s.sale_number
          AS original_sale_number,

        creator.full_name
          AS created_by_name,

        voider.full_name
          AS voided_by_name

      FROM exchanges e

      JOIN branches b
        ON b.id = e.branch_id
        AND b.company_id =
            e.company_id

      JOIN stock_locations sl
        ON sl.id =
           e.stock_location_id
        AND sl.company_id =
            e.company_id

      LEFT JOIN customers c
        ON c.id = e.customer_id
        AND c.company_id =
            e.company_id

      LEFT JOIN sales s
        ON s.id =
           e.original_sale_id
        AND s.company_id =
            e.company_id

      LEFT JOIN users creator
        ON creator.id =
           e.created_by
        AND creator.company_id =
            e.company_id
            
      LEFT JOIN users voider
        ON voider.id =
          e.voided_by
        AND voider.company_id =
            e.company_id

      WHERE e.company_id = $1
        AND e.id = $2

      LIMIT 1;
      `,
    [companyId, exchangeId],
  )

  if ((exchangeResult.rowCount ?? 0) === 0) {
    return null
  }

  const [
    returnItemsResult,
    issueItemsResult,
    paymentsResult,
    stockMovementsResult,
  ] = await Promise.all([
    db.query(
      `
      SELECT *

      FROM exchange_return_items

      WHERE company_id = $1
        AND exchange_id = $2

      ORDER BY
        created_at ASC,
        id ASC;
      `,
      [companyId, exchangeId],
    ),

    db.query(
      `
      SELECT *

      FROM exchange_issue_items

      WHERE company_id = $1
        AND exchange_id = $2

      ORDER BY
        created_at ASC,
        id ASC;
      `,
      [companyId, exchangeId],
    ),

    db.query(
      `
      SELECT *

      FROM exchange_payments

      WHERE company_id = $1
        AND exchange_id = $2

      ORDER BY
        created_at ASC,
        id ASC;
      `,
      [companyId, exchangeId],
    ),

    db.query(
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
        'exchange'
    AND sm.reference_id = $2

  ORDER BY
    sm.created_at ASC,
    sm.id ASC;
  `,
      [companyId, exchangeId],
    ),
  ])

  return {
    exchange: exchangeResult.rows[0],

    returnItems: returnItemsResult.rows,

    issueItems: issueItemsResult.rows,

    payments: paymentsResult.rows,

    stockMovements: stockMovementsResult.rows,
  }
}

// ======================================================
// GET /api/exchanges/original-sale/:saleId
//
// يرجع الفاتورة الأصلية والكميات المتبقية
// القابلة للإرجاع أو الاستبدال.
// ======================================================
exchangesRouter.get(
  '/api/exchanges/original-sale/:saleId',

  async (req, res, next) => {
    try {
      const auth = getAuthContext(res)

      const saleId = normalizeParam(req.params.saleId)

      if (typeof saleId !== 'string' || !uuidPattern.test(saleId)) {
        return res.status(400).json({
          error: 'saleId is invalid',
        })
      }

      const saleResult = await db.query(
        `
          SELECT
            s.id,
            s.sale_number,
            s.branch_id,
            s.stock_location_id,
            s.customer_id,
            s.total,
            s.status,
            s.occurred_at,

            b.name
              AS branch_name,

            sl.name
              AS stock_location_name,

            c.name
              AS customer_name

          FROM sales s

          JOIN branches b
            ON b.id = s.branch_id
            AND b.company_id =
                s.company_id

          JOIN stock_locations sl
            ON sl.id =
               s.stock_location_id
            AND sl.company_id =
                s.company_id

          LEFT JOIN customers c
            ON c.id =
               s.customer_id
            AND c.company_id =
                s.company_id

          WHERE s.company_id = $1
            AND s.id = $2
            AND s.status =
                'completed'

            AND (
              $3::uuid IS NULL
              OR s.branch_id =
                 $3::uuid
            )

          LIMIT 1;
          `,
        [auth.companyId, saleId, auth.branchId],
      )

      if ((saleResult.rowCount ?? 0) === 0) {
        return res.status(404).json({
          error: 'Completed sale was not found or belongs to another branch',
        })
      }

      const itemsResult = await db.query(
        `
          SELECT
            si.id,
            si.variant_id,

            si.sku_snapshot,
            si.barcode_snapshot,
            si.product_name_snapshot,
            si.size_snapshot,
            si.color_snapshot,

            si.quantity,
            si.unit_price,
            si.line_total,

            COALESCE(
              (
                SELECT
                  SUM(ri.quantity)

                FROM return_items ri

                JOIN returns r
                  ON r.id =
                     ri.return_id
                  AND r.company_id =
                      ri.company_id

                WHERE ri.company_id =
                      si.company_id

                  AND ri.original_sale_item_id =
                      si.id

                  AND r.status IN (
                    'completed',
                    'pending_review'
                  )
              ),
              0
            )
            +
            COALESCE(
              (
                SELECT
                  SUM(eri.quantity)

                FROM exchange_return_items eri

                JOIN exchanges e
                  ON e.id =
                     eri.exchange_id
                  AND e.company_id =
                      eri.company_id

                WHERE eri.company_id =
                      si.company_id

                  AND eri.original_sale_item_id =
                      si.id

                  AND e.status IN (
                    'completed',
                    'pending_review'
                  )
              ),
              0
            )
              AS previously_returned_quantity

          FROM sale_items si

          WHERE si.company_id = $1
            AND si.sale_id = $2

          ORDER BY
            si.created_at ASC,
            si.id ASC;
          `,
        [auth.companyId, saleId],
      )

      return res.json({
        data: {
          sale: saleResult.rows[0],

          items: itemsResult.rows.map((item) => ({
            ...item,

            remaining_returnable_quantity: roundQuantity(
              Number(item.quantity) - Number(item.previously_returned_quantity),
            ),
          })),
        },
      })
    } catch (error) {
      return handleExchangeError(error, res, next)
    }
  },
)

// ======================================================
// GET /api/exchanges/lookup-item
//
// البحث عن الصنف الذي سيتم تسليمه للعميل.
// ======================================================
exchangesRouter.get(
  '/api/exchanges/lookup-item',

  async (req, res, next) => {
    try {
      const auth = getAuthContext(res)

      const query =
        typeof req.query.query === 'string' ? req.query.query.trim() : ''

      if (query.length === 0 || query.length > 100) {
        return res.status(400).json({
          error: 'query is required and must not exceed 100 characters',
        })
      }

      const result = await db.query(
        `
          SELECT
            pv.id,
            pv.product_id,
            pv.sku,
            pv.style_code,
            pv.primary_barcode,
            pv.selling_price,

            p.name
              AS product_name,

            fs.name
              AS size_name,

            fc.name
              AS color_name

          FROM product_variants pv

          JOIN products p
            ON p.id =
               pv.product_id
            AND p.company_id =
                pv.company_id
            AND p.status =
                'active'

          LEFT JOIN fashion_sizes fs
            ON fs.id = pv.size_id
            AND fs.company_id =
                pv.company_id

          LEFT JOIN fashion_colors fc
            ON fc.id = pv.color_id
            AND fc.company_id =
                pv.company_id

          WHERE pv.company_id = $1
            AND pv.status =
                'active'

            AND (
              LOWER(pv.sku) =
                LOWER($2)

              OR LOWER(
                COALESCE(
                  pv.primary_barcode,
                  ''
                )
              ) = LOWER($2)

              OR LOWER(p.name)
                LIKE LOWER(
                  '%' || $2 || '%'
                )

              OR LOWER(pv.sku)
                LIKE LOWER(
                  '%' || $2 || '%'
                )
            )

          ORDER BY
            CASE
              WHEN LOWER(pv.sku) =
                   LOWER($2)
              THEN 1

              WHEN LOWER(
                COALESCE(
                  pv.primary_barcode,
                  ''
                )
              ) = LOWER($2)
              THEN 2

              ELSE 3
            END,

            p.name ASC,
            pv.sku ASC

          LIMIT 20;
          `,
        [auth.companyId, query],
      )

      return res.json({
        data: result.rows,
      })
    } catch (error) {
      return handleExchangeError(error, res, next)
    }
  },
)

// ======================================================
// GET /api/exchanges
// ======================================================
exchangesRouter.get(
  '/api/exchanges',

  async (req, res, next) => {
    try {
      const auth = getAuthContext(res)

      const requestedBranchId =
        typeof req.query.branchId === 'string' && req.query.branchId.trim()
          ? req.query.branchId.trim()
          : null

      const branchId = auth.branchId ?? requestedBranchId

      const status =
        typeof req.query.status === 'string' && req.query.status.trim()
          ? req.query.status.trim()
          : null

      const allowedStatuses = new Set([
        'draft',
        'completed',
        'voided',
        'pending_review',
      ])

      if (status && !allowedStatuses.has(status)) {
        return res.status(400).json({
          error: 'Unsupported exchange status',
        })
      }

      const result = await db.query(
        `
          SELECT
            e.id,
            e.exchange_number,
            e.original_sale_id,

            s.sale_number
              AS original_sale_number,

            e.branch_id,
            b.name
              AS branch_name,

            e.stock_location_id,
            sl.name
              AS stock_location_name,

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

            e.void_reason,
            e.voided_by,

            voider.full_name
              AS voided_by_name,

            e.voided_at,
            e.created_at,

            COUNT(
              DISTINCT eri.id
            )::int
              AS return_items_count,

            COUNT(
              DISTINCT eii.id
            )::int
              AS issue_items_count

          FROM exchanges e

          JOIN branches b
            ON b.id = e.branch_id
            AND b.company_id =
                e.company_id

          JOIN stock_locations sl
            ON sl.id =
               e.stock_location_id
            AND sl.company_id =
                e.company_id

          LEFT JOIN customers c
            ON c.id =
               e.customer_id
            AND c.company_id =
                e.company_id

          LEFT JOIN sales s
            ON s.id =
               e.original_sale_id
            AND s.company_id =
                e.company_id

          LEFT JOIN users voider
            ON voider.id =
              e.voided_by
            AND voider.company_id =
                e.company_id

          LEFT JOIN
            exchange_return_items eri
            ON eri.exchange_id = e.id
            AND eri.company_id =
                e.company_id

          LEFT JOIN
            exchange_issue_items eii
            ON eii.exchange_id = e.id
            AND eii.company_id =
                e.company_id

          WHERE e.company_id = $1

            AND (
              $2::uuid IS NULL
              OR e.branch_id =
                 $2::uuid
            )

            AND (
              $3::text IS NULL
              OR e.status =
                 $3::text
            )

          GROUP BY
            e.id,
            s.sale_number,
            b.name,
            sl.name,
            c.name,
            voider.full_name

          ORDER BY
            e.created_at DESC

          LIMIT $4;
          `,
        [auth.companyId, branchId, status, parseLimit(req.query.limit)],
      )

      return res.json({
        data: result.rows,
      })
    } catch (error) {
      return handleExchangeError(error, res, next)
    }
  },
)


// ======================================================
// POST /api/exchanges/:exchangeId/void
//
// Body:
// {
//   reason: string,
//   paymentReference?: string
// }
//
// الإلغاء:
// 1. يقفل الاستبدال.
// 2. يتأكد أنه مكتمل ولم يلغ سابقًا.
// 3. يتأكد أن المخزون يسمح بعكس العملية.
// 4. يعكس كل حركة مخزون أصلية.
// 5. يعكس كل حركة دفع أصلية.
// 6. يغير الحالة إلى voided.
// 7. يسجل Audit Log.
// ======================================================
exchangesRouter.post(
  '/api/exchanges/:exchangeId/void',

  async (req, res, next) => {
    const client =
      await db.connect()

    let transactionStarted =
      false

    try {
      const auth =
        getAuthContext(res)

      const exchangeId =
        normalizeParam(
          req.params.exchangeId,
        )

      if (
        typeof exchangeId !==
          'string' ||
        !uuidPattern.test(
          exchangeId,
        )
      ) {
        throw new ExchangeApiError(
          400,
          'exchangeId is invalid',
        )
      }

      const reason =
        typeof req.body?.reason ===
          'string'
          ? req.body.reason
              .trim()
              .slice(0, 500)
          : ''

      if (
        reason.length < 3
      ) {
        throw new ExchangeApiError(
          400,
          'Void reason must contain at least 3 characters',
        )
      }

      const paymentReference =
        typeof req.body
          ?.paymentReference ===
          'string' &&
        req.body.paymentReference
          .trim()
          ? req.body.paymentReference
              .trim()
              .slice(0, 120)
          : null

      await client.query('BEGIN')

      transactionStarted = true

      // ==================================================
      // Lock exchange header
      // ==================================================
      const exchangeResult =
        await client.query(
          `
          SELECT *

          FROM exchanges

          WHERE company_id = $1
            AND id = $2

            AND (
              $3::uuid IS NULL
              OR branch_id =
                 $3::uuid
            )

          FOR UPDATE;
          `,
          [
            auth.companyId,
            exchangeId,
            auth.branchId,
          ],
        )

      if (
        (exchangeResult.rowCount ??
          0) === 0
      ) {
        throw new ExchangeApiError(
          404,
          'Exchange was not found or belongs to another branch',
        )
      }

      const exchange =
        exchangeResult.rows[0]

      // إعادة نفس النتيجة بدون عكس العملية مرة أخرى.
      if (
        exchange.status ===
        'voided'
      ) {
        await client.query(
          'COMMIT',
        )

        transactionStarted = false

        const details =
          await loadExchangeDetails(
            auth.companyId,
            exchangeId,
          )

        return res.status(200).json({
          alreadyVoided: true,
          data: details,
        })
      }

      if (
        exchange.status !==
        'completed'
      ) {
        throw new ExchangeApiError(
          409,
          'Only completed exchanges can be voided',
        )
      }

      // ==================================================
      // Load original stock movements
      //
      // DESC مهم:
      // آخر حركة أصلية كانت تسليم الصنف البديل.
      // عند الإلغاء نسترجع الصنف البديل أولًا،
      // ثم نخصم الصنف الذي كان العميل قد أعاده.
      // ==================================================
      const originalMovementsResult =
        await client.query(
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
                'exchange'

            AND reference_id = $2
            AND movement_type =
                'exchange'

            AND reversal_of_movement_id
                IS NULL

          ORDER BY
            created_at DESC,
            id DESC

          FOR UPDATE;
          `,
          [
            auth.companyId,
            exchangeId,
          ],
        )

      const expectedMovementsResult =
        await client.query(
          `
          SELECT
            (
              SELECT COUNT(*)::int

              FROM exchange_return_items

              WHERE company_id = $1
                AND exchange_id = $2
            )
            +
            (
              SELECT COUNT(*)::int

              FROM exchange_issue_items

              WHERE company_id = $1
                AND exchange_id = $2
            )
              AS expected_count;
          `,
          [
            auth.companyId,
            exchangeId,
          ],
        )

      const expectedMovementCount =
        Number(
          expectedMovementsResult
            .rows[0]
            .expected_count,
        )

      const originalMovements =
        originalMovementsResult.rows

      if (
        originalMovements.length ===
          0 ||
        originalMovements.length !==
          expectedMovementCount
      ) {
        throw new ExchangeApiError(
          409,
          'Exchange stock movement history is incomplete and cannot be reversed safely',
          {
            expectedMovementCount,

            actualMovementCount:
              originalMovements.length,
          },
        )
      }

      const originalMovementIds =
        originalMovements.map(
          (movement) =>
            movement.id,
        )

      const existingStockReversalsResult =
        await client.query(
          `
          SELECT COUNT(*)::int
            AS reversal_count

          FROM stock_movements

          WHERE company_id = $1

            AND reversal_of_movement_id =
                ANY($2::uuid[]);
          `,
          [
            auth.companyId,
            originalMovementIds,
          ],
        )

      if (
        Number(
          existingStockReversalsResult
            .rows[0]
            .reversal_count,
        ) > 0
      ) {
        throw new ExchangeApiError(
          409,
          'Exchange already contains stock reversal movements',
        )
      }

      // ==================================================
      // Original settlement payments
      // ==================================================
      const originalPaymentsResult =
        await client.query(
          `
          SELECT *

          FROM exchange_payments

          WHERE company_id = $1
            AND exchange_id = $2

            AND payment_role =
                'settlement'

          ORDER BY
            created_at ASC,
            id ASC

          FOR UPDATE;
          `,
          [
            auth.companyId,
            exchangeId,
          ],
        )

      const existingPaymentReversalsResult =
        await client.query(
          `
          SELECT COUNT(*)::int
            AS reversal_count

          FROM exchange_payments

          WHERE company_id = $1
            AND exchange_id = $2

            AND payment_role =
                'void_reversal';
          `,
          [
            auth.companyId,
            exchangeId,
          ],
        )

      if (
        Number(
          existingPaymentReversalsResult
            .rows[0]
            .reversal_count,
        ) > 0
      ) {
        throw new ExchangeApiError(
          409,
          'Exchange already contains payment reversal records',
        )
      }

      // ==================================================
      // Prepare and lock stock balances
      // ==================================================
      const variantIds = [
        ...new Set(
          originalMovements.map(
            (movement) =>
              String(
                movement.variant_id,
              ),
          ),
        ),
      ].sort()

      for (
        const variantId of
        variantIds
      ) {
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
          [
            auth.companyId,
            exchange.branch_id,
            exchange.stock_location_id,
            variantId,
          ],
        )
      }

      const balancesResult =
        await client.query(
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
          [
            auth.companyId,
            exchange.stock_location_id,
            variantIds,
          ],
        )

      const runningBalances =
        new Map<string, number>(
          balancesResult.rows.map(
            (balance) => [
              String(
                balance.variant_id,
              ),

              Number(
                balance.quantity,
              ),
            ],
          ),
        )

      // ==================================================
      // Calculate final balances before changing anything
      //
      // Original:
      // + returned item
      // - issued item
      //
      // Void:
      // - returned item
      // + issued item
      // ==================================================
      const reversalByVariant =
        new Map<string, number>()

      for (
        const movement of
        originalMovements
      ) {
        const variantId =
          String(
            movement.variant_id,
          )

        const originalQuantity =
          Number(
            movement.quantity,
          )

        if (
          !Number.isFinite(
            originalQuantity,
          ) ||
          originalQuantity === 0
        ) {
          throw new ExchangeApiError(
            409,
            'Exchange contains an invalid stock movement',
            {
              movementId:
                movement.id,
            },
          )
        }

        const reversalQuantity =
          roundQuantity(
            -originalQuantity,
          )

        reversalByVariant.set(
          variantId,

          roundQuantity(
            (
              reversalByVariant.get(
                variantId,
              ) ?? 0
            ) + reversalQuantity,
          ),
        )
      }

      const shortages =
        variantIds
          .map((variantId) => {
            const currentQuantity =
              runningBalances.get(
                variantId,
              ) ?? 0

            const reversalQuantity =
              reversalByVariant.get(
                variantId,
              ) ?? 0

            const finalQuantity =
              roundQuantity(
                currentQuantity +
                  reversalQuantity,
              )

            return {
              variantId,
              currentQuantity,
              reversalQuantity,
              finalQuantity,
            }
          })
          .filter(
            (item) =>
              item.finalQuantity <
              0,
          )

      if (
        shortages.length > 0
      ) {
        throw new ExchangeApiError(
          409,
          'Stock is insufficient to void this exchange safely',
          {
            shortages,
          },
        )
      }

      // ==================================================
      // Reverse stock movements
      // ==================================================
      const createdStockReversalIds:
        string[] = []

      for (
        const originalMovement of
        originalMovements
      ) {
        const variantId =
          String(
            originalMovement
              .variant_id,
          )

        const quantityBefore =
          runningBalances.get(
            variantId,
          ) ?? 0

        const reversalQuantity =
          roundQuantity(
            -Number(
              originalMovement
                .quantity,
            ),
          )

        const quantityAfter =
          roundQuantity(
            quantityBefore +
              reversalQuantity,
          )

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
            exchange.branch_id,
            auth.companyId,
            exchange.stock_location_id,
            variantId,
          ],
        )

        const reversalResult =
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

              reversal_of_movement_id,

              note,
              created_by
            )
            VALUES (
              $1, $2, $3, $4,
              'exchange',
              $5, $6, $7,
              'exchange',
              $8,
              $9,
              $10,
              $11
            )

            RETURNING id;
            `,
            [
              auth.companyId,
              exchange.branch_id,
              exchange.stock_location_id,
              variantId,

              reversalQuantity,
              quantityBefore,
              quantityAfter,

              exchangeId,

              originalMovement.id,

              `Void reversal for exchange ${exchange.exchange_number}`,

              auth.userId,
            ],
          )

        createdStockReversalIds.push(
          reversalResult.rows[0].id,
        )

        runningBalances.set(
          variantId,
          quantityAfter,
        )
      }

      // ==================================================
      // Reverse exchange payments
      // ==================================================
      const createdPaymentReversalIds:
        string[] = []

      for (
        const originalPayment of
        originalPaymentsResult.rows
      ) {
        const reversedDirection =
          reversePaymentDirection(
            originalPayment
              .payment_direction,
          )

        const originalReference =
          typeof originalPayment
            .reference ===
            'string' &&
          originalPayment.reference
            .trim()
            ? originalPayment.reference.trim()
            : null

        const combinedReference = [
          `Void ${exchange.exchange_number}`,

          paymentReference,

          originalReference
            ? `Original: ${originalReference}`
            : null,
        ]
          .filter(Boolean)
          .join(' | ')
          .slice(0, 200)

        const reversalResult =
          await client.query(
            `
            INSERT INTO exchange_payments (
              company_id,
              exchange_id,

              payment_direction,
              method,
              amount,
              reference,

              payment_role,
              reverses_payment_id
            )
            VALUES (
              $1, $2,
              $3, $4, $5, $6,
              'void_reversal',
              $7
            )

            RETURNING id;
            `,
            [
              auth.companyId,
              exchangeId,

              reversedDirection,
              originalPayment.method,
              originalPayment.amount,
              combinedReference ||
                null,

              originalPayment.id,
            ],
          )

        createdPaymentReversalIds.push(
          reversalResult.rows[0].id,
        )
      }

      // ==================================================
      // Mark exchange as voided
      // ==================================================
      const voidedExchangeResult =
        await client.query(
          `
          UPDATE exchanges

          SET
            status = 'voided',
            void_reason = $1,
            voided_by = $2,
            voided_at = NOW()

          WHERE company_id = $3
            AND id = $4

          RETURNING *;
          `,
          [
            reason,
            auth.userId,

            auth.companyId,
            exchangeId,
          ],
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
          'exchange.void',
          'exchange',
          $4,
          $5::jsonb,
          $6::jsonb,
          $7,
          $8
        );
        `,
        [
          auth.companyId,
          exchange.branch_id,
          auth.userId,

          exchangeId,

          JSON.stringify({
            status:
              exchange.status,

            returnedTotal:
              exchange.returned_total,

            issuedTotal:
              exchange.issued_total,

            differenceTotal:
              exchange.difference_total,
          }),

          JSON.stringify({
            status: 'voided',

            reason,

            stockReversalIds:
              createdStockReversalIds,

            paymentReversalIds:
              createdPaymentReversalIds,
          }),

          req.ip || null,

          req.get(
            'user-agent',
          ) || null,
        ],
      )

      await client.query('COMMIT')

      transactionStarted = false

      const details =
        await loadExchangeDetails(
          auth.companyId,
          voidedExchangeResult
            .rows[0].id,
        )

      return res.json({
        alreadyVoided: false,
        data: details,
      })
    } catch (error) {
      if (transactionStarted) {
        await client
          .query('ROLLBACK')
          .catch(() => {})

        transactionStarted = false
      }

      return handleExchangeError(
        error,
        res,
        next,
      )
    } finally {
      client.release()
    }
  },
)

// ======================================================
// GET /api/exchanges/:exchangeId
// ======================================================
exchangesRouter.get(
  '/api/exchanges/:exchangeId',

  async (req, res, next) => {
    try {
      const auth = getAuthContext(res)

      const exchangeId = normalizeParam(req.params.exchangeId)

      if (typeof exchangeId !== 'string' || !uuidPattern.test(exchangeId)) {
        return res.status(400).json({
          error: 'exchangeId is invalid',
        })
      }

      const details = await loadExchangeDetails(auth.companyId, exchangeId)

      if (!details) {
        return res.status(404).json({
          error: 'Exchange was not found',
        })
      }

      if (auth.branchId && details.exchange.branch_id !== auth.branchId) {
        return res.status(404).json({
          error: 'Exchange was not found',
        })
      }

      return res.json({
        data: details,
      })
    } catch (error) {
      return handleExchangeError(error, res, next)
    }
  },
)

// ======================================================
// POST /api/exchanges
//
// Body:
// {
//   originalSaleId,
//   idempotencyKey,
//   reason,
//   returnItems: [
//     {
//       originalSaleItemId,
//       quantity
//     }
//   ],
//   issueItems: [
//     {
//       variantId,
//       quantity
//     }
//   ],
//   payments: [
//     {
//       paymentDirection,
//       method,
//       amount,
//       reference
//     }
//   ]
// }
// ======================================================
exchangesRouter.post(
  '/api/exchanges',

  async (req, res, next) => {
    const client = await db.connect()

    let transactionStarted = false

    let idempotencyKey = ''

    try {
      const auth = getAuthContext(res)

      const originalSaleId =
        typeof req.body?.originalSaleId === 'string'
          ? req.body.originalSaleId.trim()
          : ''

      idempotencyKey =
        typeof req.body?.idempotencyKey === 'string'
          ? req.body.idempotencyKey.trim()
          : ''

      const reason =
        typeof req.body?.reason === 'string' && req.body.reason.trim()
          ? req.body.reason.trim().slice(0, 500)
          : null

      const returnItems = req.body?.returnItems

      const issueItems = req.body?.issueItems

      const payments = Array.isArray(req.body?.payments)
        ? req.body.payments
        : []

      if (!uuidPattern.test(originalSaleId)) {
        throw new ExchangeApiError(400, 'originalSaleId is invalid')
      }

      if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
        throw new ExchangeApiError(
          400,
          'idempotencyKey must contain between 8 and 200 characters',
        )
      }

      if (
        !Array.isArray(returnItems) ||
        returnItems.length === 0 ||
        returnItems.length > 100
      ) {
        throw new ExchangeApiError(
          400,
          'returnItems must contain between 1 and 100 entries',
        )
      }

      if (
        !Array.isArray(issueItems) ||
        issueItems.length === 0 ||
        issueItems.length > 100
      ) {
        throw new ExchangeApiError(
          400,
          'issueItems must contain between 1 and 100 entries',
        )
      }

      if (payments.length > 20) {
        throw new ExchangeApiError(400, 'payments must not exceed 20 entries')
      }

      const existingResult = await db.query(
        `
          SELECT id

          FROM exchanges

          WHERE company_id = $1
            AND idempotency_key = $2

          LIMIT 1;
          `,
        [auth.companyId, idempotencyKey],
      )

      if ((existingResult.rowCount ?? 0) > 0) {
        const existingDetails = await loadExchangeDetails(
          auth.companyId,
          existingResult.rows[0].id,
        )

        return res.status(200).json({
          duplicated: true,
          data: existingDetails,
        })
      }

      await client.query('BEGIN')

      transactionStarted = true

      const saleResult = await client.query(
        `
          SELECT
            s.id,
            s.branch_id,
            s.stock_location_id,
            s.customer_id,
            s.status,

            b.is_active
              AS branch_is_active,

            sl.is_active
              AS stock_location_is_active

          FROM sales s

          JOIN branches b
            ON b.id = s.branch_id
            AND b.company_id =
                s.company_id

          JOIN stock_locations sl
            ON sl.id =
               s.stock_location_id
            AND sl.company_id =
                s.company_id

          WHERE s.company_id = $1
            AND s.id = $2
            AND s.status =
                'completed'

            AND b.is_active = TRUE
            AND sl.is_active = TRUE

            AND (
              $3::uuid IS NULL
              OR s.branch_id =
                 $3::uuid
            )

          FOR SHARE OF s;
          `,
        [auth.companyId, originalSaleId, auth.branchId],
      )

      if ((saleResult.rowCount ?? 0) === 0) {
        throw new ExchangeApiError(
          404,
          'Completed original sale was not found, inactive, or belongs to another branch',
        )
      }

      const trustedSale = saleResult.rows[0]

      const trustedBranchId = trustedSale.branch_id

      const trustedStockLocationId = trustedSale.stock_location_id

      const trustedCustomerId = trustedSale.customer_id

      const preparedReturnItems: PreparedReturnItem[] = []

      const preparedIssueItems: PreparedIssueItem[] = []

      const usedOriginalSaleItemIds = new Set<string>()

      const usedIssueVariantIds = new Set<string>()

      let returnedTotal = 0
      let issuedTotal = 0

      const orderedReturnItems = [...returnItems].sort(
        (firstItem, secondItem) =>
          String(firstItem?.originalSaleItemId ?? '').localeCompare(
            String(secondItem?.originalSaleItemId ?? ''),
          ),
      )

      for (const rawItem of orderedReturnItems) {
        const originalSaleItemId =
          typeof rawItem?.originalSaleItemId === 'string'
            ? rawItem.originalSaleItemId.trim()
            : ''

        const quantity = roundQuantity(Number(rawItem?.quantity))

        if (!uuidPattern.test(originalSaleItemId)) {
          throw new ExchangeApiError(400, 'originalSaleItemId is invalid')
        }

        if (usedOriginalSaleItemIds.has(originalSaleItemId)) {
          throw new ExchangeApiError(
            400,
            'The same original sale item cannot be repeated',
          )
        }

        if (!Number.isFinite(quantity) || quantity <= 0) {
          throw new ExchangeApiError(
            400,
            'Return quantity must be greater than zero',
          )
        }

        usedOriginalSaleItemIds.add(originalSaleItemId)

        const saleItemResult = await client.query(
          `
            SELECT
              si.id,
              si.variant_id,

              si.sku_snapshot,
              si.barcode_snapshot,
              si.product_name_snapshot,
              si.size_snapshot,
              si.color_snapshot,

              si.quantity
                AS sold_quantity,

              si.unit_price,
              si.line_total

            FROM sale_items si

            WHERE si.company_id = $1
              AND si.sale_id = $2
              AND si.id = $3

            FOR UPDATE OF si;
            `,
          [auth.companyId, originalSaleId, originalSaleItemId],
        )

        if ((saleItemResult.rowCount ?? 0) === 0) {
          throw new ExchangeApiError(404, 'Original sale item was not found')
        }

        const saleItem = saleItemResult.rows[0]

        const previouslyReturnedResult = await client.query(
          `
            SELECT
              COALESCE(
                (
                  SELECT
                    SUM(ri.quantity)

                  FROM return_items ri

                  JOIN returns r
                    ON r.id =
                       ri.return_id
                    AND r.company_id =
                        ri.company_id

                  WHERE ri.company_id =
                        $1

                    AND ri.original_sale_item_id =
                        $2

                    AND r.status IN (
                      'completed',
                      'pending_review'
                    )
                ),
                0
              )
              +
              COALESCE(
                (
                  SELECT
                    SUM(eri.quantity)

                  FROM exchange_return_items eri

                  JOIN exchanges e
                    ON e.id =
                       eri.exchange_id
                    AND e.company_id =
                        eri.company_id

                  WHERE eri.company_id =
                        $1

                    AND eri.original_sale_item_id =
                        $2

                    AND e.status IN (
                      'completed',
                      'pending_review'
                    )
                ),
                0
              )
                AS returned_quantity;
            `,
          [auth.companyId, originalSaleItemId],
        )

        const soldQuantity = Number(saleItem.sold_quantity)

        const previouslyReturnedQuantity = Number(
          previouslyReturnedResult.rows[0].returned_quantity,
        )

        const remainingQuantity = roundQuantity(
          soldQuantity - previouslyReturnedQuantity,
        )

        if (quantity > remainingQuantity) {
          throw new ExchangeApiError(
            409,
            'Exchange return quantity exceeds the remaining returnable quantity',
            {
              originalSaleItemId,

              soldQuantity,

              previouslyReturnedQuantity,

              remainingQuantity,

              requestedQuantity: quantity,
            },
          )
        }

        const originalLineTotal = Number(saleItem.line_total)

        const refundableUnitAmount =
          soldQuantity > 0 ? originalLineTotal / soldQuantity : 0

        const lineTotal = roundMoney(refundableUnitAmount * quantity)

        returnedTotal = roundMoney(returnedTotal + lineTotal)

        preparedReturnItems.push({
          originalSaleItemId,

          variantId: saleItem.variant_id,

          skuSnapshot: saleItem.sku_snapshot,

          barcodeSnapshot: saleItem.barcode_snapshot,

          productNameSnapshot: saleItem.product_name_snapshot,

          sizeSnapshot: saleItem.size_snapshot,

          colorSnapshot: saleItem.color_snapshot,

          quantity,

          unitPrice: roundMoney(Number(saleItem.unit_price)),

          lineTotal,
        })
      }

      const orderedIssueItems = [...issueItems].sort((firstItem, secondItem) =>
        String(firstItem?.variantId ?? '').localeCompare(
          String(secondItem?.variantId ?? ''),
        ),
      )

      for (const rawItem of orderedIssueItems) {
        const variantId =
          typeof rawItem?.variantId === 'string' ? rawItem.variantId.trim() : ''

        const quantity = roundQuantity(Number(rawItem?.quantity))

        if (!uuidPattern.test(variantId)) {
          throw new ExchangeApiError(400, 'Issue variantId is invalid')
        }

        if (usedIssueVariantIds.has(variantId)) {
          throw new ExchangeApiError(
            400,
            'The same issue variant cannot be repeated',
          )
        }

        if (!Number.isFinite(quantity) || quantity <= 0) {
          throw new ExchangeApiError(
            400,
            'Issue quantity must be greater than zero',
          )
        }

        usedIssueVariantIds.add(variantId)

        const variantResult = await client.query(
          `
            SELECT
              pv.id,
              pv.sku,
              pv.primary_barcode,
              pv.selling_price,

              p.name
                AS product_name,

              fs.name
                AS size_name,

              fc.name
                AS color_name

            FROM product_variants pv

            JOIN products p
              ON p.id =
                 pv.product_id
              AND p.company_id =
                  pv.company_id
              AND p.status =
                  'active'

            LEFT JOIN fashion_sizes fs
              ON fs.id =
                 pv.size_id
              AND fs.company_id =
                  pv.company_id

            LEFT JOIN fashion_colors fc
              ON fc.id =
                 pv.color_id
              AND fc.company_id =
                  pv.company_id

            WHERE pv.company_id = $1
              AND pv.id = $2
              AND pv.status =
                  'active'

            LIMIT 1;
            `,
          [auth.companyId, variantId],
        )

        if ((variantResult.rowCount ?? 0) === 0) {
          throw new ExchangeApiError(
            404,
            'Issue product variant was not found or is inactive',
          )
        }

        const variant = variantResult.rows[0]

        const unitPrice = roundMoney(Number(variant.selling_price))

        const lineTotal = roundMoney(unitPrice * quantity)

        issuedTotal = roundMoney(issuedTotal + lineTotal)

        preparedIssueItems.push({
          variantId,

          skuSnapshot: variant.sku,

          barcodeSnapshot: variant.primary_barcode,

          productNameSnapshot: variant.product_name,

          sizeSnapshot: variant.size_name,

          colorSnapshot: variant.color_name,

          quantity,
          unitPrice,

          discountAmount: 0,

          lineTotal,
        })
      }

      const differenceTotal = roundMoney(issuedTotal - returnedTotal)

      const expectedDirection =
        differenceTotal > 0
          ? 'paid_by_customer'
          : differenceTotal < 0
            ? 'refunded_to_customer'
            : null

      const expectedPaymentTotal = roundMoney(Math.abs(differenceTotal))

      const preparedPayments: PreparedPayment[] = []

      if (expectedDirection === null && payments.length > 0) {
        throw new ExchangeApiError(
          400,
          'Payments are not allowed when exchange difference is zero',
        )
      }

      if (expectedDirection !== null && payments.length === 0) {
        throw new ExchangeApiError(
          400,
          'Payment or refund details are required for the exchange difference',
        )
      }

      let submittedPaymentTotal = 0

      for (const rawPayment of payments) {
        const paymentDirection = rawPayment?.paymentDirection

        const method =
          typeof rawPayment?.method === 'string' ? rawPayment.method.trim() : ''

        const amount = roundMoney(Number(rawPayment?.amount))

        const reference =
          typeof rawPayment?.reference === 'string' &&
          rawPayment.reference.trim()
            ? rawPayment.reference.trim().slice(0, 200)
            : null

        if (paymentDirection !== expectedDirection) {
          throw new ExchangeApiError(
            400,
            `paymentDirection must be ${expectedDirection}`,
          )
        }

        if (!allowedPaymentMethods.has(method)) {
          throw new ExchangeApiError(400, 'Unsupported exchange payment method')
        }

        if (!Number.isFinite(amount) || amount <= 0) {
          throw new ExchangeApiError(
            400,
            'Exchange payment amount must be greater than zero',
          )
        }

        submittedPaymentTotal = roundMoney(submittedPaymentTotal + amount)

        preparedPayments.push({
          paymentDirection,
          method,
          amount,
          reference,
        })
      }

      if (Math.abs(submittedPaymentTotal - expectedPaymentTotal) > 0.01) {
        throw new ExchangeApiError(
          400,
          'Exchange payment total does not match the calculated difference',
          {
            expectedPaymentTotal,
            submittedPaymentTotal,
          },
        )
      }

      const paidDifferenceTotal = differenceTotal > 0 ? expectedPaymentTotal : 0

      const refundedDifferenceTotal =
        differenceTotal < 0 ? expectedPaymentTotal : 0

      const variantIds = [
        ...new Set([
          ...preparedReturnItems.map((item) => item.variantId),

          ...preparedIssueItems.map((item) => item.variantId),
        ]),
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
          [auth.companyId, trustedBranchId, trustedStockLocationId, variantId],
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
        [auth.companyId, trustedStockLocationId, variantIds],
      )

      const currentBalances = new Map<string, number>(
        balancesResult.rows.map((row) => [
          row.variant_id,

          Number(row.quantity),
        ]),
      )

      const returnedByVariant = new Map<string, number>()

      const issuedByVariant = new Map<string, number>()

      for (const item of preparedReturnItems) {
        returnedByVariant.set(
          item.variantId,

          roundQuantity(
            (returnedByVariant.get(item.variantId) ?? 0) + item.quantity,
          ),
        )
      }

      for (const item of preparedIssueItems) {
        issuedByVariant.set(
          item.variantId,

          roundQuantity(
            (issuedByVariant.get(item.variantId) ?? 0) + item.quantity,
          ),
        )
      }

      const shortages = variantIds
        .map((variantId) => {
          const currentQuantity = currentBalances.get(variantId) ?? 0

          const returnedQuantity = returnedByVariant.get(variantId) ?? 0

          const issuedQuantity = issuedByVariant.get(variantId) ?? 0

          const availableAfterReturns = roundQuantity(
            currentQuantity + returnedQuantity,
          )

          const finalQuantity = roundQuantity(
            availableAfterReturns - issuedQuantity,
          )

          return {
            variantId,

            currentQuantity,
            returnedQuantity,
            issuedQuantity,

            availableAfterReturns,
            finalQuantity,
          }
        })
        .filter((item) => item.finalQuantity < 0)

      if (shortages.length > 0) {
        throw new ExchangeApiError(
          409,
          'Stock is insufficient for the issued exchange items',
          {
            shortages,
          },
        )
      }

      const exchangeNumber = createExchangeNumber()

      const exchangeResult = await client.query(
        `
          INSERT INTO exchanges (
            company_id,
            branch_id,
            stock_location_id,

            customer_id,
            original_sale_id,

            exchange_number,
            source,
            idempotency_key,

            returned_total,
            issued_total,
            difference_total,

            paid_difference_total,
            refunded_difference_total,

            status,
            reason,
            created_by,
            synced_at
          )
          VALUES (
            $1, $2, $3,
            $4, $5,
            $6,
            'web_admin',
            $7,
            $8, $9, $10,
            $11, $12,
            'completed',
            $13,
            $14,
            NOW()
          )

          RETURNING *;
          `,
        [
          auth.companyId,
          trustedBranchId,
          trustedStockLocationId,

          trustedCustomerId,
          originalSaleId,

          exchangeNumber,
          idempotencyKey,

          returnedTotal,
          issuedTotal,
          differenceTotal,

          paidDifferenceTotal,
          refundedDifferenceTotal,

          reason,
          auth.userId,
        ],
      )

      const exchange = exchangeResult.rows[0]

      for (const item of preparedReturnItems) {
        await client.query(
          `
          INSERT INTO exchange_return_items (
            company_id,
            exchange_id,

            original_sale_item_id,
            variant_id,

            sku_snapshot,
            barcode_snapshot,
            product_name_snapshot,
            size_snapshot,
            color_snapshot,

            quantity,
            unit_price,
            line_total
          )
          VALUES (
            $1, $2,
            $3, $4,
            $5, $6, $7, $8, $9,
            $10, $11, $12
          );
          `,
          [
            auth.companyId,
            exchange.id,

            item.originalSaleItemId,
            item.variantId,

            item.skuSnapshot,
            item.barcodeSnapshot,
            item.productNameSnapshot,
            item.sizeSnapshot,
            item.colorSnapshot,

            item.quantity,
            item.unitPrice,
            item.lineTotal,
          ],
        )
      }

      for (const item of preparedIssueItems) {
        await client.query(
          `
          INSERT INTO exchange_issue_items (
            company_id,
            exchange_id,
            variant_id,

            sku_snapshot,
            barcode_snapshot,
            product_name_snapshot,
            size_snapshot,
            color_snapshot,

            quantity,
            unit_price,
            discount_amount,
            line_total
          )
          VALUES (
            $1, $2, $3,
            $4, $5, $6, $7, $8,
            $9, $10, $11, $12
          );
          `,
          [
            auth.companyId,
            exchange.id,
            item.variantId,

            item.skuSnapshot,
            item.barcodeSnapshot,
            item.productNameSnapshot,
            item.sizeSnapshot,
            item.colorSnapshot,

            item.quantity,
            item.unitPrice,
            item.discountAmount,
            item.lineTotal,
          ],
        )
      }

      const runningBalances = new Map(currentBalances)

      for (const item of preparedReturnItems) {
        const quantityBefore = runningBalances.get(item.variantId) ?? 0

        const quantityAfter = roundQuantity(quantityBefore + item.quantity)

        await client.query(
          `
          UPDATE stock_balances

          SET
            quantity = $1,
            updated_at = NOW()

          WHERE company_id = $2
            AND stock_location_id =
                $3
            AND variant_id = $4;
          `,
          [
            quantityAfter,

            auth.companyId,
            trustedStockLocationId,
            item.variantId,
          ],
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
            'exchange',
            $5, $6, $7,
            'exchange',
            $8, $9, $10
          );
          `,
          [
            auth.companyId,
            trustedBranchId,
            trustedStockLocationId,
            item.variantId,

            item.quantity,
            quantityBefore,
            quantityAfter,

            exchange.id,

            `Exchange returned item ${exchangeNumber}`,

            auth.userId,
          ],
        )

        runningBalances.set(item.variantId, quantityAfter)
      }

      for (const item of preparedIssueItems) {
        const quantityBefore = runningBalances.get(item.variantId) ?? 0

        const quantityAfter = roundQuantity(quantityBefore - item.quantity)

        await client.query(
          `
          UPDATE stock_balances

          SET
            quantity = $1,
            updated_at = NOW()

          WHERE company_id = $2
            AND stock_location_id =
                $3
            AND variant_id = $4;
          `,
          [
            quantityAfter,

            auth.companyId,
            trustedStockLocationId,
            item.variantId,
          ],
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
            'exchange',
            $5, $6, $7,
            'exchange',
            $8, $9, $10
          );
          `,
          [
            auth.companyId,
            trustedBranchId,
            trustedStockLocationId,
            item.variantId,

            -Math.abs(item.quantity),

            quantityBefore,
            quantityAfter,

            exchange.id,

            `Exchange issued item ${exchangeNumber}`,

            auth.userId,
          ],
        )

        runningBalances.set(item.variantId, quantityAfter)
      }

      for (const payment of preparedPayments) {
        await client.query(
          `
          INSERT INTO exchange_payments (
            company_id,
            exchange_id,

            payment_direction,
            method,
            amount,
            reference
          )
          VALUES (
            $1, $2,
            $3, $4, $5, $6
          );
          `,
          [
            auth.companyId,
            exchange.id,

            payment.paymentDirection,
            payment.method,
            payment.amount,
            payment.reference,
          ],
        )
      }

      await client.query('COMMIT')

      transactionStarted = false

      const details = await loadExchangeDetails(auth.companyId, exchange.id)

      return res.status(201).json({
        duplicated: false,
        data: details,
      })
    } catch (error) {
      if (transactionStarted) {
        await client.query('ROLLBACK').catch(() => {})

        transactionStarted = false
      }

      if (isUniqueViolation(error) && idempotencyKey) {
        const auth = getAuthContext(res)

        const duplicateResult = await db.query(
          `
            SELECT id

            FROM exchanges

            WHERE company_id = $1
              AND idempotency_key = $2

            LIMIT 1;
            `,
          [auth.companyId, idempotencyKey],
        )

        if ((duplicateResult.rowCount ?? 0) > 0) {
          const details = await loadExchangeDetails(
            auth.companyId,
            duplicateResult.rows[0].id,
          )

          return res.status(200).json({
            duplicated: true,
            data: details,
          })
        }
      }

      return handleExchangeError(error, res, next)
    } finally {
      client.release()
    }
  },
)
