import { useEffect, useRef, useState } from 'react'

import { useAuth } from '../auth/AuthContext'
import { requestJson } from '../lib/http'

type ReceivableCustomer = {
  customer_id: string
  customer_name: string

  phone: string | null
  email: string | null

  allow_credit_sales: boolean
  credit_limit: string
  payment_terms_days: number

  outstanding_total: string
  overdue_total: string

  open_sales_count: number
  oldest_due_date: string | null

  total_collected: string
  last_collection_at: string | null

  credit_available: string
}

type ReceivableSale = {
  id: string
  sale_number: string

  branch_name: string

  total: string
  paid_total: string
  change_total: string

  payment_status: string
  outstanding_total: string
  due_date: string | null

  status: string
  occurred_at: string
}

type CustomerCollection = {
  id: string
  collection_number: string

  sale_id: string
  sale_number: string

  amount: string
  payment_method: string

  reference_number: string | null
  note: string | null

  collected_at: string
  created_by_name: string | null
}

type CustomerStatement = {
  customer: {
    id: string
    name: string
    phone: string | null
    email: string | null

    allow_credit_sales: boolean
    credit_limit: string
    payment_terms_days: number
  }

  summary: {
    outstanding_total: string
    overdue_total: string
    open_sales_count: number
    oldest_due_date: string | null
  }

  sales: ReceivableSale[]
  collections: CustomerCollection[]
}

type ReceivablesResponse = {
  data: ReceivableCustomer[]

  summary: {
    customers_with_balance: number
    total_outstanding: string
    total_overdue: string
    overdue_customers: number
  }
}

type ApiResponse<T> = {
  data: T
  duplicated?: boolean
}

const moneyFormatter = new Intl.NumberFormat('ar-EG', {
  style: 'currency',
  currency: 'EGP',
  maximumFractionDigits: 2,
})

const dateFormatter = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'medium',
})

const dateTimeFormatter = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'medium',
  timeStyle: 'short',
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

function formatDateTime(value: string | null) {
  if (!value) {
    return '-'
  }

  const parsedDate = new Date(value)

  return Number.isNaN(parsedDate.getTime())
    ? '-'
    : dateTimeFormatter.format(parsedDate)
}

function createCollectionNumber() {
  return `COL-${Date.now()}`
}

function createIdempotencyKey() {
  return (
    `customer-collection-` +
    `${Date.now()}-` +
    `${Math.random().toString(16).slice(2)}`
  )
}

function translatePaymentStatus(status: string) {
  const labels: Record<string, string> = {
    paid: 'مسددة',
    partially_paid: 'مدفوعة جزئيًا',
    unpaid: 'غير مدفوعة',
    voided: 'ملغاة',
  }

  return labels[status] || status
}

function translatePaymentMethod(method: string) {
  const labels: Record<string, string> = {
    cash: 'نقدي',
    card: 'بطاقة',
    wallet: 'محفظة',
    bank_transfer: 'تحويل بنكي',
    other: 'أخرى',
  }

  return labels[method] || method
}

function CustomerReceivablesPage() {
  const { user } = useAuth()

  const isAdmin = user?.roles.includes('admin') ?? false

  const canCollect =
    isAdmin || user?.permissions.includes('receivables.collect') || false

  const canManageCredit =
    isAdmin || user?.permissions.includes('receivables.manage_credit') || false

  const [customers, setCustomers] = useState<ReceivableCustomer[]>([])

  const [summary, setSummary] = useState<ReceivablesResponse['summary'] | null>(
    null,
  )

  const [selectedCustomer, setSelectedCustomer] =
    useState<ReceivableCustomer | null>(null)

  const [statement, setStatement] = useState<CustomerStatement | null>(null)

  const [selectedSale, setSelectedSale] = useState<ReceivableSale | null>(null)

  const [search, setSearch] = useState('')

  const [onlyOutstanding, setOnlyOutstanding] = useState(true)

  const [allowCreditSales, setAllowCreditSales] = useState(false)

  const [creditLimit, setCreditLimit] = useState<number | ''>('')

  const [paymentTermsDays, setPaymentTermsDays] = useState(0)

  const [collectionNumber, setCollectionNumber] = useState(
    createCollectionNumber,
  )

  const [collectionIdempotencyKey, setCollectionIdempotencyKey] =
    useState(createIdempotencyKey)

  const [collectionAmount, setCollectionAmount] = useState<number | ''>('')

  const [paymentMethod, setPaymentMethod] = useState('cash')

  const [referenceNumber, setReferenceNumber] = useState('')

  const [collectionNote, setCollectionNote] = useState('')

  const [loading, setLoading] = useState(false)

  const [loadingStatement, setLoadingStatement] = useState(false)

  const [savingPolicy, setSavingPolicy] = useState(false)

  const [savingCollection, setSavingCollection] = useState(false)

  const [error, setError] = useState('')

  const [success, setSuccess] = useState('')

  const policyLock = useRef(false)
  const collectionLock = useRef(false)

  async function loadReceivables() {
    setLoading(true)
    setError('')

    try {
      const query = new URLSearchParams({
        limit: '200',

        onlyOutstanding: String(onlyOutstanding),
      })

      if (search.trim()) {
        query.set('q', search.trim())
      }

      const response = await requestJson<ReceivablesResponse>(
        `/api/receivables?${query.toString()}`,
      )

      setCustomers(response.data)
      setSummary(response.summary)

      setSelectedCustomer((current) =>
        current
          ? response.data.find(
              (customer) => customer.customer_id === current.customer_id,
            ) || current
          : null,
      )
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل حسابات العملاء.',
      )
    } finally {
      setLoading(false)
    }
  }

  async function loadStatement(customer: ReceivableCustomer | string) {
    const customerId =
      typeof customer === 'string' ? customer : customer.customer_id

    setLoadingStatement(true)
    setError('')
    setSuccess('')

    try {
      const response = await requestJson<ApiResponse<CustomerStatement>>(
        `/api/receivables/${encodeURIComponent(customerId)}`,
      )

      setStatement(response.data)

      const selected =
        typeof customer === 'string'
          ? customers.find((item) => item.customer_id === customerId) || null
          : customer

      setSelectedCustomer(selected)

      setAllowCreditSales(response.data.customer.allow_credit_sales)

      setCreditLimit(Number(response.data.customer.credit_limit))

      setPaymentTermsDays(response.data.customer.payment_terms_days)

      setSelectedSale(null)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل كشف حساب العميل.',
      )
    } finally {
      setLoadingStatement(false)
    }
  }

  async function saveCreditPolicy() {
    if (policyLock.current || !statement) {
      return
    }

    policyLock.current = true
    setSavingPolicy(true)
    setError('')
    setSuccess('')

    try {
      const numericLimit = Number(creditLimit)

      if (!Number.isFinite(numericLimit) || numericLimit < 0) {
        throw new Error('الحد الائتماني غير صالح.')
      }

      if (allowCreditSales && numericLimit <= 0) {
        throw new Error('حدد حدًا ائتمانيًا أكبر من صفر.')
      }

      await requestJson(
        `/api/receivables/${encodeURIComponent(
          statement.customer.id,
        )}/credit-policy`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            allowCreditSales,
            creditLimit: numericLimit,
            paymentTermsDays,
          }),
        },
      )

      setSuccess('تم تحديث السياسة الائتمانية للعميل.')

      await Promise.all([
        loadReceivables(),
        loadStatement(statement.customer.id),
      ])
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحديث السياسة الائتمانية.',
      )
    } finally {
      policyLock.current = false
      setSavingPolicy(false)
    }
  }

  function selectSaleForCollection(sale: ReceivableSale) {
    setSelectedSale(sale)

    setCollectionAmount(Number(sale.outstanding_total))

    setCollectionNumber(createCollectionNumber())

    setCollectionIdempotencyKey(createIdempotencyKey())

    setReferenceNumber('')
    setCollectionNote('')
    setError('')
    setSuccess('')
  }

  async function collectPayment() {
    if (collectionLock.current || !selectedSale || !statement) {
      return
    }

    collectionLock.current = true
    setSavingCollection(true)
    setError('')
    setSuccess('')

    try {
      const amount = Number(collectionAmount)

      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error('مبلغ التحصيل غير صالح.')
      }

      if (amount > Number(selectedSale.outstanding_total)) {
        throw new Error('مبلغ التحصيل أكبر من الرصيد المستحق.')
      }

      const response = await requestJson<
        ApiResponse<{
          sale: ReceivableSale
        }>
      >(
        `/api/receivables/sales/${encodeURIComponent(selectedSale.id)}/collect`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            collectionNumber,
            idempotencyKey: collectionIdempotencyKey,

            amount,
            paymentMethod,

            referenceNumber: referenceNumber.trim() || null,

            note: collectionNote.trim() || null,
          }),
        },
      )

      const updatedSale = response.data.sale

      setSuccess(
        `تم تسجيل التحصيل. المتبقي: ${formatMoney(
          updatedSale.outstanding_total,
        )}`,
      )

      setSelectedSale(null)
      setCollectionAmount('')
      setReferenceNumber('')
      setCollectionNote('')

      await Promise.all([
        loadReceivables(),
        loadStatement(statement.customer.id),
      ])
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تسجيل التحصيل.',
      )
    } finally {
      collectionLock.current = false
      setSavingCollection(false)
    }
  }

  useEffect(() => {
    void loadReceivables()
  }, [onlyOutstanding])

  return (
    <>
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>حسابات العملاء والتحصيلات</h2>

            <p className="muted">
              متابعة المبيعات الآجلة والأرصدة المستحقة وتسجيل التحصيلات.
            </p>
          </div>

          <button
            type="button"
            className="table-button"
            disabled={loading}
            onClick={() => void loadReceivables()}
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
            <span>عملاء عليهم رصيد</span>

            <strong>{summary.customers_with_balance}</strong>
          </article>

          <article className="mini-card">
            <span>إجمالي المستحق</span>

            <strong>{formatMoney(summary.total_outstanding)}</strong>
          </article>

          <article className="mini-card">
            <span>إجمالي المتأخر</span>

            <strong>{formatMoney(summary.total_overdue)}</strong>
          </article>

          <article className="mini-card">
            <span>عملاء متأخرون</span>

            <strong>{summary.overdue_customers}</strong>
          </article>
        </section>
      ) : null}

      <section className="panel">
        <div className="section-header">
          <h2>أرصدة العملاء</h2>

          <div className="section-actions">
            <input
              value={search}
              placeholder="اسم العميل أو الهاتف"
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void loadReceivables()
                }
              }}
            />

            <label>
              <input
                type="checkbox"
                checked={onlyOutstanding}
                onChange={(event) => setOnlyOutstanding(event.target.checked)}
              />
              الأرصدة المستحقة فقط
            </label>

            <button
              type="button"
              className="table-button"
              onClick={() => void loadReceivables()}
            >
              بحث
            </button>
          </div>
        </div>

        {customers.length === 0 ? (
          <p className="muted">لا توجد حسابات مطابقة.</p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>العميل</th>
                  <th>البيع الآجل</th>
                  <th>الحد الائتماني</th>
                  <th>المتاح</th>
                  <th>المستحق</th>
                  <th>المتأخر</th>
                  <th>الفواتير المفتوحة</th>
                  <th>أقدم استحقاق</th>
                  <th>الإجراء</th>
                </tr>
              </thead>

              <tbody>
                {customers.map((customer) => (
                  <tr key={customer.customer_id}>
                    <td>
                      <strong>{customer.customer_name}</strong>

                      <small className="stock-count-cell-note">
                        {customer.phone || 'بدون هاتف'}
                      </small>
                    </td>

                    <td>{customer.allow_credit_sales ? 'مفعل' : 'غير مفعل'}</td>

                    <td>{formatMoney(customer.credit_limit)}</td>

                    <td>{formatMoney(customer.credit_available)}</td>

                    <td>
                      <strong>{formatMoney(customer.outstanding_total)}</strong>
                    </td>

                    <td>{formatMoney(customer.overdue_total)}</td>

                    <td>{customer.open_sales_count}</td>

                    <td>{formatDate(customer.oldest_due_date)}</td>

                    <td>
                      <button
                        type="button"
                        className="table-button"
                        disabled={loadingStatement}
                        onClick={() => void loadStatement(customer)}
                      >
                        كشف الحساب
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {statement ? (
        <>
          <section className="panel">
            <div className="section-header">
              <div>
                <h2>كشف حساب — {statement.customer.name}</h2>

                <p className="muted">
                  المستحق: {formatMoney(statement.summary.outstanding_total)}
                  {' — '}
                  المتأخر: {formatMoney(statement.summary.overdue_total)}
                </p>
              </div>

              <button
                type="button"
                className="table-button"
                onClick={() => {
                  setStatement(null)
                  setSelectedCustomer(null)
                  setSelectedSale(null)
                }}
              >
                إغلاق
              </button>
            </div>
          </section>

          {canManageCredit ? (
            <section className="panel">
              <h2>السياسة الائتمانية</h2>

              <div className="form-grid">
                <label>
                  تفعيل البيع الآجل
                  <select
                    value={allowCreditSales ? 'enabled' : 'disabled'}
                    onChange={(event) =>
                      setAllowCreditSales(event.target.value === 'enabled')
                    }
                  >
                    <option value="enabled">مفعل</option>

                    <option value="disabled">غير مفعل</option>
                  </select>
                </label>

                <label>
                  الحد الائتماني
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={creditLimit}
                    onChange={(event) =>
                      setCreditLimit(
                        event.target.value === ''
                          ? ''
                          : Number(event.target.value),
                      )
                    }
                  />
                </label>

                <label>
                  مدة السداد بالأيام
                  <input
                    type="number"
                    min="0"
                    max="3650"
                    value={paymentTermsDays}
                    onChange={(event) =>
                      setPaymentTermsDays(Number(event.target.value))
                    }
                  />
                </label>
              </div>

              <button
                type="button"
                className="primary-button"
                disabled={savingPolicy}
                onClick={() => void saveCreditPolicy()}
              >
                {savingPolicy ? 'جاري الحفظ...' : 'حفظ السياسة الائتمانية'}
              </button>
            </section>
          ) : null}

          {selectedSale && canCollect ? (
            <section className="panel">
              <h2>تسجيل تحصيل — {selectedSale.sale_number}</h2>

              <p className="muted">
                الرصيد المستحق: {formatMoney(selectedSale.outstanding_total)}
              </p>

              <div className="form-grid">
                <label>
                  مبلغ التحصيل
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    max={Number(selectedSale.outstanding_total)}
                    value={collectionAmount}
                    onChange={(event) =>
                      setCollectionAmount(
                        event.target.value === ''
                          ? ''
                          : Number(event.target.value),
                      )
                    }
                  />
                </label>

                <label>
                  طريقة التحصيل
                  <select
                    value={paymentMethod}
                    onChange={(event) => setPaymentMethod(event.target.value)}
                  >
                    <option value="cash">نقدي</option>

                    <option value="card">بطاقة</option>

                    <option value="wallet">محفظة</option>

                    <option value="bank_transfer">تحويل بنكي</option>

                    <option value="other">أخرى</option>
                  </select>
                </label>

                <label>
                  رقم المرجع
                  <input
                    value={referenceNumber}
                    onChange={(event) => setReferenceNumber(event.target.value)}
                  />
                </label>

                <label>
                  ملاحظة
                  <input
                    value={collectionNote}
                    maxLength={500}
                    onChange={(event) => setCollectionNote(event.target.value)}
                  />
                </label>
              </div>

              <div className="section-actions">
                <button
                  type="button"
                  className="primary-button"
                  disabled={savingCollection}
                  onClick={() => void collectPayment()}
                >
                  {savingCollection ? 'جاري تسجيل التحصيل...' : 'تسجيل التحصيل'}
                </button>

                <button
                  type="button"
                  className="table-button"
                  disabled={savingCollection}
                  onClick={() => setSelectedSale(null)}
                >
                  إلغاء
                </button>
              </div>
            </section>
          ) : null}

          <section className="panel">
            <h2>فواتير العميل</h2>

            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>الفاتورة</th>
                    <th>الفرع</th>
                    <th>التاريخ</th>
                    <th>الاستحقاق</th>
                    <th>الإجمالي</th>
                    <th>المدفوع</th>
                    <th>المستحق</th>
                    <th>حالة الدفع</th>
                    <th>الإجراء</th>
                  </tr>
                </thead>

                <tbody>
                  {statement.sales.map((sale) => (
                    <tr key={sale.id}>
                      <td>{sale.sale_number}</td>

                      <td>{sale.branch_name}</td>

                      <td>{formatDateTime(sale.occurred_at)}</td>

                      <td>{formatDate(sale.due_date)}</td>

                      <td>{formatMoney(sale.total)}</td>

                      <td>
                        {formatMoney(
                          Number(sale.paid_total) - Number(sale.change_total),
                        )}
                      </td>

                      <td>
                        <strong>{formatMoney(sale.outstanding_total)}</strong>
                      </td>

                      <td>{translatePaymentStatus(sale.payment_status)}</td>

                      <td>
                        {canCollect && Number(sale.outstanding_total) > 0 ? (
                          <button
                            type="button"
                            className="table-button"
                            onClick={() => selectSaleForCollection(sale)}
                          >
                            تحصيل
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
          </section>

          <section className="panel">
            <h2>سجل التحصيلات</h2>

            {statement.collections.length === 0 ? (
              <p className="muted">لا توجد تحصيلات مسجلة.</p>
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>رقم التحصيل</th>
                      <th>الفاتورة</th>
                      <th>المبلغ</th>
                      <th>الطريقة</th>
                      <th>المرجع</th>
                      <th>المستخدم</th>
                      <th>التاريخ</th>
                    </tr>
                  </thead>

                  <tbody>
                    {statement.collections.map((collection) => (
                      <tr key={collection.id}>
                        <td>{collection.collection_number}</td>

                        <td>{collection.sale_number}</td>

                        <td>
                          <strong>{formatMoney(collection.amount)}</strong>
                        </td>

                        <td>
                          {translatePaymentMethod(collection.payment_method)}
                        </td>

                        <td>{collection.reference_number || '-'}</td>

                        <td>{collection.created_by_name || '-'}</td>

                        <td>{formatDateTime(collection.collected_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </>
  )
}

export default CustomerReceivablesPage
