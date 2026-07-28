import { useEffect, useMemo, useState } from 'react'

import { requestJson } from '../lib/http'

type ApiResponse<T> = {
  data: T
}

type PerformanceMetrics = {
  salesCount: number
  voidedSalesCount: number
  pendingReviewSalesCount: number

  grossSales: string
  soldQuantity: string

  returnsCount: number
  returnRefunds: string
  returnedQuantity: string

  exchangesCount: number
  exchangeReturnedTotal: string
  exchangeIssuedTotal: string
  exchangeNet: string

  exchangeReturnedQuantity: string
  exchangeIssuedQuantity: string

  netRevenue: string
  averageSaleValue: string
}

type DailyPerformance = PerformanceMetrics & {
  date: string
}

type BranchPerformance = PerformanceMetrics & {
  branchId: string

  branchCode: string | null

  branchName: string
}

type CashierPerformance = PerformanceMetrics & {
  cashierId: string | null

  cashierName: string

  cashierUsername: string | null
}

type SalesPerformanceReport = {
  filters: {
    companyId: string

    branchId: string | null

    cashierId: string | null

    dateFrom: string
    dateTo: string
    days: number
  }

  definitions: {
    activeSaleStatuses: string[]
    activeReturnStatuses: string[]
    activeExchangeStatuses: string[]

    netRevenueFormula: string
  }

  summary: PerformanceMetrics

  byDay: DailyPerformance[]
  byBranch: BranchPerformance[]
  byCashier: CashierPerformance[]
}

const moneyFormatter = new Intl.NumberFormat('ar-EG', {
  style: 'currency',
  currency: 'EGP',

  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})

const quantityFormatter = new Intl.NumberFormat('ar-EG', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
})

const dayFormatter = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'medium',
  timeZone: 'UTC',
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

function formatQuantity(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') {
    return '-'
  }

  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? quantityFormatter.format(numericValue)
    : '-'
}

function formatDay(value: string) {
  const parsedDate = new Date(`${value}T00:00:00.000Z`)

  return Number.isNaN(parsedDate.getTime())
    ? value
    : dayFormatter.format(parsedDate)
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

function getMetricClass(value: string | number) {
  const numericValue = Number(value)

  if (numericValue > 0) {
    return 'report-value-positive'
  }

  if (numericValue < 0) {
    return 'report-value-negative'
  }

  return ''
}

function SalesPerformancePage() {
  const [dateFrom, setDateFrom] = useState(createMonthStartValue)

  const [dateTo, setDateTo] = useState(createTodayValue)

  const [branchId, setBranchId] = useState('')

  const [cashierId, setCashierId] = useState('')

  const [report, setReport] = useState<SalesPerformanceReport | null>(null)

  const [branchOptions, setBranchOptions] = useState<BranchPerformance[]>([])

  const [cashierOptions, setCashierOptions] = useState<CashierPerformance[]>([])

  const [loading, setLoading] = useState(false)

  const [error, setError] = useState('')

  const maxDailyGross = useMemo(() => {
    if (!report) {
      return 1
    }

    const maximum = Math.max(
      ...report.byDay.map((day) => Math.max(Number(day.grossSales) || 0, 0)),
      0,
    )

    return maximum > 0 ? maximum : 1
  }, [report])

  function buildReportUrl(selectedBranchId = '', selectedCashierId = '') {
    const parameters = new URLSearchParams({
      dateFrom,
      dateTo,
    })

    if (selectedBranchId) {
      parameters.set('branchId', selectedBranchId)
    }

    if (selectedCashierId) {
      parameters.set('cashierId', selectedCashierId)
    }

    return '/api/reports/' + 'sales-performance?' + parameters.toString()
  }

  async function loadReport() {
    if (!dateFrom || !dateTo) {
      setError('يجب تحديد تاريخ البداية والنهاية.')

      return
    }

    if (dateFrom > dateTo) {
      setError('تاريخ البداية لا يمكن أن يكون بعد تاريخ النهاية.')

      return
    }

    setLoading(true)
    setError('')

    try {
      // الطلب غير المفلتر يوفر خيارات
      // الفروع والكاشير المتاحة للفترة.
      const optionsResponse =
        await requestJson<ApiResponse<SalesPerformanceReport>>(buildReportUrl())

      setBranchOptions(optionsResponse.data.byBranch)

      setCashierOptions(optionsResponse.data.byCashier)

      if (!branchId && !cashierId) {
        setReport(optionsResponse.data)

        return
      }

      const filteredResponse = await requestJson<
        ApiResponse<SalesPerformanceReport>
      >(buildReportUrl(branchId, cashierId))

      setReport(filteredResponse.data)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل تقرير المبيعات.',
      )
    } finally {
      setLoading(false)
    }
  }

  function clearFilters() {
    setBranchId('')
    setCashierId('')
  }

  useEffect(() => {
    void loadReport()
  }, [])

  const summary = report?.summary

  return (
    <>
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>تقارير أداء المبيعات</h2>

            <p className="muted">
              تحليل المبيعات والمرتجعات والاستبدالات حسب الفترة والفرع والكاشير.
            </p>
          </div>

          <button
            type="button"
            className="primary-button small-button"
            disabled={loading}
            onClick={() => void loadReport()}
          >
            {loading ? 'جاري إعداد التقرير...' : 'تحديث التقرير'}
          </button>
        </div>

        <div className="form-grid report-filter-grid">
          <label>
            من تاريخ
            <input
              type="date"
              value={dateFrom}
              disabled={loading}
              onChange={(event) => setDateFrom(event.target.value)}
            />
          </label>

          <label>
            إلى تاريخ
            <input
              type="date"
              value={dateTo}
              disabled={loading}
              onChange={(event) => setDateTo(event.target.value)}
            />
          </label>

          <label>
            الفرع
            <select
              value={branchId}
              disabled={loading}
              onChange={(event) => setBranchId(event.target.value)}
            >
              <option value="">كل الفروع</option>

              {branchOptions.map((branch) => (
                <option key={branch.branchId} value={branch.branchId}>
                  {branch.branchName}
                  {branch.branchCode ? ` — ${branch.branchCode}` : ''}
                </option>
              ))}
            </select>
          </label>

          <label>
            الكاشير
            <select
              value={cashierId}
              disabled={loading}
              onChange={(event) => setCashierId(event.target.value)}
            >
              <option value="">كل الكاشير</option>

              {cashierOptions
                .filter((cashier) => cashier.cashierId)
                .map((cashier) => (
                  <option
                    key={cashier.cashierId ?? cashier.cashierName}
                    value={cashier.cashierId ?? ''}
                  >
                    {cashier.cashierName}
                    {cashier.cashierUsername
                      ? ` — @${cashier.cashierUsername}`
                      : ''}
                  </option>
                ))}
            </select>
          </label>
        </div>

        <div className="report-filter-actions">
          <button
            type="button"
            className="table-button"
            disabled={loading || (!branchId && !cashierId)}
            onClick={clearFilters}
          >
            مسح فلتر الفرع والكاشير
          </button>

          {report ? (
            <span className="muted">الفترة: {report.filters.days} يوم</span>
          ) : null}
        </div>

        {error ? <p className="error-message">{error}</p> : null}

        {loading && !report ? (
          <p className="muted">جاري تحميل التقرير...</p>
        ) : null}
      </section>

      {summary ? (
        <section className="mini-cards-grid report-summary-grid">
          <article className="mini-card">
            <span>إجمالي المبيعات</span>

            <strong>{formatMoney(summary.grossSales)}</strong>
          </article>

          <article className="mini-card">
            <span>صافي الإيراد</span>

            <strong className={getMetricClass(summary.netRevenue)}>
              {formatMoney(summary.netRevenue)}
            </strong>
          </article>

          <article className="mini-card">
            <span>عدد الفواتير</span>

            <strong>{summary.salesCount}</strong>
          </article>

          <article className="mini-card">
            <span>متوسط الفاتورة</span>

            <strong>{formatMoney(summary.averageSaleValue)}</strong>
          </article>

          <article className="mini-card">
            <span>الكمية المباعة</span>

            <strong>{formatQuantity(summary.soldQuantity)}</strong>
          </article>

          <article className="mini-card">
            <span>قيمة المرتجعات</span>

            <strong>{formatMoney(summary.returnRefunds)}</strong>

            <small className="muted">{summary.returnsCount} مستند</small>
          </article>

          <article className="mini-card">
            <span>صافي الاستبدالات</span>

            <strong className={getMetricClass(summary.exchangeNet)}>
              {formatMoney(summary.exchangeNet)}
            </strong>

            <small className="muted">{summary.exchangesCount} مستند</small>
          </article>

          <article className="mini-card">
            <span>تحتاج مراجعة</span>

            <strong>{summary.pendingReviewSalesCount}</strong>

            <small className="muted">ملغاة: {summary.voidedSalesCount}</small>
          </article>
        </section>
      ) : null}

      {report ? (
        <section className="panel">
          <div className="section-header">
            <div>
              <h2>الأداء اليومي</h2>

              <p className="muted">
                الأيام التي تحتوي على حركة داخل الفترة المحددة.
              </p>
            </div>
          </div>

          {report.byDay.length === 0 ? (
            <p className="muted">لا توجد حركات مالية في الفترة الحالية.</p>
          ) : (
            <div className="report-chart">
              {report.byDay.map((day) => {
                const grossValue = Math.max(Number(day.grossSales) || 0, 0)

                const barWidth =
                  grossValue === 0
                    ? 0
                    : Math.max((grossValue / maxDailyGross) * 100, 2)

                return (
                  <div key={day.date} className="report-bar-row">
                    <div className="report-bar-label">
                      {formatDay(day.date)}
                    </div>

                    <div className="report-bar-track">
                      <div
                        className="report-bar-fill"
                        style={{
                          width: `${barWidth}%`,
                        }}
                      />
                    </div>

                    <div className="report-bar-values">
                      <strong>{formatMoney(day.grossSales)}</strong>

                      <span className={getMetricClass(day.netRevenue)}>
                        صافي: {formatMoney(day.netRevenue)}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      ) : null}

      {report && report.byDay.length > 0 ? (
        <section className="panel">
          <h2>تفاصيل الأيام</h2>

          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>التاريخ</th>
                  <th>الفواتير</th>
                  <th>المبيعات</th>
                  <th>المرتجعات</th>
                  <th>الاستبدالات</th>
                  <th>صافي الإيراد</th>
                  <th>متوسط الفاتورة</th>
                  <th>القطع المباعة</th>
                </tr>
              </thead>

              <tbody>
                {report.byDay.map((day) => (
                  <tr key={day.date}>
                    <td>{formatDay(day.date)}</td>

                    <td>{day.salesCount}</td>

                    <td>{formatMoney(day.grossSales)}</td>

                    <td>{formatMoney(day.returnRefunds)}</td>

                    <td className={getMetricClass(day.exchangeNet)}>
                      {formatMoney(day.exchangeNet)}
                    </td>

                    <td>
                      <strong className={getMetricClass(day.netRevenue)}>
                        {formatMoney(day.netRevenue)}
                      </strong>
                    </td>

                    <td>{formatMoney(day.averageSaleValue)}</td>

                    <td>{formatQuantity(day.soldQuantity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {report ? (
        <section className="panel">
          <div className="section-header">
            <div>
              <h2>الأداء حسب الفرع</h2>

              <p className="muted">
                مقارنة إجمالي المبيعات وصافي الإيراد بين الفروع.
              </p>
            </div>
          </div>

          {report.byBranch.length === 0 ? (
            <p className="muted">لا توجد بيانات فروع في الفترة الحالية.</p>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>الفرع</th>
                    <th>الفواتير</th>
                    <th>المبيعات</th>
                    <th>المرتجعات</th>
                    <th>صافي الاستبدالات</th>
                    <th>صافي الإيراد</th>
                    <th>متوسط الفاتورة</th>
                    <th>القطع</th>
                  </tr>
                </thead>

                <tbody>
                  {report.byBranch.map((branch) => (
                    <tr key={branch.branchId}>
                      <td>
                        <strong>{branch.branchName}</strong>

                        {branch.branchCode ? (
                          <div className="muted">{branch.branchCode}</div>
                        ) : null}
                      </td>

                      <td>{branch.salesCount}</td>

                      <td>{formatMoney(branch.grossSales)}</td>

                      <td>{formatMoney(branch.returnRefunds)}</td>

                      <td className={getMetricClass(branch.exchangeNet)}>
                        {formatMoney(branch.exchangeNet)}
                      </td>

                      <td>
                        <strong className={getMetricClass(branch.netRevenue)}>
                          {formatMoney(branch.netRevenue)}
                        </strong>
                      </td>

                      <td>{formatMoney(branch.averageSaleValue)}</td>

                      <td>{formatQuantity(branch.soldQuantity)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {report ? (
        <section className="panel">
          <div className="section-header">
            <div>
              <h2>الأداء حسب الكاشير</h2>

              <p className="muted">
                مقارنة نشاط المستخدمين الذين نفذوا عمليات البيع والمرتجعات
                والاستبدالات.
              </p>
            </div>
          </div>

          {report.byCashier.length === 0 ? (
            <p className="muted">لا توجد بيانات كاشير في الفترة الحالية.</p>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>الكاشير</th>
                    <th>الفواتير</th>
                    <th>ملغاة</th>
                    <th>تحتاج مراجعة</th>
                    <th>المبيعات</th>
                    <th>المرتجعات</th>
                    <th>صافي الاستبدالات</th>
                    <th>صافي الإيراد</th>
                    <th>متوسط الفاتورة</th>
                  </tr>
                </thead>

                <tbody>
                  {report.byCashier.map((cashier) => (
                    <tr key={cashier.cashierId ?? cashier.cashierName}>
                      <td>
                        <strong>{cashier.cashierName}</strong>

                        {cashier.cashierUsername ? (
                          <div className="muted">
                            @{cashier.cashierUsername}
                          </div>
                        ) : null}
                      </td>

                      <td>{cashier.salesCount}</td>

                      <td>{cashier.voidedSalesCount}</td>

                      <td>{cashier.pendingReviewSalesCount}</td>

                      <td>{formatMoney(cashier.grossSales)}</td>

                      <td>{formatMoney(cashier.returnRefunds)}</td>

                      <td className={getMetricClass(cashier.exchangeNet)}>
                        {formatMoney(cashier.exchangeNet)}
                      </td>

                      <td>
                        <strong className={getMetricClass(cashier.netRevenue)}>
                          {formatMoney(cashier.netRevenue)}
                        </strong>
                      </td>

                      <td>{formatMoney(cashier.averageSaleValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {report ? (
        <section className="panel">
          <h2>تعريف صافي الإيراد</h2>

          <p className="selected-customer">
            صافي الإيراد = إجمالي المبيعات
            {' - '}
            قيمة المرتجعات
            {' + '}
            صافي فرق الاستبدالات.
          </p>

          <p className="muted">
            فواتير البيع التي تحتاج مراجعة ظاهرة بصورة منفصلة داخل التقرير،
            والفواتير الملغاة لا تدخل في إجمالي المبيعات.
          </p>
        </section>
      ) : null}
    </>
  )
}

export default SalesPerformancePage
