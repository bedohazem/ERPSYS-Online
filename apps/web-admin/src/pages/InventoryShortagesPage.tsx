import { useEffect, useState } from 'react'

import { requestJson } from '../lib/http'

type ApiResponse<T> = {
  data: T
}

type StockStatus = 'critical' | 'low' | 'healthy'

type ReportStatus = 'alerts' | StockStatus | 'all'

type BranchOption = {
  id: string
  code: string
  name: string
  isActive: boolean
}

type StockLocationOption = {
  id: string
  branchId: string | null
  branchCode: string | null
  branchName: string | null
  code: string
  name: string
  locationType: string
}

type ShortageItem = {
  ruleId: string

  branchId: string | null
  branchCode: string | null
  branchName: string | null

  stockLocationId: string
  stockLocationCode: string
  stockLocationName: string
  stockLocationType: string

  variantId: string
  productId: string
  productName: string
  sku: string
  primaryBarcode: string | null

  sizeName: string | null
  colorName: string | null
  categoryName: string | null
  brandName: string | null

  reorderPoint: string
  safetyStock: string
  reorderQuantity: string

  currentQuantity: string
  shortageQuantity: string
  suggestedOrderQuantity: string

  stockStatus: StockStatus
  updatedAt: string | null
}

type InventoryShortageReport = {
  filters: {
    companyId: string
    branchId: string | null
    stockLocationId: string | null
    status: ReportStatus
    search: string | null
    page: number
    pageSize: number
  }

  scope: {
    branchSelectionLocked: boolean
  }

  definitions: {
    alertStatuses: string[]
    criticalRule: string
    lowRule: string
    healthyRule: string
    shortageFormula: string
    suggestedOrderFormula: string
    inventorySource: string
    activeSourcesOnly: boolean
  }

  branchOptions: BranchOption[]
  stockLocationOptions: StockLocationOption[]

  summary: {
    totalActiveRules: number
    stockLocationCount: number
    variantCount: number
    criticalCount: number
    lowCount: number
    healthyCount: number
    outOfStockCount: number
    totalShortageQuantity: string
    totalSuggestedOrderQuantity: string
  }

  items: ShortageItem[]

  pagination: {
    page: number
    pageSize: number
    totalItems: number
    totalPages: number
    hasPreviousPage: boolean
    hasNextPage: boolean
  }
}

const quantityFormatter = new Intl.NumberFormat('ar-EG', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
})

const timestampFormatter = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatQuantity(value: string | number | null | undefined) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? quantityFormatter.format(numericValue)
    : '-'
}

function formatTimestamp(value: string | null) {
  if (!value) {
    return '-'
  }

  const date = new Date(value)

  return Number.isNaN(date.getTime()) ? '-' : timestampFormatter.format(date)
}

function createVariantDescription(item: ShortageItem) {
  return [
    item.sizeName ? `المقاس: ${item.sizeName}` : null,

    item.colorName ? `اللون: ${item.colorName}` : null,

    `SKU: ${item.sku}`,

    item.primaryBarcode ? `باركود: ${item.primaryBarcode}` : null,
  ]
    .filter(Boolean)
    .join(' • ')
}

function getStatusLabel(status: StockStatus) {
  if (status === 'critical') {
    return 'حرج'
  }

  if (status === 'low') {
    return 'منخفض'
  }

  return 'سليم'
}

function getStatusClassName(status: StockStatus) {
  return ['shortage-status-badge', `shortage-status-${status}`].join(' ')
}

function InventoryShortagesPage() {
  const [branchId, setBranchId] = useState('')

  const [stockLocationId, setStockLocationId] = useState('')

  const [status, setStatus] = useState<ReportStatus>('alerts')

  const [search, setSearch] = useState('')

  const [pageSize, setPageSize] = useState('50')

  const [report, setReport] = useState<InventoryShortageReport | null>(null)

  const [loading, setLoading] = useState(false)

  const [error, setError] = useState('')

  function buildReportUrl(
    requestedPage: number,
    selectedBranchId = branchId,
    selectedLocationId = stockLocationId,
  ) {
    const parameters = new URLSearchParams({
      status,
      page: String(requestedPage),
      pageSize,
    })

    if (selectedBranchId) {
      parameters.set('branchId', selectedBranchId)
    }

    if (selectedLocationId) {
      parameters.set('stockLocationId', selectedLocationId)
    }

    if (search.trim()) {
      parameters.set('search', search.trim())
    }

    return '/api/reports/' + 'inventory-shortages?' + parameters.toString()
  }

  async function loadReport(
    requestedPage = 1,
    selectedBranchId = branchId,
    selectedLocationId = stockLocationId,
  ) {
    setLoading(true)
    setError('')
    setReport(null)

    try {
      const response = await requestJson<ApiResponse<InventoryShortageReport>>(
        buildReportUrl(requestedPage, selectedBranchId, selectedLocationId),
      )

      setReport(response.data)

      setBranchId(response.data.filters.branchId ?? '')

      setStockLocationId(response.data.filters.stockLocationId ?? '')
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل تقرير نواقص المخزون.',
      )
    } finally {
      setLoading(false)
    }
  }

  function handleBranchChange(selectedBranchId: string) {
    setBranchId(selectedBranchId)

    // منع الاحتفاظ بمكان تخزين
    // تابع لفرع مختلف.
    setStockLocationId('')
  }

  async function clearFilters() {
    setBranchId('')
    setStockLocationId('')
    setStatus('alerts')
    setSearch('')
    setPageSize('50')

    setLoading(true)
    setError('')
    setReport(null)

    try {
      const response = await requestJson<ApiResponse<InventoryShortageReport>>(
        '/api/reports/' +
          'inventory-shortages?' +
          new URLSearchParams({
            status: 'alerts',
            page: '1',
            pageSize: '50',
          }).toString(),
      )

      setReport(response.data)

      setBranchId(response.data.filters.branchId ?? '')
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر إعادة تحميل تقرير النواقص.',
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadReport(1, '', '')
  }, [])

  const branchSelectionLocked = report?.scope.branchSelectionLocked ?? true

  const availableLocations = report?.stockLocationOptions ?? []

  const summary = report?.summary

  return (
    <>
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>نواقص المخزون</h2>

            <p className="muted">
              تنبيهات المخزون الحرج والمنخفض والكميات المقترحة للشراء، اعتمادًا
              على أرصدة PostgreSQL الحالية.
            </p>
          </div>

          <button
            type="button"
            className="primary-button small-button"
            disabled={loading}
            onClick={() => void loadReport(1)}
          >
            {loading ? 'جاري إعداد التقرير...' : 'تحديث التقرير'}
          </button>
        </div>

        <div className="form-grid shortage-filter-grid">
          <label>
            الفرع
            <select
              value={branchId}
              disabled={loading || branchSelectionLocked}
              onChange={(event) => handleBranchChange(event.target.value)}
            >
              {!branchSelectionLocked ? (
                <option value="">كل الفروع</option>
              ) : null}

              {report?.branchOptions.map((branch) => (
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
            مكان التخزين
            <select
              value={stockLocationId}
              disabled={loading}
              onChange={(event) => setStockLocationId(event.target.value)}
            >
              <option value="">كل أماكن التخزين</option>

              {availableLocations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                  {' — '}
                  {location.code}

                  {location.branchName
                    ? ` — ${location.branchName}`
                    : ' — مخزن مركزي'}
                </option>
              ))}
            </select>
          </label>

          <label>
            حالة المخزون
            <select
              value={status}
              disabled={loading}
              onChange={(event) =>
                setStatus(event.target.value as ReportStatus)
              }
            >
              <option value="alerts">التنبيهات فقط</option>

              <option value="critical">حرج</option>

              <option value="low">منخفض</option>

              <option value="healthy">سليم</option>

              <option value="all">كل الحالات</option>
            </select>
          </label>

          <label>
            عدد النتائج
            <select
              value={pageSize}
              disabled={loading}
              onChange={(event) => setPageSize(event.target.value)}
            >
              <option value="20">20 نتيجة</option>

              <option value="50">50 نتيجة</option>

              <option value="100">100 نتيجة</option>
            </select>
          </label>
        </div>

        <div className="shortage-search-row">
          <label>
            بحث
            <input
              type="search"
              value={search}
              maxLength={100}
              disabled={loading}
              placeholder="اسم الصنف أو SKU أو الباركود أو المخزن"
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void loadReport(1)
                }
              }}
            />
          </label>

          <div className="shortage-search-actions">
            <button
              type="button"
              className="table-button"
              disabled={loading}
              onClick={() => void loadReport(1)}
            >
              تطبيق الفلاتر
            </button>

            <button
              type="button"
              className="table-button"
              disabled={loading}
              onClick={() => void clearFilters()}
            >
              مسح الفلاتر
            </button>
          </div>
        </div>

        {error ? <p className="error-message">{error}</p> : null}

        {loading ? (
          <p className="muted">جاري تحليل حدود إعادة الطلب وأرصدة المخزون...</p>
        ) : null}
      </section>

      {summary ? (
        <section className="mini-cards-grid shortage-summary-grid">
          <article className="mini-card shortage-card-critical">
            <span>حالات حرجة</span>

            <strong>{summary.criticalCount}</strong>
          </article>

          <article className="mini-card shortage-card-low">
            <span>مخزون منخفض</span>

            <strong>{summary.lowCount}</strong>
          </article>

          <article className="mini-card">
            <span>نفد من المخزون</span>

            <strong>{summary.outOfStockCount}</strong>
          </article>

          <article className="mini-card">
            <span>حالات سليمة</span>

            <strong>{summary.healthyCount}</strong>
          </article>

          <article className="mini-card">
            <span>إجمالي القواعد النشطة</span>

            <strong>{summary.totalActiveRules}</strong>
          </article>

          <article className="mini-card">
            <span>الأصناف المراقبة</span>

            <strong>{summary.variantCount}</strong>
          </article>

          <article className="mini-card shortage-card-critical">
            <span>إجمالي العجز</span>

            <strong>{formatQuantity(summary.totalShortageQuantity)}</strong>
          </article>

          <article className="mini-card shortage-card-order">
            <span>كمية الشراء المقترحة</span>

            <strong>
              {formatQuantity(summary.totalSuggestedOrderQuantity)}
            </strong>
          </article>
        </section>
      ) : null}

      {report ? (
        <section className="panel">
          <div className="section-header shortage-table-header">
            <div>
              <h2>تفاصيل النواقص</h2>

              <p className="muted">
                الحالات الحرجة تظهر أولًا، ثم الأقل مخزونًا والأكبر عجزًا.
              </p>
            </div>

            <span className="dashboard-record-count">
              {report.pagination.totalItems} نتيجة
            </span>
          </div>

          {report.items.length === 0 ? (
            <p className="muted">لا توجد نتائج مطابقة للفلاتر الحالية.</p>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>الحالة</th>
                    <th>الصنف</th>
                    <th>الفرع والمخزن</th>
                    <th>الرصيد الحالي</th>
                    <th>حد الأمان</th>
                    <th>حد إعادة الطلب</th>
                    <th>العجز</th>
                    <th>الكمية المقترحة</th>
                    <th>التصنيف</th>
                    <th>آخر تحديث</th>
                  </tr>
                </thead>

                <tbody>
                  {report.items.map((item) => (
                    <tr key={item.ruleId}>
                      <td>
                        <span className={getStatusClassName(item.stockStatus)}>
                          {getStatusLabel(item.stockStatus)}
                        </span>
                      </td>

                      <td>
                        <div className="shortage-item-name">
                          <strong>{item.productName}</strong>

                          <small>{createVariantDescription(item)}</small>
                        </div>
                      </td>

                      <td>
                        <div className="shortage-item-name">
                          <strong>{item.stockLocationName}</strong>

                          <small>
                            {item.branchName || 'مخزن مركزي'}
                            {' • '}
                            {item.stockLocationCode}
                          </small>
                        </div>
                      </td>

                      <td>
                        <strong
                          className={
                            item.stockStatus === 'critical'
                              ? 'shortage-number-critical'
                              : item.stockStatus === 'low'
                                ? 'shortage-number-low'
                                : 'shortage-number-healthy'
                          }
                        >
                          {formatQuantity(item.currentQuantity)}
                        </strong>
                      </td>

                      <td>{formatQuantity(item.safetyStock)}</td>

                      <td>{formatQuantity(item.reorderPoint)}</td>

                      <td>
                        <strong className="shortage-number-critical">
                          {formatQuantity(item.shortageQuantity)}
                        </strong>
                      </td>

                      <td>
                        <strong className="shortage-order-quantity">
                          {formatQuantity(item.suggestedOrderQuantity)}
                        </strong>
                      </td>

                      <td>
                        <div className="shortage-item-name">
                          <span>{item.categoryName || '-'}</span>

                          <small>{item.brandName || '-'}</small>
                        </div>
                      </td>

                      <td>{formatTimestamp(item.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="shortage-pagination">
            <button
              type="button"
              className="table-button"
              disabled={loading || !report.pagination.hasPreviousPage}
              onClick={() => void loadReport(report.pagination.page - 1)}
            >
              الصفحة السابقة
            </button>

            <span className="muted">
              الصفحة {report.pagination.page} من{' '}
              {Math.max(report.pagination.totalPages, 1)}
            </span>

            <button
              type="button"
              className="table-button"
              disabled={loading || !report.pagination.hasNextPage}
              onClick={() => void loadReport(report.pagination.page + 1)}
            >
              الصفحة التالية
            </button>
          </div>
        </section>
      ) : null}

      {report ? (
        <section className="panel">
          <h2>طريقة الحساب</h2>

          <p className="selected-customer">
            حرج: الرصيد الحالي يساوي حد الأمان أو أقل.
          </p>

          <p className="selected-customer">
            منخفض: الرصيد أعلى من حد الأمان، لكنه يساوي حد إعادة الطلب أو أقل.
          </p>

          <p className="selected-customer">
            كمية العجز = حد إعادة الطلب ناقص الرصيد الحالي، وبحد أدنى صفر.
          </p>

          <p className="selected-customer">
            الكمية المقترحة = القيمة الأكبر بين كمية إعادة الطلب الثابتة وكمية
            العجز.
          </p>

          <p className="muted">
            التقرير يعتمد حصريًا على أرصدة PostgreSQL الحالية. لا يتم استخدام أو
            خصم أي مخزون محلي داخل Desktop POS.
          </p>
        </section>
      ) : null}
    </>
  )
}

export default InventoryShortagesPage
