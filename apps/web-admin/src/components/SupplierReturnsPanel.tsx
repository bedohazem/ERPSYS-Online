import { useEffect, useMemo, useRef, useState } from 'react'

import { requestJson } from '../lib/http'

type InvoiceOption = {
  id: string
  invoice_number: string
  supplier_name: string
  receipt_number: string

  status: string

  total: string
  credit_total: string
}

type ReturnContextItem = {
  receipt_item_id: string
  variant_id: string

  product_name: string
  sku: string
  primary_barcode: string | null

  size_name: string | null
  color_name: string | null

  received_quantity: string
  returned_quantity: string
  available_quantity: string
  stock_quantity: string

  unit_cost: string
  discount_amount: string
  tax_amount: string
  line_total: string
}

type ReturnContext = {
  invoice: InvoiceOption & {
    stock_location_id: string
    stock_location_name: string
    stock_location_code: string
  }

  items: ReturnContextItem[]
}

type SupplierReturn = {
  id: string

  return_number: string
  credit_note_number: string

  invoice_number: string
  receipt_number: string

  supplier_name: string

  stock_location_name: string
  stock_location_code: string

  total: string
  items_count: number

  created_by_name: string | null
  created_at: string
}

type ReturnListResponse = {
  data: SupplierReturn[]

  summary: {
    returns_count: number
    total_returned: string
  }
}

type ApiResponse<T> = {
  data: T
  duplicated?: boolean
}

type SupplierReturnsPanelProps = {
  invoices: InvoiceOption[]
  canCreate: boolean

  onChanged: () => Promise<void> | void
}

const moneyFormatter = new Intl.NumberFormat('ar-EG', {
  style: 'currency',
  currency: 'EGP',
  maximumFractionDigits: 2,
})

const quantityFormatter = new Intl.NumberFormat('ar-EG', {
  maximumFractionDigits: 3,
})

const dateFormatter = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatMoney(value: string | number) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? moneyFormatter.format(numericValue)
    : '-'
}

function formatQuantity(value: string | number) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? quantityFormatter.format(numericValue)
    : '-'
}

function formatDate(value: string) {
  const parsedDate = new Date(value)

  return Number.isNaN(parsedDate.getTime())
    ? '-'
    : dateFormatter.format(parsedDate)
}

function createDocumentNumber(prefix: string) {
  return `${prefix}-${Date.now()}`
}

function createReturnIdempotencyKey() {
  return `supplier-return-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function SupplierReturnsPanel({
  invoices,
  canCreate,
  onChanged,
}: SupplierReturnsPanelProps) {
  const [returns, setReturns] = useState<SupplierReturn[]>([])

  const [summary, setSummary] = useState<ReturnListResponse['summary'] | null>(
    null,
  )

  const [invoiceId, setInvoiceId] = useState('')

  const [returnContext, setReturnContext] = useState<ReturnContext | null>(null)

  const [quantities, setQuantities] = useState<Record<string, number | ''>>({})

  const [returnNumber, setReturnNumber] = useState(() =>
    createDocumentNumber('SRET'),
  )

  const [creditNoteNumber, setCreditNoteNumber] = useState(() =>
    createDocumentNumber('SCN'),
  )

  const [returnIdempotencyKey, setReturnIdempotencyKey] = useState(
    createReturnIdempotencyKey,
  )

  const [note, setNote] = useState('')

  const [loadingContext, setLoadingContext] = useState(false)

  const [loadingReturns, setLoadingReturns] = useState(false)

  const [saving, setSaving] = useState(false)

  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const requestLock = useRef(false)

  const eligibleInvoices = useMemo(
    () =>
      invoices.filter(
        (invoice) =>
          invoice.status !== 'cancelled' &&
          Number(invoice.credit_total || 0) < Number(invoice.total),
      ),
    [invoices],
  )

  const estimatedTotal = useMemo(() => {
    if (!returnContext) {
      return 0
    }

    return returnContext.items.reduce((total, item) => {
      const quantity = Number(quantities[item.receipt_item_id] || 0)

      const receivedQuantity = Number(item.received_quantity)

      const lineTotal = Number(item.line_total)

      if (
        !Number.isFinite(quantity) ||
        quantity <= 0 ||
        !Number.isFinite(receivedQuantity) ||
        receivedQuantity <= 0
      ) {
        return total
      }

      return total + (lineTotal / receivedQuantity) * quantity
    }, 0)
  }, [returnContext, quantities])

  async function loadReturns() {
    setLoadingReturns(true)

    try {
      const response = await requestJson<ReturnListResponse>(
        '/api/purchases/supplier-returns?limit=100',
      )

      setReturns(response.data)
      setSummary(response.summary)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل مرتجعات الموردين.',
      )
    } finally {
      setLoadingReturns(false)
    }
  }

  async function loadReturnContext() {
    if (!invoiceId) {
      setError('اختر فاتورة المورد.')
      return
    }

    setLoadingContext(true)
    setError('')
    setSuccess('')
    setReturnContext(null)

    try {
      const response = await requestJson<ApiResponse<ReturnContext>>(
        `/api/purchases/supplier-invoices/${encodeURIComponent(
          invoiceId,
        )}/return-context`,
      )

      setReturnContext(response.data)

      setQuantities(
        Object.fromEntries(
          response.data.items.map((item) => [item.receipt_item_id, '']),
        ),
      )

      setReturnNumber(createDocumentNumber('SRET'))

      setCreditNoteNumber(createDocumentNumber('SCN'))

      setReturnIdempotencyKey(createReturnIdempotencyKey())

      setNote('')
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل بيانات مرتجع المورد.',
      )
    } finally {
      setLoadingContext(false)
    }
  }

  async function createSupplierReturn() {
    if (requestLock.current || !returnContext) {
      return
    }

    requestLock.current = true
    setSaving(true)
    setError('')
    setSuccess('')

    try {
      const items = returnContext.items.flatMap((item) => {
        const quantity = Number(quantities[item.receipt_item_id] || 0)

        if (!Number.isFinite(quantity) || quantity <= 0) {
          return []
        }

        const roundedQuantity = Number(quantity.toFixed(3))

        if (Math.abs(quantity - roundedQuantity) > 0.0000001) {
          throw new Error(`كمية الصنف ${item.sku} تقبل ثلاث خانات عشرية فقط.`)
        }

        if (roundedQuantity > Number(item.available_quantity)) {
          throw new Error(
            `كمية الصنف ${item.sku} أكبر من الكمية المتاحة للمرتجع.`,
          )
        }

        if (roundedQuantity > Number(item.stock_quantity)) {
          throw new Error(`الرصيد الحالي للصنف ${item.sku} لا يكفي.`)
        }

        return [
          {
            receiptItemId: item.receipt_item_id,

            quantity: roundedQuantity,
          },
        ]
      })

      if (items.length === 0) {
        throw new Error('حدد كمية لصنف واحد على الأقل.')
      }

      if (!returnNumber.trim()) {
        throw new Error('رقم مرتجع المورد مطلوب.')
      }

      if (!creditNoteNumber.trim()) {
        throw new Error('رقم إشعار الخصم مطلوب.')
      }

      const confirmed = window.confirm(
        `سيتم خصم أصناف بقيمة تقريبية ${formatMoney(
          estimatedTotal,
        )} من المخزون. هل تريد المتابعة؟`,
      )

      if (!confirmed) {
        return
      }

      const response = await requestJson<ApiResponse<SupplierReturn>>(
        `/api/purchases/supplier-invoices/${encodeURIComponent(
          returnContext.invoice.id,
        )}/returns`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            returnNumber: returnNumber.trim(),

            creditNoteNumber: creditNoteNumber.trim(),

            idempotencyKey: returnIdempotencyKey,

            note: note.trim() || null,

            items,
          }),
        },
      )

      setSuccess(
        response.duplicated
          ? 'تم العثور على نفس المرتجع المسجل سابقًا.'
          : `تم تسجيل المرتجع ${response.data.return_number} وإشعار الخصم ${response.data.credit_note_number}.`,
      )

      setReturnContext(null)
      setInvoiceId('')
      setQuantities({})
      setNote('')

      setReturnNumber(createDocumentNumber('SRET'))

      setCreditNoteNumber(createDocumentNumber('SCN'))

      setReturnIdempotencyKey(createReturnIdempotencyKey())

      await Promise.all([loadReturns(), Promise.resolve(onChanged())])
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تسجيل مرتجع المورد.',
      )
    } finally {
      requestLock.current = false
      setSaving(false)
    }
  }

  useEffect(() => {
    void loadReturns()
  }, [])

  useEffect(() => {
    setReturnContext(null)
    setQuantities({})
  }, [invoiceId])

  return (
    <>
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>مرتجعات الموردين وإشعارات الخصم</h2>

            <p className="muted">
              إرجاع أصناف من إذن الاستلام مع خصم المخزون وتحديث مديونية المورد.
            </p>
          </div>

          <button
            type="button"
            className="table-button"
            disabled={loadingReturns}
            onClick={() => void loadReturns()}
          >
            {loadingReturns ? 'جاري التحديث...' : 'تحديث المرتجعات'}
          </button>
        </div>

        {error ? <p className="error-message">{error}</p> : null}

        {success ? <p className="success-message">{success}</p> : null}

        {summary ? (
          <div className="mini-cards-grid">
            <article className="mini-card">
              <span>عدد المرتجعات</span>
              <strong>{summary.returns_count}</strong>
            </article>

            <article className="mini-card">
              <span>إجمالي إشعارات الخصم</span>
              <strong>{formatMoney(summary.total_returned)}</strong>
            </article>
          </div>
        ) : null}
      </section>

      {canCreate ? (
        <section className="panel">
          <h2>إنشاء مرتجع مورد</h2>

          <div className="form-grid">
            <label>
              فاتورة المورد
              <select
                value={invoiceId}
                disabled={loadingContext || saving}
                onChange={(event) => setInvoiceId(event.target.value)}
              >
                <option value="">اختر فاتورة المورد</option>

                {eligibleInvoices.map((invoice) => (
                  <option key={invoice.id} value={invoice.id}>
                    {invoice.invoice_number}
                    {' — '}
                    {invoice.supplier_name}
                    {' — '}
                    {invoice.receipt_number}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className="table-button"
              disabled={!invoiceId || loadingContext || saving}
              onClick={() => void loadReturnContext()}
            >
              {loadingContext ? 'جاري التحميل...' : 'تحميل أصناف الإذن'}
            </button>
          </div>

          {returnContext ? (
            <>
              <p className="muted">
                مكان خصم المخزون: {returnContext.invoice.stock_location_name}
                {' ('}
                {returnContext.invoice.stock_location_code}
                {')'}
              </p>

              <div className="form-grid">
                <label>
                  رقم المرتجع
                  <input
                    value={returnNumber}
                    maxLength={100}
                    disabled={saving}
                    onChange={(event) => setReturnNumber(event.target.value)}
                  />
                </label>

                <label>
                  رقم إشعار الخصم
                  <input
                    value={creditNoteNumber}
                    maxLength={100}
                    disabled={saving}
                    onChange={(event) =>
                      setCreditNoteNumber(event.target.value)
                    }
                  />
                </label>

                <label>
                  ملاحظة
                  <input
                    value={note}
                    maxLength={500}
                    disabled={saving}
                    onChange={(event) => setNote(event.target.value)}
                  />
                </label>
              </div>

              {returnContext.items.length === 0 ? (
                <p className="muted">تم إرجاع كل أصناف الإذن بالفعل.</p>
              ) : (
                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        <th>الصنف</th>
                        <th>المستلم</th>
                        <th>مرتجع سابق</th>
                        <th>المتاح</th>
                        <th>الرصيد الحالي</th>
                        <th>كمية المرتجع</th>
                      </tr>
                    </thead>

                    <tbody>
                      {returnContext.items.map((item) => (
                        <tr key={item.receipt_item_id}>
                          <td>
                            {item.product_name}

                            <small className="stock-count-cell-note">
                              SKU: {item.sku}
                              {' · '}
                              المقاس: {item.size_name || '-'}
                              {' · '}
                              اللون: {item.color_name || '-'}
                            </small>
                          </td>

                          <td>{formatQuantity(item.received_quantity)}</td>

                          <td>{formatQuantity(item.returned_quantity)}</td>

                          <td>{formatQuantity(item.available_quantity)}</td>

                          <td>{formatQuantity(item.stock_quantity)}</td>

                          <td>
                            <input
                              className="transfer-quantity-input"
                              type="number"
                              min="0"
                              step="0.001"
                              max={Math.min(
                                Number(item.available_quantity),
                                Number(item.stock_quantity),
                              )}
                              value={quantities[item.receipt_item_id] ?? ''}
                              disabled={saving}
                              onChange={(event) => {
                                const value = event.target.value

                                setQuantities((current) => ({
                                  ...current,

                                  [item.receipt_item_id]:
                                    value === '' ? '' : Number(value),
                                }))
                              }}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="section-actions">
                <strong>القيمة التقديرية: {formatMoney(estimatedTotal)}</strong>

                <button
                  type="button"
                  className="primary-button"
                  disabled={saving || returnContext.items.length === 0}
                  onClick={() => void createSupplierReturn()}
                >
                  {saving
                    ? 'جاري تسجيل المرتجع...'
                    : 'تسجيل المرتجع وإشعار الخصم'}
                </button>

                <button
                  type="button"
                  className="table-button"
                  disabled={saving}
                  onClick={() => {
                    setReturnContext(null)
                    setQuantities({})
                  }}
                >
                  إلغاء
                </button>
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      <section className="panel">
        <h2>سجل مرتجعات الموردين</h2>

        {returns.length === 0 ? (
          <p className="muted">لا توجد مرتجعات موردين.</p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>رقم المرتجع</th>
                  <th>إشعار الخصم</th>
                  <th>المورد</th>
                  <th>الفاتورة</th>
                  <th>إذن الاستلام</th>
                  <th>مكان المخزون</th>
                  <th>الأصناف</th>
                  <th>القيمة</th>
                  <th>التاريخ</th>
                </tr>
              </thead>

              <tbody>
                {returns.map((supplierReturn) => (
                  <tr key={supplierReturn.id}>
                    <td>{supplierReturn.return_number}</td>

                    <td>{supplierReturn.credit_note_number}</td>

                    <td>{supplierReturn.supplier_name}</td>

                    <td>{supplierReturn.invoice_number}</td>

                    <td>{supplierReturn.receipt_number}</td>

                    <td>
                      {supplierReturn.stock_location_name}

                      <small className="stock-count-cell-note">
                        {supplierReturn.stock_location_code}
                      </small>
                    </td>

                    <td>{supplierReturn.items_count}</td>

                    <td>
                      <strong>{formatMoney(supplierReturn.total)}</strong>
                    </td>

                    <td>{formatDate(supplierReturn.created_at)}</td>
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

export default SupplierReturnsPanel
