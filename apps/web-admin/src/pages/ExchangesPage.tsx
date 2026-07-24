import { useEffect, useMemo, useState } from 'react'

import { requestJson } from '../lib/http'

type ExchangeSummary = {
  id: string
  exchange_number: string

  original_sale_id: string | null

  original_sale_number: string | null

  branch_id: string
  branch_name: string

  stock_location_id: string
  stock_location_name: string

  customer_id: string | null

  customer_name: string | null

  returned_total: string
  issued_total: string
  difference_total: string

  paid_difference_total: string
  refunded_difference_total: string

  status: string
  reason: string | null

  return_items_count: number
  issue_items_count: number

  created_at: string
}

type ExchangeDocument = ExchangeSummary & {
  source: string
  idempotency_key: string

  created_by: string | null

  created_by_name: string | null

  synced_at: string | null
}

type ExchangeReturnItem = {
  id: string
  original_sale_item_id: string
  variant_id: string

  sku_snapshot: string

  barcode_snapshot: string | null

  product_name_snapshot: string

  size_snapshot: string | null

  color_snapshot: string | null

  quantity: string
  unit_price: string
  line_total: string

  created_at: string
}

type ExchangeIssueItem = {
  id: string
  variant_id: string

  sku_snapshot: string

  barcode_snapshot: string | null

  product_name_snapshot: string

  size_snapshot: string | null

  color_snapshot: string | null

  quantity: string
  unit_price: string
  discount_amount: string
  line_total: string

  created_at: string
}

type ExchangePayment = {
  id: string

  payment_direction: 'paid_by_customer' | 'refunded_to_customer'

  method: string
  amount: string

  reference: string | null

  created_at: string
}

type ExchangeStockMovement = {
  id: string
  variant_id: string

  sku: string

  primary_barcode: string | null

  product_name: string

  size_name: string | null

  color_name: string | null

  stock_location_name: string

  movement_type: string

  quantity: string
  quantity_before: string
  quantity_after: string

  reference_type: string | null

  reference_id: string | null

  note: string | null

  created_at: string
}

type ExchangeDetails = {
  exchange: ExchangeDocument

  returnItems: ExchangeReturnItem[]

  issueItems: ExchangeIssueItem[]

  payments: ExchangePayment[]

  stockMovements: ExchangeStockMovement[]
}

type ApiResponse<T> = {
  data: T
}

type ExchangesPageProps = {
  companyId: string
  branchId: string

  onOpenSale: (saleId: string) => void
}

const exchangeCurrencyFormatter = new Intl.NumberFormat('ar-EG', {
  style: 'currency',
  currency: 'EGP',

  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})

const exchangeQuantityFormatter = new Intl.NumberFormat('ar-EG', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
})

const exchangeDateFormatter = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatCurrency(value: number | string) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? exchangeCurrencyFormatter.format(numericValue)
    : '-'
}

function formatQuantity(value: number | string) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? exchangeQuantityFormatter.format(numericValue)
    : '-'
}

function formatDate(value: string) {
  const parsedDate = new Date(value)

  return Number.isNaN(parsedDate.getTime())
    ? '-'
    : exchangeDateFormatter.format(parsedDate)
}

function translateExchangeStatus(status: string) {
  const labels: Record<string, string> = {
    draft: 'مسودة',
    completed: 'مكتمل',
    voided: 'ملغي',
    pending_review: 'بانتظار المراجعة',
  }

  return labels[status] || status
}

function getExchangeStatusClass(status: string) {
  if (status === 'completed') {
    return 'status-badge ' + 'status-badge-success'
  }

  if (status === 'voided') {
    return 'status-badge ' + 'status-badge-danger'
  }

  if (status === 'draft' || status === 'pending_review') {
    return 'status-badge ' + 'status-badge-warning'
  }

  return 'status-badge'
}

function translatePaymentMethod(method: string) {
  const labels: Record<string, string> = {
    cash: 'نقدي',
    card: 'بطاقة بنكية',
    wallet: 'محفظة إلكترونية',

    bank_transfer: 'تحويل بنكي',

    other: 'أخرى',
  }

  return labels[method] || method
}

function translatePaymentDirection(direction: string) {
  if (direction === 'paid_by_customer') {
    return 'دفعه العميل'
  }

  if (direction === 'refunded_to_customer') {
    return 'تم رده للعميل'
  }

  return direction
}

function getDifferenceLabel(difference: number | string) {
  const numericDifference = Number(difference)

  if (numericDifference > 0) {
    return 'يدفع العميل'
  }

  if (numericDifference < 0) {
    return 'يُرد للعميل'
  }

  return 'لا يوجد فرق'
}

function getMovementClass(quantity: number | string) {
  const numericQuantity = Number(quantity)

  if (numericQuantity > 0) {
    return 'movement-badge ' + 'movement-badge-in'
  }

  if (numericQuantity < 0) {
    return 'movement-badge ' + 'movement-badge-out'
  }

  return 'movement-badge'
}

function ExchangesPage({
  companyId,
  branchId,
  onOpenSale,
}: ExchangesPageProps) {
  const [exchanges, setExchanges] = useState<ExchangeSummary[]>([])

  const [selectedDetails, setSelectedDetails] =
    useState<ExchangeDetails | null>(null)

  const [searchText, setSearchText] = useState('')

  const [statusFilter, setStatusFilter] = useState('')

  const [loading, setLoading] = useState(false)

  const [loadingDetails, setLoadingDetails] = useState(false)

  const [error, setError] = useState('')

  const filteredExchanges = useMemo(() => {
    const searchValue = searchText.trim().toLowerCase()

    if (!searchValue) {
      return exchanges
    }

    return exchanges.filter((exchange) => {
      const values = [
        exchange.exchange_number,

        exchange.original_sale_number,

        exchange.customer_name,

        exchange.branch_name,

        exchange.stock_location_name,
      ]

      return values.some((value) =>
        (value || '').toLowerCase().includes(searchValue),
      )
    })
  }, [exchanges, searchText])

  async function loadExchanges() {
    setLoading(true)
    setError('')

    try {
      if (!companyId.trim()) {
        throw new Error('بيانات الشركة غير مكتملة.')
      }

      const selectedBranchId = branchId.trim()

      const requestUrl =
        `/api/exchanges?limit=100` +
        (selectedBranchId
          ? `&branchId=${encodeURIComponent(selectedBranchId)}`
          : '') +
        (statusFilter ? `&status=${encodeURIComponent(statusFilter)}` : '')

      const response =
        await requestJson<ApiResponse<ExchangeSummary[]>>(requestUrl)

      setExchanges(response.data)

      if (selectedDetails) {
        const stillExists = response.data.some(
          (exchange) => exchange.id === selectedDetails.exchange.id,
        )

        if (!stillExists) {
          setSelectedDetails(null)
        }
      }
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل سجل الاستبدالات.',
      )
    } finally {
      setLoading(false)
    }
  }

  async function loadExchangeDetails(exchangeId: string) {
    setLoadingDetails(true)
    setError('')

    try {
      const response = await requestJson<ApiResponse<ExchangeDetails>>(
        `/api/exchanges/${encodeURIComponent(exchangeId)}`,
      )

      setSelectedDetails(response.data)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل تفاصيل الاستبدال.',
      )
    } finally {
      setLoadingDetails(false)
    }
  }

  useEffect(() => {
    if (!companyId.trim()) {
      return
    }

    void loadExchanges()
  }, [companyId, branchId, statusFilter])

  return (
    <>
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>سجل الاستبدالات</h2>

            <p className="muted">
              متابعة عمليات الاستبدال والأصناف والمدفوعات وحركات المخزون.
            </p>
          </div>

          <div className="section-actions">
            <span className="record-count-badge">
              {filteredExchanges.length} عملية
            </span>

            <button
              type="button"
              className="primary-button small-button"
              disabled={loading}
              onClick={() => void loadExchanges()}
            >
              {loading ? 'جاري التحديث...' : 'تحديث البيانات'}
            </button>
          </div>
        </div>

        <div className="form-grid">
          <label className="form-field">
            <span>البحث</span>

            <input
              type="search"
              value={searchText}
              placeholder="رقم الاستبدال، الفاتورة أو العميل"
              onChange={(event) => setSearchText(event.target.value)}
            />
          </label>

          <label className="form-field">
            <span>الحالة</span>

            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">كل الحالات</option>

              <option value="completed">مكتمل</option>

              <option value="pending_review">بانتظار المراجعة</option>

              <option value="draft">مسودة</option>

              <option value="voided">ملغي</option>
            </select>
          </label>
        </div>

        {error ? <p className="error-message">{error}</p> : null}

        {filteredExchanges.length === 0 ? (
          <p className="muted">
            {loading
              ? 'جاري تحميل الاستبدالات...'
              : 'لا توجد عمليات استبدال مطابقة.'}
          </p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>رقم الاستبدال</th>

                  <th>التاريخ</th>

                  <th>الفاتورة الأصلية</th>

                  <th>العميل</th>

                  <th>الفرع</th>

                  <th>قيمة المرتجع</th>

                  <th>قيمة البديل</th>

                  <th>الفرق</th>

                  <th>اتجاه الفرق</th>

                  <th>الأصناف</th>

                  <th>الحالة</th>

                  <th>الإجراءات</th>
                </tr>
              </thead>

              <tbody>
                {filteredExchanges.map((exchange) => (
                  <tr key={exchange.id}>
                    <td>
                      <strong className="document-number">
                        {exchange.exchange_number}
                      </strong>
                    </td>

                    <td>{formatDate(exchange.created_at)}</td>

                    <td>{exchange.original_sale_number || '-'}</td>

                    <td>{exchange.customer_name || 'بيع عام'}</td>

                    <td>{exchange.branch_name}</td>

                    <td className="money-cell">
                      {formatCurrency(exchange.returned_total)}
                    </td>

                    <td className="money-cell">
                      {formatCurrency(exchange.issued_total)}
                    </td>

                    <td className="money-cell">
                      {formatCurrency(exchange.difference_total)}
                    </td>

                    <td>{getDifferenceLabel(exchange.difference_total)}</td>

                    <td>
                      {exchange.return_items_count}
                      {' مرتجع / '}

                      {exchange.issue_items_count}
                      {' بديل'}
                    </td>

                    <td>
                      <span className={getExchangeStatusClass(exchange.status)}>
                        {translateExchangeStatus(exchange.status)}
                      </span>
                    </td>

                    <td>
                      <div className="section-actions">
                        <button
                          type="button"
                          className="table-button"
                          disabled={loadingDetails}
                          onClick={() => void loadExchangeDetails(exchange.id)}
                        >
                          عرض التفاصيل
                        </button>

                        {exchange.original_sale_id ? (
                          <button
                            type="button"
                            className="table-button"
                            onClick={() =>
                              onOpenSale(exchange.original_sale_id as string)
                            }
                          >
                            فتح الفاتورة
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedDetails ? (
        <section className="panel">
          <div className="section-header">
            <div>
              <h2>تفاصيل الاستبدال</h2>

              <p className="muted">
                {selectedDetails.exchange.exchange_number}

                {' • '}

                {formatDate(selectedDetails.exchange.created_at)}

                {' • '}

                {selectedDetails.exchange.created_by_name || 'مستخدم غير محدد'}
              </p>
            </div>

            <button
              type="button"
              className="table-button"
              onClick={() => setSelectedDetails(null)}
            >
              إغلاق التفاصيل
            </button>
          </div>

          <section className="mini-cards-grid">
            <article className="mini-card">
              <span>قيمة المرتجع</span>

              <strong>
                {formatCurrency(selectedDetails.exchange.returned_total)}
              </strong>
            </article>

            <article className="mini-card">
              <span>قيمة البديل</span>

              <strong>
                {formatCurrency(selectedDetails.exchange.issued_total)}
              </strong>
            </article>

            <article className="mini-card">
              <span>فرق الاستبدال</span>

              <strong>
                {formatCurrency(selectedDetails.exchange.difference_total)}
              </strong>
            </article>

            <article className="mini-card">
              <span>المدفوع من العميل</span>

              <strong>
                {formatCurrency(selectedDetails.exchange.paid_difference_total)}
              </strong>
            </article>

            <article className="mini-card">
              <span>المردود للعميل</span>

              <strong>
                {formatCurrency(
                  selectedDetails.exchange.refunded_difference_total,
                )}
              </strong>
            </article>

            <article className="mini-card">
              <span>الحالة</span>

              <div className="mini-card-status">
                <span
                  className={getExchangeStatusClass(
                    selectedDetails.exchange.status,
                  )}
                >
                  {translateExchangeStatus(selectedDetails.exchange.status)}
                </span>
              </div>
            </article>
          </section>

          <section className="mini-cards-grid">
            <article className="mini-card">
              <span>الفاتورة الأصلية</span>

              <strong>
                {selectedDetails.exchange.original_sale_number || '-'}
              </strong>
            </article>

            <article className="mini-card">
              <span>العميل</span>

              <strong>
                {selectedDetails.exchange.customer_name || 'بيع عام'}
              </strong>
            </article>

            <article className="mini-card">
              <span>الفرع</span>

              <strong>{selectedDetails.exchange.branch_name}</strong>
            </article>

            <article className="mini-card">
              <span>مكان التخزين</span>

              <strong>{selectedDetails.exchange.stock_location_name}</strong>
            </article>

            <article className="mini-card">
              <span>المصدر</span>

              <strong>
                {selectedDetails.exchange.source === 'web_admin'
                  ? 'لوحة الإدارة'
                  : selectedDetails.exchange.source}
              </strong>
            </article>

            <article className="mini-card">
              <span>سبب الاستبدال</span>

              <strong>{selectedDetails.exchange.reason || '-'}</strong>
            </article>
          </section>

          <h3>الأصناف المرتجعة</h3>

          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>الصنف</th>
                  <th>SKU</th>
                  <th>Barcode</th>
                  <th>المقاس</th>
                  <th>اللون</th>
                  <th>الكمية</th>
                  <th>السعر الأصلي</th>
                  <th>القيمة</th>
                </tr>
              </thead>

              <tbody>
                {selectedDetails.returnItems.map((item) => (
                  <tr key={item.id}>
                    <td>{item.product_name_snapshot}</td>

                    <td>{item.sku_snapshot}</td>

                    <td>{item.barcode_snapshot || '-'}</td>

                    <td>{item.size_snapshot || '-'}</td>

                    <td>{item.color_snapshot || '-'}</td>

                    <td>{formatQuantity(item.quantity)}</td>

                    <td className="money-cell">
                      {formatCurrency(item.unit_price)}
                    </td>

                    <td className="money-cell">
                      {formatCurrency(item.line_total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>الأصناف البديلة</h3>

          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>الصنف</th>
                  <th>SKU</th>
                  <th>Barcode</th>
                  <th>المقاس</th>
                  <th>اللون</th>
                  <th>الكمية</th>
                  <th>السعر</th>
                  <th>الخصم</th>
                  <th>القيمة</th>
                </tr>
              </thead>

              <tbody>
                {selectedDetails.issueItems.map((item) => (
                  <tr key={item.id}>
                    <td>{item.product_name_snapshot}</td>

                    <td>{item.sku_snapshot}</td>

                    <td>{item.barcode_snapshot || '-'}</td>

                    <td>{item.size_snapshot || '-'}</td>

                    <td>{item.color_snapshot || '-'}</td>

                    <td>{formatQuantity(item.quantity)}</td>

                    <td className="money-cell">
                      {formatCurrency(item.unit_price)}
                    </td>

                    <td className="money-cell">
                      {formatCurrency(item.discount_amount)}
                    </td>

                    <td className="money-cell">
                      {formatCurrency(item.line_total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>تسوية فرق الاستبدال</h3>

          {selectedDetails.payments.length === 0 ? (
            <p className="muted">
              لم توجد عملية دفع أو رد، لأن قيمة الأصناف كانت متساوية.
            </p>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>الاتجاه</th>
                    <th>الطريقة</th>
                    <th>المبلغ</th>
                    <th>المرجع</th>
                    <th>التاريخ</th>
                  </tr>
                </thead>

                <tbody>
                  {selectedDetails.payments.map((payment) => (
                    <tr key={payment.id}>
                      <td>
                        {translatePaymentDirection(payment.payment_direction)}
                      </td>

                      <td>
                        <span className="payment-method-badge">
                          {translatePaymentMethod(payment.method)}
                        </span>
                      </td>

                      <td className="money-cell">
                        {formatCurrency(payment.amount)}
                      </td>

                      <td>{payment.reference || '-'}</td>

                      <td>{formatDate(payment.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3>حركات المخزون</h3>

          {selectedDetails.stockMovements.length === 0 ? (
            <p className="muted">لا توجد حركات مخزون مرتبطة بهذه العملية.</p>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>الصنف</th>
                    <th>SKU</th>
                    <th>المقاس</th>
                    <th>اللون</th>
                    <th>قبل</th>
                    <th>الحركة</th>
                    <th>بعد</th>
                    <th>مكان التخزين</th>
                    <th>التاريخ</th>
                  </tr>
                </thead>

                <tbody>
                  {selectedDetails.stockMovements.map((movement) => (
                    <tr key={movement.id}>
                      <td>{movement.product_name}</td>

                      <td>{movement.sku}</td>

                      <td>{movement.size_name || '-'}</td>

                      <td>{movement.color_name || '-'}</td>

                      <td>{formatQuantity(movement.quantity_before)}</td>

                      <td>
                        <span className={getMovementClass(movement.quantity)}>
                          {formatQuantity(movement.quantity)}
                        </span>
                      </td>

                      <td>{formatQuantity(movement.quantity_after)}</td>

                      <td>{movement.stock_location_name}</td>

                      <td>{formatDate(movement.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </>
  )
}

export default ExchangesPage
