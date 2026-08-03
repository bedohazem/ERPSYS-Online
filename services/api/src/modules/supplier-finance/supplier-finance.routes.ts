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
              AND id = $2;
          `,
          [auth.companyId, invoiceId],
        )

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

      if (invoice.status === 'paid') {
        throw new SupplierFinanceApiError(409, 'الفاتورة مدفوعة بالكامل.')
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

      const nextBalance = roundMoney(Number(invoice.total) - nextPaidTotal)

      const nextStatus = nextBalance <= 0 ? 'paid' : 'partially_paid'

      const updatedInvoiceResult = await client.query(
        `
          UPDATE supplier_invoices

          SET
            paid_total = $1,
            balance = $2,
            status = $3,
            updated_at = NOW()

          WHERE company_id = $4
            AND id = $5

          RETURNING *;
        `,
        [nextPaidTotal, nextBalance, nextStatus, auth.companyId, invoiceId],
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
            balance: nextBalance,
            invoiceStatus: nextStatus,
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
