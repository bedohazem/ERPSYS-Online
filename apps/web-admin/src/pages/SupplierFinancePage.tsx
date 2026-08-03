import { useEffect, useMemo, useRef, useState } from 'react'

import { useAuth } from '../auth/AuthContext'
import SupplierReturnsPanel from '../components/SupplierReturnsPanel'
import { requestJson } from '../lib/http'

type Receipt = {
  id: string
  receipt_number: string
  supplier_name: string
  supplier_code: string
  total: string
  received_at: string
}

type SupplierInvoice = {
  id: string
  invoice_number: string
  supplier_invoice_number: string | null

  supplier_name: string
  supplier_code: string
  receipt_number: string

  invoice_date: string
  due_date: string | null

  status: string

  total: string

  paid_total: string
  credit_total: string

  balance: string
  supplier_credit_balance: string

  payments_count: number
  last_payment_at: string | null
}

type InvoiceListResponse = {
  data: SupplierInvoice[]

  summary: {
    invoices_count: number
    total_invoiced: string
    total_paid: string

    total_credited: string
    total_supplier_credit: string

    total_outstanding: string
    overdue_count: number
  }
}

type ApiResponse<T> = {
  data: T
}

const moneyFormatter = new Intl.NumberFormat('ar-EG', {
  style: 'currency',
  currency: 'EGP',
  maximumFractionDigits: 2,
})

const dateFormatter = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'medium',
})

function formatMoney(value: string | number) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? moneyFormatter.format(numericValue)
    : '-'
}

function formatDate(value: string | null) {
  if (!value) {
    return '-'
  }

  const parsedDate = new Date(value)

  return Number.isNaN(parsedDate.getTime())
    ? '-'
    : dateFormatter.format(parsedDate)
}

function createNumber(prefix: string) {
  return `${prefix}-${Date.now()}`
}

function createIdempotencyKey() {
  return `supplier-payment-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function translateStatus(status: string) {
  const labels: Record<string, string> = {
    open: 'مفتوحة',
    partially_paid: 'مدفوعة جزئيًا',
    paid: 'مسددة',
    credit_due: 'رصيد دائن مستحق من المورد',
    cancelled: 'ملغية',
  }

  return labels[status] || status
}

function SupplierFinancePage() {
  const { user } = useAuth()

  const isAdmin = user?.roles.includes('admin') ?? false

  const canCreate =
    isAdmin || user?.permissions.includes('purchases.create') || false

  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [invoices, setInvoices] = useState<SupplierInvoice[]>([])

  const [summary, setSummary] = useState<InvoiceListResponse['summary'] | null>(
    null,
  )

  const [receiptId, setReceiptId] = useState('')

  const [invoiceNumber, setInvoiceNumber] = useState(() => createNumber('SINV'))

  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState('')

  const [invoiceDate, setInvoiceDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  )

  const [dueDate, setDueDate] = useState('')
  const [invoiceNote, setInvoiceNote] = useState('')

  const [selectedInvoice, setSelectedInvoice] =
    useState<SupplierInvoice | null>(null)

  const [paymentAmount, setPaymentAmount] = useState<number | ''>('')

  // يظلان ثابتين أثناء إعادة محاولة نفس الدفعة.
  // لا يتم تغييرهما إلا بعد نجاح العملية أو اختيار فاتورة جديدة.
  const [paymentNumber, setPaymentNumber] = useState(() => createNumber('SPAY'))

  const [paymentIdempotencyKey, setPaymentIdempotencyKey] =
    useState(createIdempotencyKey)

  const [paymentMethod, setPaymentMethod] = useState('cash')

  const [paymentReference, setPaymentReference] = useState('')

  const [paymentNote, setPaymentNote] = useState('')

  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch] = useState('')

  const [loading, setLoading] = useState(false)
  const [savingInvoice, setSavingInvoice] = useState(false)
  const [savingPayment, setSavingPayment] = useState(false)

  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const invoiceLock = useRef(false)
  const paymentLock = useRef(false)

  const selectedReceipt = useMemo(
    () => receipts.find((receipt) => receipt.id === receiptId) || null,
    [receipts, receiptId],
  )

  async function loadReceipts() {
    if (!canCreate) {
      setReceipts([])
      return
    }

    const response = await requestJson<ApiResponse<Receipt[]>>(
      '/api/purchases/supplier-finance/receipts',
    )

    setReceipts(response.data)

    setReceiptId((current) =>
      response.data.some((receipt) => receipt.id === current)
        ? current
        : (response.data[0]?.id ?? ''),
    )
  }

  async function loadInvoices() {
    setLoading(true)
    setError('')

    try {
      const query = new URLSearchParams({
        limit: '200',
      })

      if (statusFilter) {
        query.set('status', statusFilter)
      }

      if (search.trim()) {
        query.set('q', search.trim())
      }

      const response = await requestJson<InvoiceListResponse>(
        `/api/purchases/supplier-invoices?${query.toString()}`,
      )

      setInvoices(response.data)
      setSummary(response.summary)

      setSelectedInvoice((current) => {
        if (!current) {
          return null
        }

        return (
          response.data.find((invoice) => invoice.id === current.id) || null
        )
      })
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل فواتير الموردين.',
      )
    } finally {
      setLoading(false)
    }
  }

  async function createInvoice() {
    if (invoiceLock.current) {
      return
    }

    invoiceLock.current = true
    setSavingInvoice(true)
    setError('')
    setSuccess('')

    try {
      if (!receiptId) {
        throw new Error('اختر إذن الاستلام.')
      }

      if (!invoiceNumber.trim()) {
        throw new Error('رقم الفاتورة مطلوب.')
      }

      const response = await requestJson<ApiResponse<SupplierInvoice>>(
        '/api/purchases/supplier-invoices',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            receiptId,
            invoiceNumber: invoiceNumber.trim(),
            supplierInvoiceNumber: supplierInvoiceNumber.trim() || null,
            invoiceDate,
            dueDate: dueDate || null,
            note: invoiceNote.trim() || null,
          }),
        },
      )

      setSuccess(`تم إنشاء فاتورة المورد ${response.data.invoice_number}.`)

      setInvoiceNumber(createNumber('SINV'))
      setSupplierInvoiceNumber('')
      setDueDate('')
      setInvoiceNote('')

      await Promise.all([loadReceipts(), loadInvoices()])
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر إنشاء فاتورة المورد.',
      )
    } finally {
      invoiceLock.current = false
      setSavingInvoice(false)
    }
  }

  function selectInvoiceForPayment(invoice: SupplierInvoice) {
    setSelectedInvoice(invoice)
    setPaymentAmount(Number(invoice.balance))

    // اختيار فاتورة جديدة يعني بدء محاولة دفع جديدة.
    setPaymentNumber(createNumber('SPAY'))
    setPaymentIdempotencyKey(createIdempotencyKey())

    setPaymentReference('')
    setPaymentNote('')
    setError('')
    setSuccess('')
  }
  async function createPayment() {
    if (paymentLock.current || !selectedInvoice) {
      return
    }

    paymentLock.current = true
    setSavingPayment(true)
    setError('')
    setSuccess('')

    try {
      const amount = Number(paymentAmount)

      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('مبلغ الدفعة غير صالح.')
      }

      if (amount > Number(selectedInvoice.balance)) {
        throw new Error('مبلغ الدفعة أكبر من الرصيد المستحق.')
      }

      const response = await requestJson<ApiResponse<SupplierInvoice>>(
        `/api/purchases/supplier-invoices/${encodeURIComponent(
          selectedInvoice.id,
        )}/pay`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            paymentNumber,
            idempotencyKey: paymentIdempotencyKey,
            amount,
            paymentMethod,
            referenceNumber: paymentReference.trim() || null,
            note: paymentNote.trim() || null,
          }),
        },
      )

      setSuccess(
        `تم تسجيل الدفعة. الرصيد المتبقي: ${formatMoney(
          response.data.balance,
        )}`,
      )

      setSelectedInvoice(null)
      setPaymentAmount('')
      setPaymentReference('')
      setPaymentNote('')

      // نجاح العملية فقط هو الذي يبدأ مفتاح دفعة جديد.
      setPaymentNumber(createNumber('SPAY'))
      setPaymentIdempotencyKey(createIdempotencyKey())

      await loadInvoices()
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تسجيل دفعة المورد.',
      )
    } finally {
      paymentLock.current = false
      setSavingPayment(false)
    }
  }

  useEffect(() => {
    void loadInvoices()

    if (canCreate) {
      void loadReceipts()
    }
  }, [canCreate, statusFilter])

  return (
    <>
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>فواتير ومدفوعات الموردين</h2>

            <p className="muted">
              ربط أذون الاستلام بفواتير الموردين ومتابعة المستحقات.
            </p>
          </div>

          <button
            type="button"
            className="table-button"
            disabled={loading}
            onClick={() => void loadInvoices()}
          >
            {loading ? 'جاري التحديث...' : 'تحديث'}
          </button>
        </div>

        {error ? <p className="error-message">{error}</p> : null}
        {success ? <p className="success-message">{success}</p> : null}
      </section>

      {summary ? (
        <section className="mini-cards-grid">
          <article className="mini-card">
            <span>إجمالي الفواتير</span>
            <strong>{formatMoney(summary.total_invoiced)}</strong>
          </article>

          <article className="mini-card">
            <span>إجمالي المدفوع</span>
            <strong>{formatMoney(summary.total_paid)}</strong>
          </article>

          <article className="mini-card">
            <span>إشعارات الخصم</span>
            <strong>{formatMoney(summary.total_credited)}</strong>
          </article>

          <article className="mini-card">
            <span>الرصيد المستحق للموردين</span>
            <strong>{formatMoney(summary.total_outstanding)}</strong>
          </article>

          <article className="mini-card">
            <span>رصيد دائن لنا</span>
            <strong>{formatMoney(summary.total_supplier_credit)}</strong>
          </article>

          <article className="mini-card">
            <span>فواتير متأخرة</span>
            <strong>{summary.overdue_count}</strong>
          </article>
        </section>
      ) : null}

      {canCreate ? (
        <section className="panel">
          <h2>إنشاء فاتورة مورد</h2>

          <div className="form-grid">
            <label>
              إذن الاستلام
              <select
                value={receiptId}
                onChange={(event) => setReceiptId(event.target.value)}
              >
                <option value="">اختر إذن الاستلام</option>

                {receipts.map((receipt) => (
                  <option key={receipt.id} value={receipt.id}>
                    {receipt.receipt_number} — {receipt.supplier_name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              رقم الفاتورة الداخلي
              <input
                value={invoiceNumber}
                onChange={(event) => setInvoiceNumber(event.target.value)}
              />
            </label>

            <label>
              رقم فاتورة المورد
              <input
                value={supplierInvoiceNumber}
                onChange={(event) =>
                  setSupplierInvoiceNumber(event.target.value)
                }
              />
            </label>

            <label>
              تاريخ الفاتورة
              <input
                type="date"
                value={invoiceDate}
                onChange={(event) => setInvoiceDate(event.target.value)}
              />
            </label>

            <label>
              تاريخ الاستحقاق
              <input
                type="date"
                value={dueDate}
                min={invoiceDate}
                onChange={(event) => setDueDate(event.target.value)}
              />
            </label>

            <label>
              ملاحظة
              <input
                value={invoiceNote}
                maxLength={500}
                onChange={(event) => setInvoiceNote(event.target.value)}
              />
            </label>
          </div>

          {selectedReceipt ? (
            <p className="muted">
              المورد: {selectedReceipt.supplier_name}
              {' — '}
              إجمالي الإذن: {formatMoney(selectedReceipt.total)}
            </p>
          ) : null}

          <button
            type="button"
            className="primary-button"
            disabled={savingInvoice || !receiptId}
            onClick={() => void createInvoice()}
          >
            {savingInvoice ? 'جاري الحفظ...' : 'إنشاء فاتورة المورد'}
          </button>
        </section>
      ) : null}

      {selectedInvoice ? (
        <section className="panel">
          <div className="section-header">
            <div>
              <h2>تسجيل دفعة — {selectedInvoice.invoice_number}</h2>

              <p className="muted">
                {selectedInvoice.supplier_name}
                {' — '}
                المستحق: {formatMoney(selectedInvoice.balance)}
              </p>
            </div>
          </div>

          <div className="form-grid">
            <label>
              مبلغ الدفعة
              <input
                type="number"
                min="0.01"
                step="0.01"
                max={Number(selectedInvoice.balance)}
                value={paymentAmount}
                onChange={(event) =>
                  setPaymentAmount(
                    event.target.value === '' ? '' : Number(event.target.value),
                  )
                }
              />
            </label>

            <label>
              طريقة الدفع
              <select
                value={paymentMethod}
                onChange={(event) => setPaymentMethod(event.target.value)}
              >
                <option value="cash">نقدي</option>
                <option value="bank_transfer">تحويل بنكي</option>
                <option value="card">بطاقة</option>
                <option value="cheque">شيك</option>
                <option value="other">أخرى</option>
              </select>
            </label>

            <label>
              رقم المرجع
              <input
                value={paymentReference}
                onChange={(event) => setPaymentReference(event.target.value)}
              />
            </label>

            <label>
              ملاحظة
              <input
                value={paymentNote}
                maxLength={500}
                onChange={(event) => setPaymentNote(event.target.value)}
              />
            </label>
          </div>

          <div className="section-actions">
            <button
              type="button"
              className="primary-button"
              disabled={savingPayment}
              onClick={() => void createPayment()}
            >
              {savingPayment ? 'جاري تسجيل الدفعة...' : 'تسجيل الدفعة'}
            </button>

            <button
              type="button"
              className="table-button"
              disabled={savingPayment}
              onClick={() => setSelectedInvoice(null)}
            >
              إلغاء
            </button>
          </div>
        </section>
      ) : null}

      <SupplierReturnsPanel
        invoices={invoices}
        canCreate={canCreate}
        onChanged={async () => {
          // نغلق نموذج الدفع لو تغير رصيد الفاتورة
          // نتيجة إشعار خصم جديد.
          setSelectedInvoice(null)
          setPaymentAmount('')

          await Promise.all([loadInvoices(), loadReceipts()])
        }}
      />

      <section className="panel">
        <div className="section-header">
          <h2>سجل فواتير الموردين</h2>

          <div className="section-actions">
            <input
              value={search}
              placeholder="بحث برقم الفاتورة أو المورد"
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void loadInvoices()
                }
              }}
            />

            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">كل الحالات</option>
              <option value="open">مفتوحة</option>
              <option value="partially_paid">مدفوعة جزئيًا</option>
              <option value="paid">مسددة</option>
              <option value="credit_due">رصيد دائن مستحق من المورد</option>
              <option value="cancelled">ملغية</option>
            </select>

            <button
              type="button"
              className="table-button"
              onClick={() => void loadInvoices()}
            >
              بحث
            </button>
          </div>
        </div>

        {invoices.length === 0 ? (
          <p className="muted">لا توجد فواتير موردين.</p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>رقم الفاتورة</th>
                  <th>المورد</th>
                  <th>إذن الاستلام</th>
                  <th>التاريخ</th>
                  <th>الاستحقاق</th>
                  <th>الإجمالي</th>
                  <th>المدفوع</th>
                  <th>إشعارات الخصم</th>
                  <th>المتبقي للمورد</th>
                  <th>رصيد دائن لنا</th>
                  <th>الحالة</th>
                  <th>الإجراء</th>
                </tr>
              </thead>

              <tbody>
                {invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td>
                      {invoice.invoice_number}

                      {invoice.supplier_invoice_number ? (
                        <small className="stock-count-cell-note">
                          {invoice.supplier_invoice_number}
                        </small>
                      ) : null}
                    </td>

                    <td>{invoice.supplier_name}</td>
                    <td>{invoice.receipt_number}</td>
                    <td>{formatDate(invoice.invoice_date)}</td>
                    <td>{formatDate(invoice.due_date)}</td>
                    <td>{formatMoney(invoice.total)}</td>

                    <td>{formatMoney(invoice.paid_total)}</td>

                    <td>{formatMoney(invoice.credit_total)}</td>

                    <td>
                      <strong>{formatMoney(invoice.balance)}</strong>
                    </td>

                    <td>
                      <strong>
                        {formatMoney(invoice.supplier_credit_balance)}
                      </strong>
                    </td>

                    <td>{translateStatus(invoice.status)}</td>

                    <td>
                      {canCreate &&
                      Number(invoice.balance) > 0 &&
                      invoice.status !== 'cancelled' ? (
                        <button
                          type="button"
                          className="table-button"
                          onClick={() => selectInvoiceForPayment(invoice)}
                        >
                          تسجيل دفعة
                        </button>
                      ) : (
                        '-'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}

export default SupplierFinancePage
