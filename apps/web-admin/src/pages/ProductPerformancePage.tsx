import { useEffect, useMemo, useState } from 'react'

import { requestJson } from '../lib/http'

type ApiResponse<T> = {
  data: T
}

type BranchOption = {
  id: string
  code: string
  name: string
  isActive: boolean
}

type ProductPerformanceItem = {
  variantId: string
  productId: string
  productName: string
  sku: string

  primaryBarcode: string | null

  sizeName: string | null

  colorName: string | null

  categoryName: string | null

  brandName: string | null

  productStatus: string | null

  variantStatus: string | null

  salesCount: number
  soldQuantity: string
  grossRevenue: string
  averageUnitRevenue: string
  currentStock: string

  lastSaleAt: string | null

  daysSinceLastSale: number | null
}

type SlowMovingProduct = ProductPerformanceItem & {
  movementClass: 'no_sales_in_period' | 'low_sales_in_period'
}

type ProductPerformanceReport = {
  filters: {
    companyId: string

    branchId: string | null

    dateFrom: string
    dateTo: string
    days: number
    limit: number
  }

  definitions: {
    includedSaleStatuses: string[]
    topProductsOrder: string
    slowMovingOrder: string
    stockBasis: string
    salesBasis: string
  }

  branchOptions: BranchOption[]

  summary: {
    salesCount: number
    soldVariantCount: number
    soldQuantity: string
    grossRevenue: string
    inStockVariantCount: number
    currentStockQuantity: string
    noSaleStockVariantCount: number
  }

  topProducts: ProductPerformanceItem[]

  slowMovingProducts: SlowMovingProduct[]
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

const timestampFormatter = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatMoney(value: string | number | null | undefined) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? moneyFormatter.format(numericValue)
    : '-'
}

function formatQuantity(value: string | number | null | undefined) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? quantityFormatter.format(numericValue)
    : '-'
}

function formatTimestamp(value: string | null) {
  if (!value) {
    return 'لا توجد عملية بيع سابقة'
  }

  const date = new Date(value)

  return Number.isNaN(date.getTime()) ? '-' : timestampFormatter.format(date)
}

function formatDaysSinceSale(value: number | null) {
  if (value === null) {
    return 'لم يُبع من قبل'
  }

  if (value === 0) {
    return 'أقل من يوم'
  }

  return `${value} يوم`
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

function createVariantDescription(item: ProductPerformanceItem) {
  return [
    item.sizeName ? `المقاس: ${item.sizeName}` : null,

    item.colorName ? `اللون: ${item.colorName}` : null,

    `SKU: ${item.sku}`,
  ]
    .filter(Boolean)
    .join(' • ')
}

function ProductPerformancePage() {
  const [dateFrom, setDateFrom] = useState(createMonthStartValue)

  const [dateTo, setDateTo] = useState(createTodayValue)

  const [branchId, setBranchId] = useState('')

  const [limit, setLimit] = useState('20')

  const [report, setReport] = useState<ProductPerformanceReport | null>(null)

  const [branchOptions, setBranchOptions] = useState<BranchOption[]>([])

  const [loading, setLoading] = useState(false)

  const [error, setError] = useState('')

  const maxTopQuantity = useMemo(() => {
    if (!report) {
      return 1
    }

    const maximum = Math.max(
      ...report.topProducts
        .slice(0, 10)
        .map((product) => Math.max(Number(product.soldQuantity) || 0, 0)),
      0,
    )

    return maximum > 0 ? maximum : 1
  }, [report])

  function buildReportUrl(selectedBranchId = branchId) {
    const parameters = new URLSearchParams({
      dateFrom,
      dateTo,
      limit,
    })

    if (selectedBranchId) {
      parameters.set('branchId', selectedBranchId)
    }

    return '/api/reports/' + 'product-performance?' + parameters.toString()
  }

  async function loadReport(selectedBranchId = branchId) {
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
    setReport(null)

    try {
      const response = await requestJson<ApiResponse<ProductPerformanceReport>>(
        buildReportUrl(selectedBranchId),
      )

      setReport(response.data)

      setBranchOptions(response.data.branchOptions)

      if (response.data.filters.branchId) {
        setBranchId(response.data.filters.branchId)
      } else if (!selectedBranchId) {
        setBranchId('')
      }
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل تقرير أداء الأصناف.',
      )
    } finally {
      setLoading(false)
    }
  }

  async function clearBranchFilter() {
    setBranchId('')

    await loadReport('')
  }

  useEffect(() => {
    void loadReport('')
  }, [])

  const summary = report?.summary

  const branchFilterLocked = branchOptions.length <= 1

  return (
    <>
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>أداء الأصناف</h2>

            <p className="muted">
              الأصناف الأكثر مبيعًا والأصناف بطيئة الحركة اعتمادًا على المبيعات
              والمخزون الحالي في PostgreSQL.
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
              disabled={loading || branchFilterLocked}
              onChange={(event) => setBranchId(event.target.value)}
            >
              {!branchFilterLocked ? (
                <option value="">كل الفروع والمخازن</option>
              ) : null}

              {branchOptions.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                  {' — '}
                  {branch.code}
                  {!branch.isActive ? ' — غير نشط' : ''}
                </option>
              ))}
            </select>
          </label>

          <label>
            عدد النتائج
            <select
              value={limit}
              disabled={loading}
              onChange={(event) => setLimit(event.target.value)}
            >
              <option value="10">10 أصناف</option>

              <option value="20">20 صنفًا</option>

              <option value="50">50 صنفًا</option>

              <option value="100">100 صنف</option>
            </select>
          </label>
        </div>

        <div className="report-filter-actions">
          <button
            type="button"
            className="table-button"
            disabled={loading || !branchId || branchFilterLocked}
            onClick={() => void clearBranchFilter()}
          >
            عرض كل الفروع
          </button>

          {report ? (
            <span className="muted">
              الفترة: {report.filters.days} يوم
              {' • '}
              الحد: {report.filters.limit} نتيجة
            </span>
          ) : null}
        </div>

        {error ? <p className="error-message">{error}</p> : null}

        {loading ? (
          <p className="muted">جاري تحليل المبيعات والمخزون...</p>
        ) : null}
      </section>

      {summary ? (
        <section className="mini-cards-grid product-report-summary-grid">
          <article className="mini-card">
            <span>إيراد الأصناف المباع</span>

            <strong>{formatMoney(summary.grossRevenue)}</strong>
          </article>

          <article className="mini-card">
            <span>الكمية المباعة</span>

            <strong>{formatQuantity(summary.soldQuantity)}</strong>
          </article>

          <article className="mini-card">
            <span>فواتير البيع</span>

            <strong>{summary.salesCount}</strong>
          </article>

          <article className="mini-card">
            <span>أصناف تم بيعها</span>

            <strong>{summary.soldVariantCount}</strong>
          </article>

          <article className="mini-card">
            <span>أصناف بها مخزون</span>

            <strong>{summary.inStockVariantCount}</strong>
          </article>

          <article className="mini-card">
            <span>كمية المخزون الحالية</span>

            <strong>{formatQuantity(summary.currentStockQuantity)}</strong>
          </article>

          <article className="mini-card product-report-alert-card">
            <span>مخزون بدون مبيعات</span>

            <strong>{summary.noSaleStockVariantCount}</strong>

            <small className="muted">
              أصناف بها مخزون ولم تُبع خلال الفترة
            </small>
          </article>
        </section>
      ) : null}

      {report ? (
        <section className="panel">
          <div className="section-header product-report-table-header">
            <div>
              <h2>مقارنة الأكثر مبيعًا</h2>

              <p className="muted">
                أول عشرة أصناف حسب الكمية المباعة خلال الفترة.
              </p>
            </div>
          </div>

          {report.topProducts.length === 0 ? (
            <p className="muted">لا توجد أصناف مباعة خلال الفترة الحالية.</p>
          ) : (
            <div className="product-report-chart">
              {report.topProducts.slice(0, 10).map((product, index) => {
                const quantity = Math.max(Number(product.soldQuantity) || 0, 0)

                const width =
                  quantity === 0
                    ? 0
                    : Math.max((quantity / maxTopQuantity) * 100, 2)

                return (
                  <div
                    key={product.variantId}
                    className="product-report-bar-row"
                  >
                    <span className="product-report-rank">{index + 1}</span>

                    <div className="product-report-bar-label">
                      <strong>{product.productName}</strong>

                      <small>{createVariantDescription(product)}</small>
                    </div>

                    <div className="product-report-bar-track">
                      <div
                        className="product-report-bar-fill"
                        style={{
                          width: `${width}%`,
                        }}
                      />
                    </div>

                    <div className="product-report-bar-value">
                      <strong>{formatQuantity(product.soldQuantity)}</strong>

                      <small>{formatMoney(product.grossRevenue)}</small>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      ) : null}

      {report ? (
        <section className="panel">
          <div className="section-header product-report-table-header">
            <div>
              <h2>الأصناف الأكثر مبيعًا</h2>

              <p className="muted">
                الترتيب يعتمد أولًا على الكمية المباعة ثم قيمة المبيعات.
              </p>
            </div>

            <span className="dashboard-record-count">
              {report.topProducts.length} صنف
            </span>
          </div>

          {report.topProducts.length === 0 ? (
            <p className="muted">لا توجد نتائج.</p>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>الصنف</th>
                    <th>التصنيف</th>
                    <th>الفواتير</th>
                    <th>الكمية المباعة</th>
                    <th>الإيراد</th>
                    <th>متوسط الوحدة</th>
                    <th>المخزون الحالي</th>
                    <th>آخر بيع</th>
                  </tr>
                </thead>

                <tbody>
                  {report.topProducts.map((product, index) => (
                    <tr key={product.variantId}>
                      <td>
                        <span className="product-report-rank">{index + 1}</span>
                      </td>

                      <td>
                        <div className="product-report-item">
                          <strong>{product.productName}</strong>

                          <small>{createVariantDescription(product)}</small>

                          {product.productStatus !== 'active' ||
                          product.variantStatus !== 'active' ? (
                            <span className="product-report-status-badge">
                              غير نشط حاليًا
                            </span>
                          ) : null}
                        </div>
                      </td>

                      <td>
                        <div className="product-report-item">
                          <span>{product.categoryName || '-'}</span>

                          <small>{product.brandName || '-'}</small>
                        </div>
                      </td>

                      <td>{product.salesCount}</td>

                      <td>
                        <strong>{formatQuantity(product.soldQuantity)}</strong>
                      </td>

                      <td>{formatMoney(product.grossRevenue)}</td>

                      <td>{formatMoney(product.averageUnitRevenue)}</td>

                      <td>
                        <strong className="product-report-stock">
                          {formatQuantity(product.currentStock)}
                        </strong>
                      </td>

                      <td>{formatTimestamp(product.lastSaleAt)}</td>
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
          <div className="section-header product-report-table-header">
            <div>
              <h2>الأصناف بطيئة الحركة</h2>

              <p className="muted">
                تظهر الأصناف النشطة التي لديها مخزون حالي أكبر من صفر، والأقل
                مبيعًا تظهر أولًا.
              </p>
            </div>

            <span className="dashboard-record-count">
              {report.slowMovingProducts.length} صنف
            </span>
          </div>

          {report.slowMovingProducts.length === 0 ? (
            <p className="muted">
              لا توجد أصناف بطيئة الحركة ضمن النطاق الحالي.
            </p>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>الحالة</th>
                    <th>الصنف</th>
                    <th>التصنيف</th>
                    <th>المخزون الحالي</th>
                    <th>الكمية المباعة</th>
                    <th>الفواتير</th>
                    <th>إيراد الفترة</th>
                    <th>آخر بيع</th>
                    <th>المدة</th>
                  </tr>
                </thead>

                <tbody>
                  {report.slowMovingProducts.map((product) => (
                    <tr key={product.variantId}>
                      <td>
                        <span
                          className={
                            product.movementClass === 'no_sales_in_period'
                              ? 'product-movement-badge product-movement-none'
                              : 'product-movement-badge product-movement-low'
                          }
                        >
                          {product.movementClass === 'no_sales_in_period'
                            ? 'بدون مبيعات'
                            : 'حركة منخفضة'}
                        </span>
                      </td>

                      <td>
                        <div className="product-report-item">
                          <strong>{product.productName}</strong>

                          <small>{createVariantDescription(product)}</small>
                        </div>
                      </td>

                      <td>
                        <div className="product-report-item">
                          <span>{product.categoryName || '-'}</span>

                          <small>{product.brandName || '-'}</small>
                        </div>
                      </td>

                      <td>
                        <strong className="product-report-stock">
                          {formatQuantity(product.currentStock)}
                        </strong>
                      </td>

                      <td>{formatQuantity(product.soldQuantity)}</td>

                      <td>{product.salesCount}</td>

                      <td>{formatMoney(product.grossRevenue)}</td>

                      <td>{formatTimestamp(product.lastSaleAt)}</td>

                      <td>{formatDaysSinceSale(product.daysSinceLastSale)}</td>
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
          <h2>طريقة الحساب</h2>

          <p className="selected-customer">
            الأكثر مبيعًا = ترتيب الأصناف حسب الكمية المباعة ثم قيمة المبيعات.
          </p>

          <p className="selected-customer">
            بطيئة الحركة = أصناف نشطة لديها مخزون موجب، مرتبة من الأقل مبيعًا
            إلى الأعلى، مع تقديم الأصناف التي لم تُبع خلال الفترة.
          </p>

          <p className="muted">
            التقرير يعرض إجمالي حركة البيع قبل خصم المرتجعات. المخزون الحالي
            يأتي مباشرة من PostgreSQL ولا يعتمد على مخزون محلي في Desktop POS.
          </p>
        </section>
      ) : null}
    </>
  )
}

export default ProductPerformancePage
