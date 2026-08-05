import { Router } from 'express'

import { db } from '../../db/pool'
import { getAuthContext } from '../auth/auth.middleware'

export const customerReceivablesRouter = Router()

class CustomerReceivablesApiError extends Error {
  statusCode: number
  details?: unknown

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message)

    this.statusCode = statusCode
    this.details = details
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const collectionMethods = new Set([
  'cash',
  'card',
  'wallet',
  'bank_transfer',
  'other',
])

function isUuid(value: string) {
  return uuidPattern.test(value)
}

function roundMoney(value: number) {
  return Number(value.toFixed(2))
}

function parsePositiveMoney(value: unknown) {
  const numericValue = Number(value)

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null
  }

  const roundedValue = roundMoney(numericValue)

  // قيمة موجبة قبل التقريب قد تتحول إلى صفر مالي.
  // مثال: 0.004 يجب رفضها بدل ترك PostgreSQL ترجع خطأ Constraint.
  if (roundedValue <= 0 || roundedValue > 99_999_999_999.99) {
    return null
  }

  return roundedValue
}

function parseNonNegativeMoney(value: unknown) {
  const numericValue = Number(value)

  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return null
  }

  const roundedValue = roundMoney(numericValue)

  if (roundedValue > 99_999_999_999.99) {
    return null
  }

  return roundedValue
}

function parseLimit(value: unknown) {
  const numericValue = Number(value ?? 100)

  if (!Number.isFinite(numericValue)) {
    return 100
  }

  return Math.min(Math.max(Math.trunc(numericValue), 1), 200)
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  )
}

async function loadCollectionByIdempotency(
  companyId: string,
  branchId: string | null,
  idempotencyKey: string,
) {
  const collectionResult = await db.query(
    `
      SELECT
        collection.*,

        customer.name
          AS customer_name

      FROM customer_collections collection

      JOIN customers customer
        ON customer.company_id =
           collection.company_id

        AND customer.id =
            collection.customer_id

      WHERE collection.company_id = $1
        AND collection.idempotency_key = $2

        AND (
          $3::uuid IS NULL
          OR collection.branch_id = $3
        )

      LIMIT 1;
    `,
    [companyId, idempotencyKey, branchId],
  )

  if ((collectionResult.rowCount ?? 0) === 0) {
    return null
  }

  const collection = collectionResult.rows[0]

  // الاستجابة المكررة يجب أن تطابق استجابة الإنشاء:
  // collection + payment + sale.
  const [paymentResult, saleResult] = await Promise.all([
    db.query(
      `
        SELECT *

        FROM payments

        WHERE company_id = $1
          AND customer_collection_id = $2

        LIMIT 1;
      `,
      [companyId, collection.id],
    ),

    db.query(
      `
        SELECT *

        FROM sales

        WHERE company_id = $1
          AND id = $2

          AND (
            $3::uuid IS NULL
            OR branch_id = $3
          )

        LIMIT 1;
      `,
      [companyId, collection.sale_id, branchId],
    ),
  ])

  const sale = saleResult.rows[0]

  if (!sale) {
    return null
  }

  return {
    collection,

    payment: paymentResult.rows[0] || null,

    sale,
  }
}

// ======================================================
// GET /api/receivables
//
// قائمة العملاء مع الرصيد والحد الائتماني.
// ======================================================
customerReceivablesRouter.get('/api/receivables', async (req, res, next) => {
  try {
    const auth = getAuthContext(res)

    const searchText =
      typeof req.query.q === 'string' && req.query.q.trim()
        ? `%${req.query.q.trim()}%`
        : null

    const onlyOutstanding =
      String(req.query.onlyOutstanding ?? '').toLowerCase() === 'true'

    const result = await db.query(
      `
          WITH scoped_sales AS (
            SELECT
              customer_id,
              outstanding_total,
              due_date

            FROM sales

            WHERE company_id = $1
              AND customer_id IS NOT NULL
              AND status <> 'voided'

              AND (
                $2::uuid IS NULL
                OR branch_id = $2
              )
          ),

          sales_summary AS (
            SELECT
              customer_id,

              COALESCE(
                SUM(outstanding_total),
                0
              ) AS outstanding_total,

              COALESCE(
                SUM(outstanding_total)
                FILTER (
                  WHERE outstanding_total > 0
                    AND due_date < CURRENT_DATE
                ),
                0
              ) AS overdue_total,

              COUNT(*)
                FILTER (
                  WHERE outstanding_total > 0
                )::integer AS open_sales_count,

              MIN(due_date)
                FILTER (
                  WHERE outstanding_total > 0
                ) AS oldest_due_date

            FROM scoped_sales

            GROUP BY customer_id
          ),

          collection_summary AS (
            SELECT
              collection.customer_id,

              MAX(
                collection.collected_at
              )
              FILTER (
                WHERE reversal_payment.id
                      IS NULL
              )
                AS last_collection_at,

              COALESCE(
                SUM(
                  collection.amount
                )
                FILTER (
                  WHERE reversal_payment.id
                        IS NULL
                ),
                0
              ) AS total_collected

            FROM customer_collections
                 collection

            -- كل تحصيل له Payment أصلية.
            LEFT JOIN payments
                      original_payment
              ON original_payment
                   .company_id =
                 collection.company_id

              AND original_payment
                   .customer_collection_id =
                 collection.id

              AND original_payment
                   .payment_role =
                 'sale_collection'

            -- عند إلغاء الفاتورة يتم إنشاء
            -- Payment عكسية مرتبطة بالأصلية.
            LEFT JOIN payments
                      reversal_payment
              ON reversal_payment
                   .company_id =
                 original_payment.company_id

              AND reversal_payment
                   .reverses_payment_id =
                 original_payment.id

              AND reversal_payment
                   .payment_role =
                 'void_reversal'

            WHERE collection.company_id = $1

              AND (
                $2::uuid IS NULL
                OR collection.branch_id = $2
              )

            GROUP BY
              collection.customer_id
          )

          SELECT
            customer.id AS customer_id,
            customer.name AS customer_name,
            customer.phone,
            customer.email,

            customer.allow_credit_sales,
            customer.credit_limit,
            customer.payment_terms_days,

            COALESCE(
              sale_summary.outstanding_total,
              0
            ) AS outstanding_total,

            COALESCE(
              sale_summary.overdue_total,
              0
            ) AS overdue_total,

            COALESCE(
              sale_summary.open_sales_count,
              0
            ) AS open_sales_count,

            sale_summary.oldest_due_date,

            COALESCE(
              collection_summary.total_collected,
              0
            ) AS total_collected,

            collection_summary.last_collection_at,

            GREATEST(
              customer.credit_limit -
              COALESCE(
                sale_summary.outstanding_total,
                0
              ),
              0
            ) AS credit_available

          FROM customers customer

          LEFT JOIN sales_summary sale_summary
            ON sale_summary.customer_id =
               customer.id

          LEFT JOIN collection_summary
            ON collection_summary.customer_id =
               customer.id

          WHERE customer.company_id = $1

            AND (
              $3::text IS NULL
              OR customer.name ILIKE $3
              OR customer.phone ILIKE $3
              OR customer.email ILIKE $3
            )

            AND (
              $4::boolean = FALSE

              OR COALESCE(
                sale_summary.outstanding_total,
                0
              ) > 0
            )

          ORDER BY
            COALESCE(
              sale_summary.outstanding_total,
              0
            ) DESC,

            customer.name ASC

          LIMIT $5;
        `,
      [
        auth.companyId,
        auth.branchId,
        searchText,
        onlyOutstanding,
        parseLimit(req.query.limit),
      ],
    )

    const summaryResult = await db.query(
      `
          SELECT
            COUNT(
              DISTINCT customer_id
            )
            FILTER (
              WHERE outstanding_total > 0
            )::integer
              AS customers_with_balance,

            COALESCE(
              SUM(outstanding_total),
              0
            ) AS total_outstanding,

            COALESCE(
              SUM(outstanding_total)
              FILTER (
                WHERE outstanding_total > 0
                  AND due_date < CURRENT_DATE
              ),
              0
            ) AS total_overdue,

            COUNT(
              DISTINCT customer_id
            )
            FILTER (
              WHERE outstanding_total > 0
                AND due_date < CURRENT_DATE
            )::integer
              AS overdue_customers

          FROM sales

          WHERE company_id = $1
            AND customer_id IS NOT NULL
            AND status <> 'voided'

            AND (
              $2::uuid IS NULL
              OR branch_id = $2
            );
        `,
      [auth.companyId, auth.branchId],
    )

    return res.json({
      data: result.rows,
      summary: summaryResult.rows[0],
    })
  } catch (error) {
    return next(error)
  }
})

// ======================================================
// GET /api/receivables/:customerId
//
// كشف حساب العميل.
// ======================================================
customerReceivablesRouter.get(
  '/api/receivables/:customerId',
  async (req, res, next) => {
    try {
      const auth = getAuthContext(res)

      const customerId = String(req.params.customerId || '')
        .trim()
        .toLowerCase()

      if (!isUuid(customerId)) {
        return res.status(400).json({
          error: 'customerId is invalid',
        })
      }

      const customerResult = await db.query(
        `
          SELECT
            id,
            name,
            phone,
            email,
            address,
            is_active,

            allow_credit_sales,
            credit_limit,
            payment_terms_days

          FROM customers

          WHERE company_id = $1
            AND id = $2

          LIMIT 1;
        `,
        [auth.companyId, customerId],
      )

      if ((customerResult.rowCount ?? 0) === 0) {
        return res.status(404).json({
          error: 'العميل غير موجود.',
        })
      }

      const salesResult = await db.query(
        `
          SELECT
            sale.id,
            sale.sale_number,

            sale.branch_id,
            branch.name AS branch_name,

            sale.total,
            sale.paid_total,
            sale.change_total,

            sale.payment_status,
            sale.outstanding_total,
            sale.due_date,

            sale.status,
            sale.occurred_at,
            sale.created_at

          FROM sales sale

          JOIN branches branch
            ON branch.company_id =
               sale.company_id

            AND branch.id =
                sale.branch_id

          WHERE sale.company_id = $1
            AND sale.customer_id = $2

            AND (
              $3::uuid IS NULL
              OR sale.branch_id = $3
            )

          ORDER BY
            CASE
              WHEN sale.outstanding_total > 0
              THEN 0
              ELSE 1
            END,

            sale.due_date ASC NULLS LAST,
            sale.occurred_at DESC;
        `,
        [auth.companyId, customerId, auth.branchId],
      )

      const collectionsResult = await db.query(
        `
          SELECT
            collection.*,

            sale.sale_number,

            creator.full_name
              AS created_by_name,

            original_payment.id
              AS payment_id,

            reversal_payment.id
              AS reversal_payment_id,

            reversal_payment.created_at
              AS reversed_at,

            (
              reversal_payment.id
              IS NOT NULL
            ) AS is_reversed

          FROM customer_collections
               collection

          JOIN sales sale
            ON sale.company_id =
               collection.company_id

            AND sale.id =
                collection.sale_id

          LEFT JOIN users creator
            ON creator.company_id =
               collection.company_id

            AND creator.id =
                collection.created_by

          LEFT JOIN payments
                    original_payment
            ON original_payment.company_id =
               collection.company_id

            AND original_payment
                 .customer_collection_id =
               collection.id

            AND original_payment
                 .payment_role =
               'sale_collection'

          LEFT JOIN payments
                    reversal_payment
            ON reversal_payment.company_id =
               original_payment.company_id

            AND reversal_payment
                 .reverses_payment_id =
               original_payment.id

            AND reversal_payment
                 .payment_role =
               'void_reversal'

          WHERE collection.company_id = $1
            AND collection.customer_id = $2

            AND (
              $3::uuid IS NULL
              OR collection.branch_id = $3
            )

          ORDER BY
            collection.collected_at DESC,
            collection.id DESC;
        `,
        [auth.companyId, customerId, auth.branchId],
      )

      const summaryResult = await db.query(
        `
          SELECT
            COALESCE(
              SUM(outstanding_total),
              0
            ) AS outstanding_total,

            COALESCE(
              SUM(outstanding_total)
              FILTER (
                WHERE outstanding_total > 0
                  AND due_date < CURRENT_DATE
              ),
              0
            ) AS overdue_total,

            COUNT(*)
              FILTER (
                WHERE outstanding_total > 0
              )::integer AS open_sales_count,

            MIN(due_date)
              FILTER (
                WHERE outstanding_total > 0
              ) AS oldest_due_date

          FROM sales

          WHERE company_id = $1
            AND customer_id = $2
            AND status <> 'voided'

            AND (
              $3::uuid IS NULL
              OR branch_id = $3
            );
        `,
        [auth.companyId, customerId, auth.branchId],
      )

      return res.json({
        data: {
          customer: customerResult.rows[0],
          summary: summaryResult.rows[0],
          sales: salesResult.rows,
          collections: collectionsResult.rows,
        },
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// PATCH /api/receivables/:customerId/credit-policy
//
// تحديث السياسة الائتمانية للعميل.
// ======================================================
customerReceivablesRouter.patch(
  '/api/receivables/:customerId/credit-policy',
  async (req, res, next) => {
    const auth = getAuthContext(res)
    const client = await db.connect()

    try {
      const customerId = String(req.params.customerId || '')
        .trim()
        .toLowerCase()

      const allowCreditSales = req.body?.allowCreditSales

      const creditLimit = parseNonNegativeMoney(req.body?.creditLimit)

      const paymentTermsDays = Number(req.body?.paymentTermsDays)

      if (!isUuid(customerId)) {
        return res.status(400).json({
          error: 'customerId is invalid',
        })
      }

      if (typeof allowCreditSales !== 'boolean') {
        return res.status(400).json({
          error: 'allowCreditSales must be boolean',
        })
      }

      if (creditLimit === null) {
        return res.status(400).json({
          error: 'الحد الائتماني غير صالح.',
        })
      }

      if (
        !Number.isInteger(paymentTermsDays) ||
        paymentTermsDays < 0 ||
        paymentTermsDays > 3650
      ) {
        return res.status(400).json({
          error: 'مدة السداد يجب أن تكون بين 0 و3650 يومًا.',
        })
      }

      if (allowCreditSales && creditLimit <= 0) {
        return res.status(400).json({
          error: 'يجب تحديد حد ائتماني أكبر من صفر عند تفعيل البيع الآجل.',
        })
      }

      await client.query('BEGIN')

      const customerResult = await client.query(
        `
            SELECT *

            FROM customers

            WHERE company_id = $1
              AND id = $2

            FOR UPDATE;
          `,
        [auth.companyId, customerId],
      )

      if ((customerResult.rowCount ?? 0) === 0) {
        throw new CustomerReceivablesApiError(404, 'العميل غير موجود.')
      }

      const currentCustomer = customerResult.rows[0]

      const outstandingResult = await client.query(
        `
            SELECT
              COALESCE(
                SUM(outstanding_total),
                0
              ) AS outstanding_total

            FROM sales

            WHERE company_id = $1
              AND customer_id = $2
              AND status <> 'voided';
          `,
        [auth.companyId, customerId],
      )

      const currentOutstanding = roundMoney(
        Number(outstandingResult.rows[0].outstanding_total),
      )

      const updatedResult = await client.query(
        `
            UPDATE customers

            SET
              allow_credit_sales = $1,
              credit_limit = $2,
              payment_terms_days = $3,
              updated_at = NOW()

            WHERE company_id = $4
              AND id = $5

            RETURNING *;
          `,
        [
          allowCreditSales,
          creditLimit,
          paymentTermsDays,

          auth.companyId,
          customerId,
        ],
      )

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
            'receivables.credit_policy.updated',
            'customer',
            $4,
            $5::jsonb,
            $6::jsonb,
            $7,
            $8
          );
        `,
        [
          auth.companyId,
          auth.branchId,
          auth.userId,

          customerId,

          JSON.stringify({
            allowCreditSales: currentCustomer.allow_credit_sales,

            creditLimit: currentCustomer.credit_limit,

            paymentTermsDays: currentCustomer.payment_terms_days,
          }),

          JSON.stringify({
            allowCreditSales,
            creditLimit,
            paymentTermsDays,
            currentOutstanding,
          }),

          req.ip || null,
          req.get('user-agent') || null,
        ],
      )

      await client.query('COMMIT')

      return res.json({
        data: {
          ...updatedResult.rows[0],

          outstanding_total: currentOutstanding,

          credit_available: Math.max(
            roundMoney(creditLimit - currentOutstanding),
            0,
          ),
        },
      })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})

      if (error instanceof CustomerReceivablesApiError) {
        return res.status(error.statusCode).json({
          error: error.message,
          details: error.details,
        })
      }

      return next(error)
    } finally {
      client.release()
    }
  },
)

// ======================================================
// POST /api/receivables/sales/:saleId/collect
//
// تسجيل تحصيل جزئي أو كامل.
// ======================================================
customerReceivablesRouter.post(
  '/api/receivables/sales/:saleId/collect',
  async (req, res, next) => {
    const auth = getAuthContext(res)
    const client = await db.connect()

    try {
      const saleId = String(req.params.saleId || '')
        .trim()
        .toLowerCase()

      const collectionNumber =
        typeof req.body?.collectionNumber === 'string'
          ? req.body.collectionNumber.trim()
          : ''

      const idempotencyKey =
        typeof req.body?.idempotencyKey === 'string'
          ? req.body.idempotencyKey.trim()
          : ''

      const amount = parsePositiveMoney(req.body?.amount)

      const paymentMethod =
        typeof req.body?.paymentMethod === 'string'
          ? req.body.paymentMethod.trim()
          : ''

      const referenceNumber =
        typeof req.body?.referenceNumber === 'string'
          ? req.body.referenceNumber.trim()
          : ''

      const note =
        typeof req.body?.note === 'string' ? req.body.note.trim() : ''

      if (!isUuid(saleId)) {
        return res.status(400).json({
          error: 'saleId is invalid',
        })
      }

      if (collectionNumber.length < 1 || collectionNumber.length > 100) {
        return res.status(400).json({
          error: 'رقم التحصيل مطلوب وبحد أقصى 100 حرف.',
        })
      }

      if (idempotencyKey.length < 10 || idempotencyKey.length > 150) {
        return res.status(400).json({
          error: 'idempotencyKey is invalid',
        })
      }

      if (amount === null) {
        return res.status(400).json({
          error: 'مبلغ التحصيل غير صالح.',
        })
      }

      if (!collectionMethods.has(paymentMethod)) {
        return res.status(400).json({
          error: 'paymentMethod is invalid',
        })
      }

      if (referenceNumber.length > 150) {
        return res.status(400).json({
          error: 'رقم المرجع لا يمكن أن يتجاوز 150 حرفًا.',
        })
      }

      if (note.length > 500) {
        return res.status(400).json({
          error: 'الملاحظة لا يمكن أن تتجاوز 500 حرف.',
        })
      }

      const existingCollection = await loadCollectionByIdempotency(
        auth.companyId,
        auth.branchId,
        idempotencyKey,
      )

      if (existingCollection) {
        if (existingCollection.collection.sale_id !== saleId) {
          return res.status(409).json({
            error: 'Idempotency key belongs to another sale',
          })
        }

        return res.status(200).json({
          duplicated: true,

          // نفس شكل Response الإنشاء العادي.
          data: existingCollection,
        })
      }

      await client.query('BEGIN')

      const saleResult = await client.query(
        `
            SELECT
              sale.*,

              customer.name
                AS customer_name

            FROM sales sale

            JOIN customers customer
              ON customer.company_id =
                 sale.company_id

              AND customer.id =
                  sale.customer_id

            WHERE sale.company_id = $1
              AND sale.id = $2
              AND sale.status = 'completed'

              AND (
                $3::uuid IS NULL
                OR sale.branch_id = $3
              )

            FOR UPDATE OF sale, customer;
          `,
        [auth.companyId, saleId, auth.branchId],
      )

      if ((saleResult.rowCount ?? 0) === 0) {
        throw new CustomerReceivablesApiError(
          404,
          'الفاتورة غير موجودة أو غير مسموح بتحصيلها.',
        )
      }

      const sale = saleResult.rows[0]

      const currentOutstanding = roundMoney(Number(sale.outstanding_total))

      if (currentOutstanding <= 0) {
        throw new CustomerReceivablesApiError(409, 'الفاتورة مسددة بالكامل.')
      }

      // القيمتان مقربتان بالفعل لمنزلتين عشريتين،
      // لذلك لا نسمح حتى بزيادة قرش واحد.
      if (amount > currentOutstanding) {
        throw new CustomerReceivablesApiError(
          409,
          'مبلغ التحصيل أكبر من الرصيد المستحق.',
          {
            outstandingTotal: currentOutstanding,

            requestedAmount: amount,
          },
        )
      }

      const collectionResult = await client.query(
        `
            INSERT INTO customer_collections (
              company_id,
              branch_id,

              customer_id,
              sale_id,

              collection_number,
              idempotency_key,

              amount,
              payment_method,

              reference_number,
              note,

              created_by
            )
            VALUES (
              $1, $2,
              $3, $4,
              $5, $6,
              $7, $8,
              $9, $10,
              $11
            )

            RETURNING *;
          `,
        [
          auth.companyId,
          sale.branch_id,

          sale.customer_id,
          sale.id,

          collectionNumber,
          idempotencyKey,

          amount,
          paymentMethod,

          referenceNumber || null,
          note || null,

          auth.userId,
        ],
      )

      const collection = collectionResult.rows[0]

      const paymentResult = await client.query(
        `
            INSERT INTO payments (
              company_id,
              sale_id,

              method,
              amount,
              reference,

              payment_role,
              payment_direction,

              customer_collection_id
            )
            VALUES (
              $1, $2,
              $3, $4, $5,
              'sale_collection',
              'received_from_customer',
              $6
            )

            RETURNING *;
          `,
        [
          auth.companyId,
          sale.id,

          paymentMethod,
          amount,
          referenceNumber || null,

          collection.id,
        ],
      )

      const nextPaidTotal = roundMoney(Number(sale.paid_total) + amount)

      const nextOutstanding = Math.max(
        roundMoney(currentOutstanding - amount),
        0,
      )

      const nextPaymentStatus = nextOutstanding <= 0 ? 'paid' : 'partially_paid'

      const updatedSaleResult = await client.query(
        `
            UPDATE sales

            SET
              paid_total = $1,
              outstanding_total = $2,
              payment_status = $3

            WHERE company_id = $4
              AND id = $5

            RETURNING *;
          `,
        [
          nextPaidTotal,
          nextOutstanding,
          nextPaymentStatus,

          auth.companyId,
          sale.id,
        ],
      )

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
            'receivables.collection.created',
            'customer_collection',
            $4,
            $5::jsonb,
            $6::jsonb,
            $7,
            $8
          );
        `,
        [
          auth.companyId,
          sale.branch_id,
          auth.userId,

          collection.id,

          JSON.stringify({
            saleId: sale.id,
            outstandingTotal: currentOutstanding,
          }),

          JSON.stringify({
            saleId: sale.id,
            customerId: sale.customer_id,

            amount,
            paymentMethod,

            outstandingTotal: nextOutstanding,

            paymentStatus: nextPaymentStatus,
          }),

          req.ip || null,
          req.get('user-agent') || null,
        ],
      )

      await client.query('COMMIT')

      return res.status(201).json({
        duplicated: false,

        data: {
          collection,
          payment: paymentResult.rows[0],

          sale: updatedSaleResult.rows[0],
        },
      })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})

      if (isUniqueViolation(error)) {
        const requestIdempotencyKey =
          typeof req.body?.idempotencyKey === 'string'
            ? req.body.idempotencyKey.trim()
            : ''

        if (requestIdempotencyKey) {
          const existingCollection = await loadCollectionByIdempotency(
            auth.companyId,
            auth.branchId,
            requestIdempotencyKey,
          )

          if (
            existingCollection &&
            existingCollection.collection.sale_id ===
              String(req.params.saleId || '')
                .trim()
                .toLowerCase()
          ) {
            return res.status(200).json({
              duplicated: true,

              // الطلب المتزامن يحصل على نفس
              // Response الطلب الذي تم حفظه.
              data: existingCollection,
            })
          }
        }

        return res.status(409).json({
          error: 'رقم التحصيل مستخدم بالفعل.',
        })
      }

      if (error instanceof CustomerReceivablesApiError) {
        return res.status(error.statusCode).json({
          error: error.message,
          details: error.details,
        })
      }

      return next(error)
    } finally {
      client.release()
    }
  },
)
