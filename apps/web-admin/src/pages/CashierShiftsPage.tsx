import { useEffect, useMemo, useState } from 'react'

import { requestJson } from '../lib/http'

type ApiResponse<T> = {
  data: T
}

type CashierShift = {
  id: string

  branch_id: string
  branch_code: string
  branch_name: string

  cashier_id: string
  cashier_name: string
  cashier_username: string

  pos_device_id: string | null
  device_code: string | null
  device_name: string | null

  shift_number: string

  opening_cash: string

  closing_cash: string | null

  expected_cash: string | null

  difference: string | null

  net_sales_cash: string | null

  cash_returns: string | null

  net_exchange_cash: string | null

  sales_count: number | null

  voided_sales_count: number | null

  returns_count: number | null

  exchanges_count: number | null

  status: 'open' | 'closed'

  opened_at: string

  closed_at: string | null

  closed_by: string | null

  closed_by_name: string | null

  closing_note: string | null

  has_settlement_snapshot: boolean

  settlement_version: string | null

  settlement_snapshot?: {
    version?: number

    computedAt?: string

    cash?: {
      openingCash?: number
      netSalesCash?: number
      cashReturns?: number
      netExchangeCash?: number
      expectedCash?: number
      closingCash?: number
      difference?: number
    }

    documents?: {
      salesCount?: number
      voidedSalesCount?: number
      returnsCount?: number
      exchangesCount?: number
    }
  } | null
}

type ShiftSale = {
  id: string
  sale_number: string

  source: string

  customer_name: string | null

  total: string
  paid_total: string
  change_total: string

  cash_collected: string
  cash_refunded: string
  net_cash_effect: string

  status: string

  occurred_at: string
  voided_at: string | null
}

type ShiftReturn = {
  id: string
  return_number: string

  original_sale_number: string | null

  customer_name: string | null

  refund_total: string

  cash_refunded: string
  cash_collected: string
  net_cash_effect: string

  status: string
  created_at: string
}

type ShiftExchange = {
  id: string
  exchange_number: string

  original_sale_number: string | null

  customer_name: string | null

  returned_total: string
  issued_total: string
  difference_total: string

  net_cash_effect: string

  status: string
  created_at: string
}

type ShiftListResponse = {
  filters: {
    branchId: string | null

    cashierId: string | null

    status: string | null

    dateFrom: string | null

    dateTo: string | null
  }

  summary: {
    totalShifts: number
    openShifts: number
    closedShifts: number

    totalExpectedCash: string
    totalClosingCash: string
    totalDifference: string
  }

  shifts: CashierShift[]
}

type ShiftDetailsResponse = {
  shift: CashierShift

  settlement: {
    snapshot: CashierShift['settlement_snapshot'] | null

    isFinal: boolean

    version: number | null
  }

  documents: {
    sales: ShiftSale[]
    returns: ShiftReturn[]
    exchanges: ShiftExchange[]
  }
}

const moneyFormatter = new Intl.NumberFormat('ar-EG', {
  style: 'currency',
  currency: 'EGP',

  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})

const dateFormatter = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatMoney(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') {
    return '-'
  }

  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? moneyFormatter.format(numericValue)
    : '-'
}

function formatDate(value: string | null | undefined) {
  if (!value) {
    return '-'
  }

  const parsedDate = new Date(value)

  return Number.isNaN(parsedDate.getTime())
    ? '-'
    : dateFormatter.format(parsedDate)
}

function createTodayValue() {
  const now = new Date()

  const localDate = new Date(
    now.getTime() - now.getTimezoneOffset() * 60 * 1000,
  )

  return localDate.toISOString().slice(0, 10)
}

function createMonthStartValue() {
  const today = createTodayValue()

  return `${today.slice(0, 8)}01`
}

function translateShiftStatus(status: string) {
  if (status === 'open') {
    return 'مفتوحة'
  }

  if (status === 'closed') {
    return 'مغلقة'
  }

  return status
}

function translateDocumentStatus(status: string) {
  const labels: Record<string, string> = {
    completed: 'مكتمل',
    voided: 'ملغي',
    pending_review: 'تحتاج مراجعة',
    refunded: 'تم رد القيمة',
    draft: 'مسودة',
  }

  return labels[status] || status
}

function isSettledSaleStatus(status: string) {
  return ['completed', 'pending_review', 'refunded'].includes(status)
}

function isSettledReturnOrExchangeStatus(status: string) {
  return ['completed', 'pending_review'].includes(status)
}

function getStatusClass(status: string) {
  if (status === 'completed' || status === 'closed') {
    return 'status-badge ' + 'status-badge-success'
  }

  if (status === 'pending_review' || status === 'open') {
    return 'status-badge ' + 'status-badge-warning'
  }

  return 'status-badge'
}

function getDifferenceClass(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') {
    return 'stock-quantity'
  }

  const numericValue = Number(value)

  if (numericValue > 0) {
    return 'stock-quantity ' + 'stock-quantity-in'
  }

  if (numericValue < 0) {
    return 'stock-quantity ' + 'stock-quantity-out'
  }

  return 'stock-quantity'
}

function CashierShiftsPage() {
  const [status, setStatus] = useState('')

  const [dateFrom, setDateFrom] = useState(createMonthStartValue)

  const [dateTo, setDateTo] = useState(createTodayValue)

  const [search, setSearch] = useState('')

  const [report, setReport] = useState<ShiftListResponse | null>(null)

  const [selectedDetails, setSelectedDetails] =
    useState<ShiftDetailsResponse | null>(null)

  const [loadingList, setLoadingList] = useState(false)

  const [loadingShiftId, setLoadingShiftId] = useState<string | null>(null)

  const [error, setError] = useState('')

  const filteredShifts = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase()

    if (!report || !normalizedSearch) {
      return report?.shifts ?? []
    }

    return report.shifts.filter((shift) => {
      const searchText = [
        shift.shift_number,
        shift.cashier_name,
        shift.cashier_username,
        shift.branch_name,
        shift.branch_code,
        shift.device_name,
        shift.device_code,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()

      return searchText.includes(normalizedSearch)
    })
  }, [report, search])

  async function loadShifts() {
    setLoadingList(true)
    setError('')

    try {
      const parameters = new URLSearchParams()

      if (status) {
        parameters.set('status', status)
      }

      if (dateFrom) {
        parameters.set('dateFrom', dateFrom)
      }

      if (dateTo) {
        parameters.set('dateTo', dateTo)
      }

      parameters.set('limit', '100')

      const response = await requestJson<ApiResponse<ShiftListResponse>>(
        `/api/reports/cashier-shifts?${parameters.toString()}`,
      )

      setReport(response.data)

      if (
        selectedDetails &&
        !response.data.shifts.some(
          (shift) => shift.id === selectedDetails.shift.id,
        )
      ) {
        setSelectedDetails(null)
      }
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل سجل الورديات.',
      )
    } finally {
      setLoadingList(false)
    }
  }

  async function loadShiftDetails(shiftId: string) {
    if (loadingShiftId) {
      return
    }

    setLoadingShiftId(shiftId)

    setError('')

    try {
      const response = await requestJson<ApiResponse<ShiftDetailsResponse>>(
        `/api/reports/cashier-shifts/${encodeURIComponent(shiftId)}`,
      )

      setSelectedDetails(response.data)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل تفاصيل الوردية.',
      )
    } finally {
      setLoadingShiftId(null)
    }
  }

  useEffect(() => {
    void loadShifts()
  }, [])

  const summary = report?.summary

  const selectedShift = selectedDetails?.shift

  return (
    <>
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>تسوية الورديات</h2>

            <p className="muted">
              مراجعة النقدية المتوقعة والفعليّة والعجز أو الزيادة لكل كاشير.
            </p>
          </div>

          <button
            type="button"
            className="primary-button small-button"
            disabled={loadingList}
            onClick={() => void loadShifts()}
          >
            {loadingList ? 'جاري التحديث...' : 'تحديث التقرير'}
          </button>
        </div>

        <div className="form-grid">
          <label>
            حالة الوردية
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="">كل الحالات</option>

              <option value="open">مفتوحة</option>

              <option value="closed">مغلقة</option>
            </select>
          </label>

          <label>
            من تاريخ
            <input
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
            />
          </label>

          <label>
            إلى تاريخ
            <input
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
            />
          </label>

          <label>
            بحث داخل النتائج
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="رقم الوردية، الكاشير، الفرع أو الجهاز"
            />
          </label>
        </div>

        {error ? <p className="error-message">{error}</p> : null}
      </section>

      {summary ? (
        <section className="mini-cards-grid">
          <article className="mini-card">
            <span>إجمالي الورديات</span>

            <strong>{summary.totalShifts}</strong>
          </article>

          <article className="mini-card">
            <span>الورديات المفتوحة</span>

            <strong>{summary.openShifts}</strong>
          </article>

          <article className="mini-card">
            <span>الورديات المغلقة</span>

            <strong>{summary.closedShifts}</strong>
          </article>

          <article className="mini-card">
            <span>النقدية المتوقعة</span>

            <strong>{formatMoney(summary.totalExpectedCash)}</strong>
          </article>

          <article className="mini-card">
            <span>النقدية الفعلية</span>

            <strong>{formatMoney(summary.totalClosingCash)}</strong>
          </article>

          <article className="mini-card">
            <span>صافي الفروقات</span>

            <strong className={getDifferenceClass(summary.totalDifference)}>
              {formatMoney(summary.totalDifference)}
            </strong>
          </article>
        </section>
      ) : null}

      <section className="panel">
        <div className="section-header">
          <div>
            <h2>سجل الورديات</h2>

            <p className="muted">{filteredShifts.length} وردية مطابقة.</p>
          </div>
        </div>

        {loadingList && !report ? (
          <p className="muted">جاري تحميل الورديات...</p>
        ) : filteredShifts.length === 0 ? (
          <p className="muted">لا توجد ورديات مطابقة للفلاتر الحالية.</p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>رقم الوردية</th>
                  <th>الكاشير</th>
                  <th>الفرع</th>
                  <th>الجهاز</th>
                  <th>الحالة</th>
                  <th>الفتح</th>
                  <th>الإغلاق</th>
                  <th>المتوقع</th>
                  <th>الفعلي</th>
                  <th>الفرق</th>
                  <th>التفاصيل</th>
                </tr>
              </thead>

              <tbody>
                {filteredShifts.map((shift) => (
                  <tr key={shift.id}>
                    <td>
                      <strong>{shift.shift_number}</strong>
                    </td>

                    <td>
                      {shift.cashier_name}

                      <div className="muted">@{shift.cashier_username}</div>
                    </td>

                    <td>{shift.branch_name}</td>

                    <td>{shift.device_name || shift.device_code || '-'}</td>

                    <td>
                      <span className={getStatusClass(shift.status)}>
                        {translateShiftStatus(shift.status)}
                      </span>
                    </td>

                    <td>{formatDate(shift.opened_at)}</td>

                    <td>{formatDate(shift.closed_at)}</td>

                    <td>{formatMoney(shift.expected_cash)}</td>

                    <td>{formatMoney(shift.closing_cash)}</td>

                    <td>
                      <strong className={getDifferenceClass(shift.difference)}>
                        {formatMoney(shift.difference)}
                      </strong>
                    </td>

                    <td>
                      <button
                        type="button"
                        className="table-button"
                        disabled={loadingShiftId !== null}
                        onClick={() => void loadShiftDetails(shift.id)}
                      >
                        {loadingShiftId === shift.id
                          ? 'جاري التحميل...'
                          : 'عرض التسوية'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedDetails && selectedShift ? (
        <section className="panel">
          <div className="section-header">
            <div>
              <h2>تفاصيل الوردية {selectedShift.shift_number}</h2>

              <p className="muted">
                {selectedShift.cashier_name}
                {' — '}
                {selectedShift.branch_name}
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

          <div className="mini-cards-grid">
            <article className="mini-card">
              <span>رصيد البداية</span>

              <strong>{formatMoney(selectedShift.opening_cash)}</strong>
            </article>

            <article className="mini-card">
              <span>صافي المبيعات النقدية</span>

              <strong>{formatMoney(selectedShift.net_sales_cash)}</strong>
            </article>

            <article className="mini-card">
              <span>المرتجعات النقدية</span>

              <strong>{formatMoney(selectedShift.cash_returns)}</strong>
            </article>

            <article className="mini-card">
              <span>صافي الاستبدالات</span>

              <strong>{formatMoney(selectedShift.net_exchange_cash)}</strong>
            </article>

            <article className="mini-card">
              <span>النقدية المتوقعة</span>

              <strong>{formatMoney(selectedShift.expected_cash)}</strong>
            </article>

            <article className="mini-card">
              <span>النقدية الفعلية</span>

              <strong>{formatMoney(selectedShift.closing_cash)}</strong>
            </article>

            <article className="mini-card">
              <span>العجز أو الزيادة</span>

              <strong className={getDifferenceClass(selectedShift.difference)}>
                {formatMoney(selectedShift.difference)}
              </strong>
            </article>
          </div>

          <div className="mini-cards-grid">
            <article className="mini-card">
              <span>فواتير البيع</span>

              <strong>
                {selectedShift.sales_count ??
                  selectedDetails.documents.sales.filter((sale) =>
                    isSettledSaleStatus(sale.status),
                  ).length}
              </strong>
            </article>

            <article className="mini-card">
              <span>المبيعات الملغاة</span>

              <strong>
                {selectedShift.voided_sales_count ??
                  selectedDetails.documents.sales.filter(
                    (sale) => sale.status === 'voided',
                  ).length}
              </strong>
            </article>

            <article className="mini-card">
              <span>المرتجعات</span>

              <strong>
                {selectedShift.returns_count ??
                  selectedDetails.documents.returns.filter((returnDocument) =>
                    isSettledReturnOrExchangeStatus(returnDocument.status),
                  ).length}
              </strong>
            </article>

            <article className="mini-card">
              <span>الاستبدالات</span>

              <strong>
                {selectedShift.exchanges_count ??
                  selectedDetails.documents.exchanges.filter((exchange) =>
                    isSettledReturnOrExchangeStatus(exchange.status),
                  ).length}
              </strong>
            </article>
          </div>

          {selectedShift.status === 'open' ? (
            <p className="error-message">
              الوردية ما زالت مفتوحة؛ القيم الحالية غير نهائية وقد تتغير حتى
              الإغلاق.
            </p>
          ) : !selectedDetails.settlement.isFinal ? (
            <p className="error-message">
              هذه وردية تاريخية لا تحتوي على Snapshot تسوية نهائي.
            </p>
          ) : null}

          {selectedShift.closing_note ? (
            <p className="selected-customer">
              <strong>ملاحظة الإغلاق:</strong> {selectedShift.closing_note}
            </p>
          ) : null}

          <h3>فواتير البيع</h3>

          {selectedDetails.documents.sales.length === 0 ? (
            <p className="muted">لا توجد فواتير بيع مرتبطة بهذه الوردية.</p>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>رقم الفاتورة</th>
                    <th>العميل</th>
                    <th>الحالة</th>
                    <th>الإجمالي</th>
                    <th>الباقي</th>
                    <th>الأثر النقدي</th>
                    <th>التاريخ</th>
                  </tr>
                </thead>

                <tbody>
                  {selectedDetails.documents.sales.map((sale) => (
                    <tr key={sale.id}>
                      <td>{sale.sale_number}</td>

                      <td>{sale.customer_name || '-'}</td>

                      <td>
                        <span className={getStatusClass(sale.status)}>
                          {translateDocumentStatus(sale.status)}
                        </span>
                      </td>

                      <td>{formatMoney(sale.total)}</td>

                      <td>{formatMoney(sale.change_total)}</td>

                      <td>{formatMoney(sale.net_cash_effect)}</td>

                      <td>{formatDate(sale.occurred_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3>المرتجعات</h3>

          {selectedDetails.documents.returns.length === 0 ? (
            <p className="muted">لا توجد مرتجعات خلال الوردية.</p>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>رقم المرتجع</th>
                    <th>الفاتورة الأصلية</th>
                    <th>العميل</th>
                    <th>الحالة</th>
                    <th>القيمة</th>
                    <th>الأثر النقدي</th>
                    <th>التاريخ</th>
                  </tr>
                </thead>

                <tbody>
                  {selectedDetails.documents.returns.map((returnDocument) => (
                    <tr key={returnDocument.id}>
                      <td>{returnDocument.return_number}</td>

                      <td>{returnDocument.original_sale_number || '-'}</td>

                      <td>{returnDocument.customer_name || '-'}</td>

                      <td>
                        <span className={getStatusClass(returnDocument.status)}>
                          {translateDocumentStatus(returnDocument.status)}
                        </span>
                      </td>

                      <td>{formatMoney(returnDocument.refund_total)}</td>

                      <td>{formatMoney(returnDocument.net_cash_effect)}</td>

                      <td>{formatDate(returnDocument.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3>الاستبدالات</h3>

          {selectedDetails.documents.exchanges.length === 0 ? (
            <p className="muted">لا توجد استبدالات خلال الوردية.</p>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>رقم الاستبدال</th>
                    <th>الفاتورة الأصلية</th>
                    <th>العميل</th>
                    <th>الحالة</th>
                    <th>المرتجع</th>
                    <th>المصروف</th>
                    <th>الفرق</th>
                    <th>الأثر النقدي</th>
                    <th>التاريخ</th>
                  </tr>
                </thead>

                <tbody>
                  {selectedDetails.documents.exchanges.map((exchange) => (
                    <tr key={exchange.id}>
                      <td>{exchange.exchange_number}</td>

                      <td>{exchange.original_sale_number || '-'}</td>

                      <td>{exchange.customer_name || '-'}</td>

                      <td>
                        <span className={getStatusClass(exchange.status)}>
                          {translateDocumentStatus(exchange.status)}
                        </span>
                      </td>

                      <td>{formatMoney(exchange.returned_total)}</td>

                      <td>{formatMoney(exchange.issued_total)}</td>

                      <td>{formatMoney(exchange.difference_total)}</td>

                      <td>{formatMoney(exchange.net_cash_effect)}</td>

                      <td>{formatDate(exchange.created_at)}</td>
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

export default CashierShiftsPage
