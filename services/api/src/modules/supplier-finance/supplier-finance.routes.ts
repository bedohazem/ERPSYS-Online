import { Router } from 'express'

import { db } from '../../db/pool'
import { getAuthContext } from '../auth/auth.middleware'

export const supplierFinanceRouter = Router()

class SupplierFinanceApiError extends Error {
  statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isUuid(value: string) {
  return uuidPattern.test(value)
}

function roundMoney(value: number) {
  return Number(value.toFixed(2))
}

function parseMoney(value: unknown) {
  const numericValue = Number(value)

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
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

// كمية مرتجع المورد تقبل ثلاث خانات عشرية.
function parseSupplierReturnQuantity(value: unknown) {
  const numericValue = Number(value)

  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null
  }

  const roundedValue = Number(numericValue.toFixed(3))

  if (Math.abs(numericValue - roundedValue) > 0.0000001) {
    return null
  }

  if (roundedValue > 99_999_999_999.999) {
    return null
  }

  return roundedValue
}

function roundQuantity(value: number) {
  return Number(value.toFixed(3))
}

// تحسب الرصيد الجديد وحالة فاتورة المورد بعد
// الدفع أو إضافة إشعار خصم.
function resolveSupplierInvoiceFinancialState(
  total: number,
  paidTotal: number,
  creditTotal: number,
) {
  const balance = Math.max(roundMoney(total - paidTotal - creditTotal), 0)

  const supplierCreditBalance = Math.max(
    roundMoney(paidTotal + creditTotal - total),
    0,
  )

  let status = 'open'

  if (supplierCreditBalance > 0) {
    status = 'credit_due'
  } else if (balance <= 0) {
    status = 'paid'
  } else if (paidTotal > 0 || creditTotal > 0) {
    status = 'partially_paid'
  }

  return {
    balance,
    supplierCreditBalance,
    status,
  }
}

async function loadSupplierReturnByIdempotency(
  companyId: string,
  idempotencyKey: string,
  branchId: string | null,
) {
  const result = await db.query(
    `
      SELECT
        supplier_return.*,

        credit_note.credit_note_number,
        credit_note.amount AS credit_note_amount

      FROM supplier_returns supplier_return

      LEFT JOIN supplier_credit_notes credit_note
        ON credit_note.company_id =
           supplier_return.company_id

        AND credit_note.supplier_return_id =
            supplier_return.id

      WHERE supplier_return.company_id = $1
        AND supplier_return.idempotency_key = $2

        AND (
          $3::uuid IS NULL
          OR supplier_return.branch_id = $3
        )

      LIMIT 1;
    `,
    [companyId, idempotencyKey, branchId],
  )

  return result.rows[0] || null
}

// ======================================================
// GET /api/purchases/supplier-finance/receipts
//
// أذون الاستلام التي لم يتم إنشاء فاتورة مورد لها.
// ======================================================
supplierFinanceRouter.get(
  '/api/purchases/supplier-finance/receipts',
  async (_req, res, next) => {
    try {
      const auth = getAuthContext(res)

      const result = await db.query(
        `
          SELECT
            receipt.id,
            receipt.receipt_number,
            receipt.supplier_id,

            supplier.name AS supplier_name,
            supplier.code AS supplier_code,

            receipt.branch_id,
            branch.name AS branch_name,

            receipt.total,
            receipt.subtotal,
            receipt.discount_total,
            receipt.tax_total,

            receipt.received_at

          FROM purchase_receipts receipt

          JOIN suppliers supplier
            ON supplier.company_id =
               receipt.company_id

            AND supplier.id =
                receipt.supplier_id

          LEFT JOIN branches branch
            ON branch.company_id =
               receipt.company_id

            AND branch.id =
                receipt.branch_id

          LEFT JOIN supplier_invoices invoice
            ON invoice.company_id =
               receipt.company_id

            AND invoice.purchase_receipt_id =
                receipt.id

          WHERE receipt.company_id = $1
            AND receipt.status = 'received'
            AND invoice.id IS NULL

            AND (
              $2::uuid IS NULL
              OR receipt.branch_id = $2
            )

          ORDER BY
            receipt.received_at DESC,
            receipt.id DESC

          LIMIT 200;
        `,
        [auth.companyId, auth.branchId],
      )

      return res.json({
        data: result.rows,
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// GET /api/purchases/supplier-invoices
//
// قائمة الفواتير مع ملخص المدفوع والمتبقي.
// ======================================================
supplierFinanceRouter.get(
  '/api/purchases/supplier-invoices',
  async (req, res, next) => {
    try {
      const auth = getAuthContext(res)

      const status =
        typeof req.query.status === 'string' ? req.query.status.trim() : ''

      const allowedStatuses = new Set([
        'open',
        'partially_paid',
        'paid',
        'credit_due',
        'cancelled',
      ])

      if (status && !allowedStatuses.has(status)) {
        return res.status(400).json({
          error: 'status is invalid',
        })
      }

      const search =
        typeof req.query.q === 'string' && req.query.q.trim()
          ? `%${req.query.q.trim()}%`
          : null

      const result = await db.query(
        `
          SELECT
            invoice.*,

            supplier.name AS supplier_name,
            supplier.code AS supplier_code,

            receipt.receipt_number,

            branch.name AS branch_name,

            creator.full_name AS created_by_name,

            COUNT(payment.id)::integer
              AS payments_count,

            MAX(payment.paid_at)
              AS last_payment_at

          FROM supplier_invoices invoice

          JOIN suppliers supplier
            ON supplier.company_id =
               invoice.company_id

            AND supplier.id =
                invoice.supplier_id

          JOIN purchase_receipts receipt
            ON receipt.company_id =
               invoice.company_id

            AND receipt.id =
                invoice.purchase_receipt_id

          LEFT JOIN branches branch
            ON branch.company_id =
               invoice.company_id

            AND branch.id =
                invoice.branch_id

          LEFT JOIN users creator
            ON creator.company_id =
               invoice.company_id

            AND creator.id =
                invoice.created_by

          LEFT JOIN supplier_payments payment
            ON payment.company_id =
               invoice.company_id

            AND payment.supplier_invoice_id =
                invoice.id

          WHERE invoice.company_id = $1

            AND (
              $2::uuid IS NULL
              OR invoice.branch_id = $2
            )

            AND (
              $3::text IS NULL
              OR invoice.status = $3
            )

            AND (
              $4::text IS NULL
              OR invoice.invoice_number ILIKE $4
              OR invoice.supplier_invoice_number ILIKE $4
              OR supplier.name ILIKE $4
              OR supplier.code ILIKE $4
              OR receipt.receipt_number ILIKE $4
            )

          GROUP BY
            invoice.id,
            supplier.name,
            supplier.code,
            receipt.receipt_number,
            branch.name,
            creator.full_name

          ORDER BY
            invoice.invoice_date DESC,
            invoice.created_at DESC

          LIMIT $5;
        `,
        [
          auth.companyId,
          auth.branchId,
          status || null,
          search,
          parseLimit(req.query.limit),
        ],
      )

      const summaryResult = await db.query(
        `
          SELECT
            COUNT(*)::integer AS invoices_count,

            COALESCE(SUM(total), 0)
              AS total_invoiced,

            COALESCE(SUM(paid_total), 0)
              AS total_paid,

            COALESCE(SUM(credit_total), 0)
              AS total_credited,

            COALESCE(
              SUM(supplier_credit_balance),
              0
            ) AS total_supplier_credit,

            COALESCE(SUM(balance), 0)
              AS total_outstanding,

            COUNT(*)
              FILTER (
                WHERE balance > 0
                  AND due_date IS NOT NULL
                  AND due_date < CURRENT_DATE
              )::integer AS overdue_count

          FROM supplier_invoices

          WHERE company_id = $1

            AND (
              $2::uuid IS NULL
              OR branch_id = $2
            )

            AND status <> 'cancelled';
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
  },
)

// ======================================================
// POST /api/purchases/supplier-invoices
//
// إنشاء فاتورة من إذن استلام.
// القيم المالية تُنسخ من إذن الاستلام ولا تؤخذ من الواجهة.
// ======================================================
supplierFinanceRouter.post(
  '/api/purchases/supplier-invoices',
  async (req, res, next) => {
    const auth = getAuthContext(res)
    const client = await db.connect()

    try {
      const receiptId =
        typeof req.body?.receiptId === 'string'
          ? req.body.receiptId.trim().toLowerCase()
          : ''

      const invoiceNumber =
        typeof req.body?.invoiceNumber === 'string'
          ? req.body.invoiceNumber.trim()
          : ''

      const supplierInvoiceNumber =
        typeof req.body?.supplierInvoiceNumber === 'string'
          ? req.body.supplierInvoiceNumber.trim()
          : ''

      const invoiceDate =
        typeof req.body?.invoiceDate === 'string'
          ? req.body.invoiceDate.trim()
          : ''

      const dueDate =
        typeof req.body?.dueDate === 'string' ? req.body.dueDate.trim() : ''

      const note =
        typeof req.body?.note === 'string' ? req.body.note.trim() : ''

      if (!isUuid(receiptId)) {
        return res.status(400).json({
          error: 'receiptId is invalid',
        })
      }

      if (invoiceNumber.length < 1 || invoiceNumber.length > 100) {
        return res.status(400).json({
          error: 'رقم الفاتورة الداخلي مطلوب وبحد أقصى 100 حرف.',
        })
      }

      if (supplierInvoiceNumber.length > 100) {
        return res.status(400).json({
          error: 'رقم فاتورة المورد لا يمكن أن يتجاوز 100 حرف.',
        })
      }

      if (!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) {
        return res.status(400).json({
          error: 'invoiceDate must use YYYY-MM-DD',
        })
      }

      if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
        return res.status(400).json({
          error: 'dueDate must use YYYY-MM-DD',
        })
      }

      if (dueDate && dueDate < invoiceDate) {
        return res.status(400).json({
          error: 'تاريخ الاستحقاق لا يمكن أن يسبق تاريخ الفاتورة.',
        })
      }

      if (note.length > 500) {
        return res.status(400).json({
          error: 'note cannot exceed 500 characters',
        })
      }

      await client.query('BEGIN')

      const receiptResult = await client.query(
        `
          SELECT
            receipt.*,

            supplier.name AS supplier_name,
            supplier.code AS supplier_code

          FROM purchase_receipts receipt

          JOIN suppliers supplier
            ON supplier.company_id =
               receipt.company_id

            AND supplier.id =
                receipt.supplier_id

          WHERE receipt.company_id = $1
            AND receipt.id = $2
            AND receipt.status = 'received'

            AND (
              $3::uuid IS NULL
              OR receipt.branch_id = $3
            )

          FOR UPDATE OF receipt;
        `,
        [auth.companyId, receiptId, auth.branchId],
      )

      if ((receiptResult.rowCount ?? 0) === 0) {
        throw new SupplierFinanceApiError(
          404,
          'إذن الاستلام غير موجود أو غير مسموح.',
        )
      }

      const receipt = receiptResult.rows[0]
      const total = roundMoney(Number(receipt.total))

      if (!Number.isFinite(total) || total < 0) {
        throw new SupplierFinanceApiError(409, 'إجمالي إذن الاستلام غير صالح.')
      }

      const invoiceResult = await client.query(
        `
          INSERT INTO supplier_invoices (
            company_id,
            branch_id,

            supplier_id,
            purchase_receipt_id,

            invoice_number,
            supplier_invoice_number,

            invoice_date,
            due_date,

            status,

            subtotal,
            discount_total,
            tax_total,
            total,

            paid_total,
            balance,

            note,
            created_by
          )
          VALUES (
            $1, $2,
            $3, $4,
            $5, $6,
            $7, $8,
            'open',
            $9, $10, $11, $12,
            0, $12,
            $13, $14
          )
          RETURNING *;
        `,
        [
          auth.companyId,
          receipt.branch_id,

          receipt.supplier_id,
          receipt.id,

          invoiceNumber,
          supplierInvoiceNumber || null,

          invoiceDate,
          dueDate || null,

          receipt.subtotal,
          receipt.discount_total,
          receipt.tax_total,
          total,

          note || null,
          auth.userId,
        ],
      )

      const invoice = invoiceResult.rows[0]

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
            'purchases.supplier_invoice.created',
            'supplier_invoice',
            $4,
            NULL,
            $5::jsonb,
            $6,
            $7
          );
        `,
        [
          auth.companyId,
          receipt.branch_id,
          auth.userId,

          invoice.id,

          JSON.stringify({
            invoiceNumber,
            purchaseReceiptId: receipt.id,
            supplierId: receipt.supplier_id,
            total,
          }),

          req.ip || null,
          req.get('user-agent') || null,
        ],
      )

      await client.query('COMMIT')

      return res.status(201).json({
        data: {
          ...invoice,
          supplier_name: receipt.supplier_name,
          supplier_code: receipt.supplier_code,
          receipt_number: receipt.receipt_number,
          payments_count: 0,
          last_payment_at: null,
        },
      })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})

      if (isUniqueViolation(error)) {
        return res.status(409).json({
          error: 'رقم الفاتورة مستخدم أو تم إنشاء فاتورة لهذا الإذن من قبل.',
        })
      }

      if (error instanceof SupplierFinanceApiError) {
        return res.status(error.statusCode).json({
          error: error.message,
        })
      }

      return next(error)
    } finally {
      client.release()
    }
  },
)

// ======================================================
// POST /api/purchases/supplier-invoices/:invoiceId/pay
//
// تسجيل دفعة جزئية أو كاملة وتحديث رصيد الفاتورة.
// ======================================================
supplierFinanceRouter.post(
  '/api/purchases/supplier-invoices/:invoiceId/pay',
  async (req, res, next) => {
    const auth = getAuthContext(res)
    const client = await db.connect()

    try {
      const invoiceId = String(req.params.invoiceId || '')
        .trim()
        .toLowerCase()

      const paymentNumber =
        typeof req.body?.paymentNumber === 'string'
          ? req.body.paymentNumber.trim()
          : ''

      const idempotencyKey =
        typeof req.body?.idempotencyKey === 'string'
          ? req.body.idempotencyKey.trim()
          : ''

      const amount = parseMoney(req.body?.amount)

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

      if (!isUuid(invoiceId)) {
        return res.status(400).json({
          error: 'invoiceId is invalid',
        })
      }

      if (paymentNumber.length < 1 || paymentNumber.length > 100) {
        return res.status(400).json({
          error: 'paymentNumber is required',
        })
      }

      if (idempotencyKey.length < 10 || idempotencyKey.length > 150) {
        return res.status(400).json({
          error: 'idempotencyKey is invalid',
        })
      }

      if (amount === null) {
        return res.status(400).json({
          error: 'مبلغ الدفعة غير صالح.',
        })
      }

      const allowedMethods = new Set([
        'cash',
        'bank_transfer',
        'card',
        'cheque',
        'other',
      ])

      if (!allowedMethods.has(paymentMethod)) {
        return res.status(400).json({
          error: 'paymentMethod is invalid',
        })
      }

      if (referenceNumber.length > 150) {
        return res.status(400).json({
          error: 'referenceNumber cannot exceed 150 characters',
        })
      }

      if (note.length > 500) {
        return res.status(400).json({
          error: 'note cannot exceed 500 characters',
        })
      }

      const existingPayment = await client.query(
        `
          SELECT
            payment.id,
            payment.supplier_invoice_id

          FROM supplier_payments payment

          WHERE payment.company_id = $1
            AND payment.idempotency_key = $2

          LIMIT 1;
        `,
        [auth.companyId, idempotencyKey],
      )

      if ((existingPayment.rowCount ?? 0) > 0) {
        if (existingPayment.rows[0].supplier_invoice_id !== invoiceId) {
          return res.status(409).json({
            error: 'Idempotency key belongs to another invoice',
          })
        }

        const invoiceResult = await db.query(
          `
            SELECT *

            FROM supplier_invoices

            WHERE company_id = $1
              AND id = $2

              -- إعادة المحاولة لا تتجاوز نطاق فرع المستخدم.
              AND (
                $3::uuid IS NULL
                OR branch_id = $3
              )

            LIMIT 1;
          `,
          [auth.companyId, invoiceId, auth.branchId],
        )

        if ((invoiceResult.rowCount ?? 0) === 0) {
          return res.status(404).json({
            error: 'فاتورة المورد غير موجودة أو غير مسموح بها.',
          })
        }

        return res.status(200).json({
          duplicated: true,
          data: invoiceResult.rows[0],
        })
      }

      await client.query('BEGIN')

      const invoiceResult = await client.query(
        `
          SELECT
            invoice.*

          FROM supplier_invoices invoice

          WHERE invoice.company_id = $1
            AND invoice.id = $2

            AND (
              $3::uuid IS NULL
              OR invoice.branch_id = $3
            )

          FOR UPDATE;
        `,
        [auth.companyId, invoiceId, auth.branchId],
      )

      if ((invoiceResult.rowCount ?? 0) === 0) {
        throw new SupplierFinanceApiError(
          404,
          'فاتورة المورد غير موجودة أو غير مسموح بها.',
        )
      }

      const invoice = invoiceResult.rows[0]

      if (invoice.status === 'cancelled') {
        throw new SupplierFinanceApiError(
          409,
          'لا يمكن الدفع على فاتورة ملغية.',
        )
      }

      if (invoice.status === 'paid' || invoice.status === 'credit_due') {
        throw new SupplierFinanceApiError(
          409,
          invoice.status === 'credit_due'
            ? 'يوجد رصيد دائن مستحق من المورد ولا يمكن تسجيل دفعة جديدة.'
            : 'الفاتورة مدفوعة بالكامل.',
        )
      }

      const currentBalance = roundMoney(Number(invoice.balance))

      if (amount > currentBalance) {
        throw new SupplierFinanceApiError(
          409,
          'مبلغ الدفعة أكبر من الرصيد المستحق.',
        )
      }

      const paymentResult = await client.query(
        `
          INSERT INTO supplier_payments (
            company_id,
            branch_id,

            supplier_invoice_id,
            supplier_id,

            payment_number,
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
          invoice.branch_id,

          invoice.id,
          invoice.supplier_id,

          paymentNumber,
          idempotencyKey,

          amount,
          paymentMethod,

          referenceNumber || null,
          note || null,

          auth.userId,
        ],
      )

      const nextPaidTotal = roundMoney(Number(invoice.paid_total) + amount)

      const creditTotal = roundMoney(Number(invoice.credit_total ?? 0))

      const financialState = resolveSupplierInvoiceFinancialState(
        Number(invoice.total),
        nextPaidTotal,
        creditTotal,
      )

      const updatedInvoiceResult = await client.query(
        `
            UPDATE supplier_invoices

            SET
              paid_total = $1,
              balance = $2,
              supplier_credit_balance = $3,
              status = $4,
              updated_at = NOW()

            WHERE company_id = $5
              AND id = $6

            RETURNING *;
          `,
        [
          nextPaidTotal,
          financialState.balance,
          financialState.supplierCreditBalance,
          financialState.status,
          auth.companyId,
          invoiceId,
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
            'purchases.supplier_payment.created',
            'supplier_payment',
            $4,
            $5::jsonb,
            $6::jsonb,
            $7,
            $8
          );
        `,
        [
          auth.companyId,
          invoice.branch_id,
          auth.userId,

          paymentResult.rows[0].id,

          JSON.stringify({
            invoiceId,
            balance: currentBalance,
          }),

          JSON.stringify({
            invoiceId,
            amount,
            paymentMethod,
            balance: financialState.balance,
            supplierCreditBalance: financialState.supplierCreditBalance,
            invoiceStatus: financialState.status,
          }),

          req.ip || null,
          req.get('user-agent') || null,
        ],
      )

      await client.query('COMMIT')

      return res.status(201).json({
        duplicated: false,
        data: updatedInvoiceResult.rows[0],
        payment: paymentResult.rows[0],
      })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})

      if (isUniqueViolation(error)) {
        const requestedInvoiceId = String(req.params.invoiceId || '')
          .trim()
          .toLowerCase()

        const requestIdempotencyKey =
          typeof req.body?.idempotencyKey === 'string'
            ? req.body.idempotencyKey.trim()
            : ''

        if (isUuid(requestedInvoiceId) && requestIdempotencyKey) {
          const existingPaymentResult = await client.query(
            `
                SELECT
                  payment.id,
                  payment.supplier_invoice_id

                FROM supplier_payments payment

                WHERE payment.company_id = $1
                  AND payment.idempotency_key = $2

                LIMIT 1;
              `,
            [auth.companyId, requestIdempotencyKey],
          )

          const existingPayment = existingPaymentResult.rows[0]

          if (
            existingPayment &&
            existingPayment.supplier_invoice_id === requestedInvoiceId
          ) {
            const existingInvoiceResult = await client.query(
              `
                  SELECT *

                  FROM supplier_invoices

                  WHERE company_id = $1
                    AND id = $2

                    AND (
                      $3::uuid IS NULL
                      OR branch_id = $3
                    )

                  LIMIT 1;
                `,
              [auth.companyId, requestedInvoiceId, auth.branchId],
            )

            if ((existingInvoiceResult.rowCount ?? 0) > 0) {
              return res.status(200).json({
                duplicated: true,
                data: existingInvoiceResult.rows[0],
                payment: existingPayment,
              })
            }
          }
        }

        return res.status(409).json({
          error: 'رقم الدفعة مستخدم بالفعل.',
        })
      }

      if (error instanceof SupplierFinanceApiError) {
        return res.status(error.statusCode).json({
          error: error.message,
        })
      }

      return next(error)
    } finally {
      client.release()
    }
  },
)

// ======================================================
// GET /api/purchases/supplier-returns
//
// سجل مرتجعات الموردين وإشعارات الخصم.
// ======================================================
supplierFinanceRouter.get(
  '/api/purchases/supplier-returns',
  async (req, res, next) => {
    try {
      const auth = getAuthContext(res)

      const result = await db.query(
        `
          SELECT
            supplier_return.*,

            supplier.name AS supplier_name,
            supplier.code AS supplier_code,

            invoice.invoice_number,

            receipt.receipt_number,

            location.name AS stock_location_name,
            location.code AS stock_location_code,

            credit_note.credit_note_number,
            credit_note.amount AS credit_note_amount,

            creator.full_name AS created_by_name,

            COUNT(return_item.id)::integer
              AS items_count

          FROM supplier_returns supplier_return

          JOIN suppliers supplier
            ON supplier.company_id =
               supplier_return.company_id

            AND supplier.id =
                supplier_return.supplier_id

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

          JOIN supplier_credit_notes credit_note
            ON credit_note.company_id =
               supplier_return.company_id

            AND credit_note.supplier_return_id =
                supplier_return.id

          LEFT JOIN users creator
            ON creator.company_id =
               supplier_return.company_id

            AND creator.id =
                supplier_return.created_by

          LEFT JOIN supplier_return_items return_item
            ON return_item.company_id =
               supplier_return.company_id

            AND return_item.supplier_return_id =
                supplier_return.id

          WHERE supplier_return.company_id = $1

            AND (
              $2::uuid IS NULL
              OR supplier_return.branch_id = $2
            )

          GROUP BY
            supplier_return.id,
            supplier.name,
            supplier.code,
            invoice.invoice_number,
            receipt.receipt_number,
            location.name,
            location.code,
            credit_note.credit_note_number,
            credit_note.amount,
            creator.full_name

          ORDER BY
            supplier_return.created_at DESC,
            supplier_return.id DESC

          LIMIT $3;
        `,
        [auth.companyId, auth.branchId, parseLimit(req.query.limit)],
      )

      const summaryResult = await db.query(
        `
          SELECT
            COUNT(*)::integer AS returns_count,

            COALESCE(SUM(total), 0)
              AS total_returned

          FROM supplier_returns

          WHERE company_id = $1

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
  },
)

// ======================================================
// GET /api/purchases/supplier-invoices/:invoiceId/return-context
//
// يعرض أصناف إذن الاستلام والكميات المتاحة للمرتجع.
// ======================================================
supplierFinanceRouter.get(
  '/api/purchases/supplier-invoices/:invoiceId/return-context',
  async (req, res, next) => {
    try {
      const auth = getAuthContext(res)

      const invoiceId = String(req.params.invoiceId || '')
        .trim()
        .toLowerCase()

      if (!isUuid(invoiceId)) {
        return res.status(400).json({
          error: 'invoiceId is invalid',
        })
      }

      const invoiceResult = await db.query(
        `
          SELECT
            invoice.*,

            supplier.name AS supplier_name,
            supplier.code AS supplier_code,

            receipt.receipt_number,
            receipt.stock_location_id,

            location.name AS stock_location_name,
            location.code AS stock_location_code

          FROM supplier_invoices invoice

          JOIN suppliers supplier
            ON supplier.company_id =
               invoice.company_id

            AND supplier.id =
                invoice.supplier_id

          JOIN purchase_receipts receipt
            ON receipt.company_id =
               invoice.company_id

            AND receipt.id =
                invoice.purchase_receipt_id

          JOIN stock_locations location
            ON location.company_id =
               receipt.company_id

            AND location.id =
                receipt.stock_location_id

          WHERE invoice.company_id = $1
            AND invoice.id = $2
            AND invoice.status <> 'cancelled'
            AND receipt.status = 'received'
            AND location.is_active = TRUE

            AND (
              $3::uuid IS NULL
              OR invoice.branch_id = $3
            )

          LIMIT 1;
        `,
        [auth.companyId, invoiceId, auth.branchId],
      )

      if ((invoiceResult.rowCount ?? 0) === 0) {
        return res.status(404).json({
          error: 'فاتورة المورد غير موجودة أو غير مسموح بإنشاء مرتجع لها.',
        })
      }

      const invoice = invoiceResult.rows[0]

      const itemsResult = await db.query(
        `
          WITH returned_quantities AS (
            SELECT
              return_item.purchase_receipt_item_id,

              COALESCE(
                SUM(return_item.quantity),
                0
              ) AS returned_quantity

            FROM supplier_return_items return_item

            JOIN supplier_returns supplier_return
              ON supplier_return.company_id =
                 return_item.company_id

              AND supplier_return.id =
                  return_item.supplier_return_id

            WHERE return_item.company_id = $1
              AND supplier_return.status = 'posted'

            GROUP BY
              return_item.purchase_receipt_item_id
          )

          SELECT
            receipt_item.id
              AS receipt_item_id,

            receipt_item.variant_id,

            product.name AS product_name,

            variant.sku,
            variant.primary_barcode,

            size.name AS size_name,
            color.name AS color_name,

            receipt_item.quantity
              AS received_quantity,

            COALESCE(
              returned.returned_quantity,
              0
            ) AS returned_quantity,

            (
              receipt_item.quantity -
              COALESCE(
                returned.returned_quantity,
                0
              )
            ) AS available_quantity,

            COALESCE(balance.quantity, 0)
              AS stock_quantity,

            receipt_item.unit_cost,
            receipt_item.discount_amount,
            receipt_item.tax_amount,
            receipt_item.line_total

          FROM purchase_receipt_items receipt_item

          JOIN product_variants variant
            ON variant.company_id =
               receipt_item.company_id

            AND variant.id =
                receipt_item.variant_id

          JOIN products product
            ON product.company_id =
               variant.company_id

            AND product.id =
                variant.product_id

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

          LEFT JOIN returned_quantities returned
            ON returned.purchase_receipt_item_id =
               receipt_item.id

          LEFT JOIN stock_balances balance
            ON balance.company_id =
               receipt_item.company_id

            AND balance.stock_location_id = $3

            AND balance.variant_id =
                receipt_item.variant_id

          WHERE receipt_item.company_id = $1
            AND receipt_item.purchase_receipt_id = $2

            AND (
              receipt_item.quantity -
              COALESCE(
                returned.returned_quantity,
                0
              )
            ) > 0

          ORDER BY
            product.name,
            variant.sku;
        `,
        [
          auth.companyId,
          invoice.purchase_receipt_id,
          invoice.stock_location_id,
        ],
      )

      return res.json({
        data: {
          invoice,
          items: itemsResult.rows,
        },
      })
    } catch (error) {
      return next(error)
    }
  },
)

// ======================================================
// POST /api/purchases/supplier-invoices/:invoiceId/returns
//
// ينشئ مرتجع المورد وإشعار الخصم ويخصم المخزون.
// ======================================================
supplierFinanceRouter.post(
  '/api/purchases/supplier-invoices/:invoiceId/returns',
  async (req, res, next) => {
    const auth = getAuthContext(res)
    const client = await db.connect()

    try {
      const invoiceId = String(req.params.invoiceId || '')
        .trim()
        .toLowerCase()

      const returnNumber =
        typeof req.body?.returnNumber === 'string'
          ? req.body.returnNumber.trim()
          : ''

      const creditNoteNumber =
        typeof req.body?.creditNoteNumber === 'string'
          ? req.body.creditNoteNumber.trim()
          : ''

      const idempotencyKey =
        typeof req.body?.idempotencyKey === 'string'
          ? req.body.idempotencyKey.trim()
          : ''

      const note =
        typeof req.body?.note === 'string' ? req.body.note.trim() : ''

      if (!isUuid(invoiceId)) {
        return res.status(400).json({
          error: 'invoiceId is invalid',
        })
      }

      if (returnNumber.length < 1 || returnNumber.length > 100) {
        return res.status(400).json({
          error: 'رقم مرتجع المورد مطلوب وبحد أقصى 100 حرف.',
        })
      }

      if (creditNoteNumber.length < 1 || creditNoteNumber.length > 100) {
        return res.status(400).json({
          error: 'رقم إشعار الخصم مطلوب وبحد أقصى 100 حرف.',
        })
      }

      if (idempotencyKey.length < 10 || idempotencyKey.length > 150) {
        return res.status(400).json({
          error: 'idempotencyKey is invalid',
        })
      }

      if (note.length > 500) {
        return res.status(400).json({
          error: 'ملاحظة المرتجع لا يمكن أن تتجاوز 500 حرف.',
        })
      }

      if (!Array.isArray(req.body?.items) || req.body.items.length === 0) {
        return res.status(400).json({
          error: 'اختر صنفًا واحدًا على الأقل للمرتجع.',
        })
      }

      const normalizedItems: Array<{
        receiptItemId: string
        quantity: number
      }> = []

      const receiptItemIds = new Set<string>()

      for (const item of req.body.items) {
        const receiptItemId =
          typeof item?.receiptItemId === 'string'
            ? item.receiptItemId.trim().toLowerCase()
            : ''

        const quantity = parseSupplierReturnQuantity(item?.quantity)

        if (!isUuid(receiptItemId)) {
          throw new SupplierFinanceApiError(400, 'يوجد receiptItemId غير صالح.')
        }

        if (quantity === null) {
          throw new SupplierFinanceApiError(
            400,
            'كمية المرتجع يجب أن تكون أكبر من صفر وبدقة ثلاث خانات.',
          )
        }

        if (receiptItemIds.has(receiptItemId)) {
          throw new SupplierFinanceApiError(
            400,
            'تم إرسال نفس صنف الإذن أكثر من مرة.',
          )
        }

        receiptItemIds.add(receiptItemId)

        normalizedItems.push({
          receiptItemId,
          quantity,
        })
      }

      const existingReturn = await loadSupplierReturnByIdempotency(
        auth.companyId,
        idempotencyKey,
        auth.branchId,
      )

      if (existingReturn) {
        if (existingReturn.supplier_invoice_id !== invoiceId) {
          return res.status(409).json({
            error: 'Idempotency key belongs to another supplier invoice',
          })
        }

        return res.status(200).json({
          duplicated: true,
          data: existingReturn,
        })
      }

      await client.query('BEGIN')

      const invoiceResult = await client.query(
        `
          SELECT
            invoice.*,

            receipt.receipt_number,
            receipt.status AS receipt_status,
            receipt.stock_location_id,

            location.name AS stock_location_name,
            location.code AS stock_location_code

          FROM supplier_invoices invoice

          JOIN purchase_receipts receipt
            ON receipt.company_id =
               invoice.company_id

            AND receipt.id =
                invoice.purchase_receipt_id

          JOIN stock_locations location
            ON location.company_id =
               receipt.company_id

            AND location.id =
                receipt.stock_location_id

          WHERE invoice.company_id = $1
            AND invoice.id = $2

            AND (
              $3::uuid IS NULL
              OR invoice.branch_id = $3
            )

          FOR UPDATE OF invoice, receipt, location;
        `,
        [auth.companyId, invoiceId, auth.branchId],
      )

      if ((invoiceResult.rowCount ?? 0) === 0) {
        throw new SupplierFinanceApiError(
          404,
          'فاتورة المورد غير موجودة أو غير مسموح بها.',
        )
      }

      const invoice = invoiceResult.rows[0]

      if (invoice.status === 'cancelled') {
        throw new SupplierFinanceApiError(
          409,
          'لا يمكن إنشاء مرتجع لفاتورة ملغية.',
        )
      }

      if (invoice.receipt_status !== 'received') {
        throw new SupplierFinanceApiError(409, 'إذن الاستلام غير متاح للمرتجع.')
      }

      const receiptItemsResult = await client.query(
        `
            SELECT
              receipt_item.*,

              product.name AS product_name,
              variant.sku

            FROM purchase_receipt_items receipt_item

            JOIN product_variants variant
              ON variant.company_id =
                 receipt_item.company_id

              AND variant.id =
                  receipt_item.variant_id

            JOIN products product
              ON product.company_id =
                 variant.company_id

              AND product.id =
                  variant.product_id

            WHERE receipt_item.company_id = $1

              AND receipt_item.purchase_receipt_id =
                  $2

              AND receipt_item.id =
                  ANY($3::uuid[])

            ORDER BY receipt_item.id

            FOR UPDATE OF receipt_item;
          `,
        [
          auth.companyId,
          invoice.purchase_receipt_id,
          Array.from(receiptItemIds),
        ],
      )

      if (receiptItemsResult.rows.length !== normalizedItems.length) {
        throw new SupplierFinanceApiError(
          400,
          'يوجد صنف غير تابع لإذن الاستلام.',
        )
      }

      const returnedQuantitiesResult = await client.query(
        `
            SELECT
              return_item.purchase_receipt_item_id,

              COALESCE(
                SUM(return_item.quantity),
                0
              ) AS returned_quantity

            FROM supplier_return_items return_item

            JOIN supplier_returns supplier_return
              ON supplier_return.company_id =
                 return_item.company_id

              AND supplier_return.id =
                  return_item.supplier_return_id

            WHERE return_item.company_id = $1

              AND return_item.purchase_receipt_item_id =
                  ANY($2::uuid[])

              AND supplier_return.status = 'posted'

            GROUP BY
              return_item.purchase_receipt_item_id;
          `,
        [auth.companyId, Array.from(receiptItemIds)],
      )

      const returnedQuantityByItem = new Map<string, number>(
        returnedQuantitiesResult.rows.map((row) => [
          row.purchase_receipt_item_id,
          Number(row.returned_quantity),
        ]),
      )

      const variantIds = receiptItemsResult.rows.map((item) => item.variant_id)

      const balancesResult = await client.query(
        `
          SELECT
            id,
            variant_id,
            quantity

          FROM stock_balances

          WHERE company_id = $1
            AND stock_location_id = $2
            AND variant_id = ANY($3::uuid[])

          ORDER BY variant_id

          FOR UPDATE;
        `,
        [auth.companyId, invoice.stock_location_id, variantIds],
      )

      const balanceByVariant = new Map<
        string,
        {
          id: string
          quantity: number
        }
      >(
        balancesResult.rows.map((row) => [
          row.variant_id,
          {
            id: row.id,
            quantity: Number(row.quantity),
          },
        ]),
      )

      const resolvedItems: Array<{
        receiptItemId: string
        variantId: string
        quantity: number
        unitCost: number
        discountAmount: number
        taxAmount: number
        lineTotal: number
        quantityBefore: number
        quantityAfter: number
      }> = []

      let subtotal = 0
      let discountTotal = 0
      let taxTotal = 0
      let returnTotal = 0

      for (const receiptItem of receiptItemsResult.rows) {
        const requestedItem = normalizedItems.find(
          (item) => item.receiptItemId === receiptItem.id,
        )

        if (!requestedItem) {
          throw new SupplierFinanceApiError(400, 'يوجد صنف لم يتم تحديد كميته.')
        }

        const receivedQuantity = Number(receiptItem.quantity)

        const previouslyReturned =
          returnedQuantityByItem.get(receiptItem.id) ?? 0

        const availableQuantity = roundQuantity(
          receivedQuantity - previouslyReturned,
        )

        if (requestedItem.quantity > availableQuantity) {
          throw new SupplierFinanceApiError(
            409,
            `كمية مرتجع الصنف ${receiptItem.sku} أكبر من الكمية المتاحة.`,
          )
        }

        const balance = balanceByVariant.get(receiptItem.variant_id)

        if (!balance || balance.quantity < requestedItem.quantity) {
          throw new SupplierFinanceApiError(
            409,
            `الرصيد الحالي للصنف ${receiptItem.sku} لا يكفي لتنفيذ المرتجع.`,
          )
        }

        const ratio = requestedItem.quantity / receivedQuantity

        const itemSubtotal = roundMoney(
          Number(receiptItem.unit_cost) * requestedItem.quantity,
        )

        const itemDiscount = roundMoney(
          Number(receiptItem.discount_amount) * ratio,
        )

        const itemTax = roundMoney(Number(receiptItem.tax_amount) * ratio)

        const itemTotal = roundMoney(Number(receiptItem.line_total) * ratio)

        const quantityAfter = roundQuantity(
          balance.quantity - requestedItem.quantity,
        )

        subtotal = roundMoney(subtotal + itemSubtotal)

        discountTotal = roundMoney(discountTotal + itemDiscount)

        taxTotal = roundMoney(taxTotal + itemTax)

        returnTotal = roundMoney(returnTotal + itemTotal)

        resolvedItems.push({
          receiptItemId: receiptItem.id,
          variantId: receiptItem.variant_id,
          quantity: requestedItem.quantity,
          unitCost: Number(receiptItem.unit_cost),
          discountAmount: itemDiscount,
          taxAmount: itemTax,
          lineTotal: itemTotal,
          quantityBefore: balance.quantity,
          quantityAfter,
        })
      }

      if (returnTotal <= 0) {
        throw new SupplierFinanceApiError(409, 'إجمالي المرتجع غير صالح.')
      }

      const currentCreditTotal = roundMoney(Number(invoice.credit_total ?? 0))

      const nextCreditTotal = roundMoney(currentCreditTotal + returnTotal)

      if (nextCreditTotal > Number(invoice.total)) {
        throw new SupplierFinanceApiError(
          409,
          'إجمالي إشعارات الخصم يتجاوز قيمة الفاتورة.',
        )
      }

      const supplierReturnResult = await client.query(
        `
            INSERT INTO supplier_returns (
              company_id,
              branch_id,

              supplier_invoice_id,
              purchase_receipt_id,
              supplier_id,

              stock_location_id,

              return_number,
              idempotency_key,

              status,

              subtotal,
              discount_total,
              tax_total,
              total,

              note,
              created_by
            )
            VALUES (
              $1, $2,
              $3, $4, $5,
              $6,
              $7, $8,
              'posted',
              $9, $10, $11, $12,
              $13, $14
            )
            RETURNING *;
          `,
        [
          auth.companyId,
          invoice.branch_id,

          invoice.id,
          invoice.purchase_receipt_id,
          invoice.supplier_id,

          invoice.stock_location_id,

          returnNumber,
          idempotencyKey,

          subtotal,
          discountTotal,
          taxTotal,
          returnTotal,

          note || null,
          auth.userId,
        ],
      )

      const supplierReturn = supplierReturnResult.rows[0]

      for (const item of resolvedItems) {
        await client.query(
          `
            INSERT INTO supplier_return_items (
              company_id,

              supplier_return_id,
              purchase_receipt_item_id,

              variant_id,

              quantity,
              unit_cost,

              discount_amount,
              tax_amount,
              line_total
            )
            VALUES (
              $1,
              $2, $3,
              $4,
              $5, $6,
              $7, $8, $9
            );
          `,
          [
            auth.companyId,

            supplierReturn.id,
            item.receiptItemId,

            item.variantId,

            item.quantity,
            item.unitCost,

            item.discountAmount,
            item.taxAmount,
            item.lineTotal,
          ],
        )

        await client.query(
          `
            UPDATE stock_balances

            SET
              quantity = $1,
              updated_at = NOW()

            WHERE company_id = $2
              AND stock_location_id = $3
              AND variant_id = $4;
          `,
          [
            item.quantityAfter,
            auth.companyId,
            invoice.stock_location_id,
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
              $1, $2,
              $3, $4,
              'purchase_return',
              $5, $6, $7,
              'supplier_return',
              $8,
              $9,
              $10
            );
          `,
          [
            auth.companyId,
            invoice.branch_id,

            invoice.stock_location_id,
            item.variantId,

            -item.quantity,
            item.quantityBefore,
            item.quantityAfter,

            supplierReturn.id,

            `Supplier return ${returnNumber}`,

            auth.userId,
          ],
        )
      }

      const creditNoteResult = await client.query(
        `
            INSERT INTO supplier_credit_notes (
              company_id,
              branch_id,

              supplier_invoice_id,
              supplier_return_id,
              supplier_id,

              credit_note_number,
              amount,

              note,
              created_by
            )
            VALUES (
              $1, $2,
              $3, $4, $5,
              $6, $7,
              $8, $9
            )
            RETURNING *;
          `,
        [
          auth.companyId,
          invoice.branch_id,

          invoice.id,
          supplierReturn.id,
          invoice.supplier_id,

          creditNoteNumber,
          returnTotal,

          note || null,
          auth.userId,
        ],
      )

      const financialState = resolveSupplierInvoiceFinancialState(
        Number(invoice.total),
        Number(invoice.paid_total),
        nextCreditTotal,
      )

      const updatedInvoiceResult = await client.query(
        `
            UPDATE supplier_invoices

            SET
              credit_total = $1,
              balance = $2,
              supplier_credit_balance = $3,
              status = $4,
              updated_at = NOW()

            WHERE company_id = $5
              AND id = $6

            RETURNING *;
          `,
        [
          nextCreditTotal,
          financialState.balance,
          financialState.supplierCreditBalance,
          financialState.status,
          auth.companyId,
          invoice.id,
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
            'purchases.supplier_return.created',
            'supplier_return',
            $4,
            $5::jsonb,
            $6::jsonb,
            $7,
            $8
          );
        `,
        [
          auth.companyId,
          invoice.branch_id,
          auth.userId,

          supplierReturn.id,

          JSON.stringify({
            invoiceId: invoice.id,
            invoiceBalance: Number(invoice.balance),
            invoiceCreditTotal: currentCreditTotal,
          }),

          JSON.stringify({
            returnNumber,
            creditNoteNumber,
            returnTotal,
            itemCount: resolvedItems.length,

            invoiceCreditTotal: nextCreditTotal,

            invoiceBalance: financialState.balance,

            supplierCreditBalance: financialState.supplierCreditBalance,

            invoiceStatus: financialState.status,
          }),

          req.ip || null,
          req.get('user-agent') || null,
        ],
      )

      await client.query('COMMIT')

      return res.status(201).json({
        duplicated: false,

        data: {
          ...supplierReturn,
          credit_note_number: creditNoteResult.rows[0].credit_note_number,

          credit_note_amount: creditNoteResult.rows[0].amount,
        },

        invoice: updatedInvoiceResult.rows[0],
      })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})

      if (isUniqueViolation(error)) {
        const requestIdempotencyKey =
          typeof req.body?.idempotencyKey === 'string'
            ? req.body.idempotencyKey.trim()
            : ''

        if (requestIdempotencyKey) {
          const existingReturn = await loadSupplierReturnByIdempotency(
            auth.companyId,
            requestIdempotencyKey,
            auth.branchId,
          )

          if (
            existingReturn &&
            existingReturn.supplier_invoice_id ===
              String(req.params.invoiceId || '')
                .trim()
                .toLowerCase()
          ) {
            return res.status(200).json({
              duplicated: true,
              data: existingReturn,
            })
          }
        }

        return res.status(409).json({
          error: 'رقم المرتجع أو إشعار الخصم مستخدم بالفعل.',
        })
      }

      if (error instanceof SupplierFinanceApiError) {
        return res.status(error.statusCode).json({
          error: error.message,
        })
      }

      return next(error)
    } finally {
      client.release()
    }
  },
)
