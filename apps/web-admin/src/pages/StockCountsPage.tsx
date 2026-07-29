import { useEffect, useMemo, useRef, useState } from 'react'

import { useAuth } from '../auth/AuthContext'
import { requestJson } from '../lib/http'

type StockCountStatus = 'draft' | 'completed' | 'cancelled'

type StockLocation = {
  id: string
  branch_id: string | null
  code: string
  name: string
  location_type: string
}

type StockCountSummary = {
  id: string
  branch_id: string | null
  stock_location_id: string

  count_number: string
  status: StockCountStatus
  notes: string | null

  stock_location_code: string
  stock_location_name: string
  location_type: string

  created_by_name: string | null
  created_at: string

  item_count: number
  counted_item_count: number
  difference_item_count: number
}

type StockCountHeader = {
  id: string
  branch_id: string | null
  stock_location_id: string

  count_number: string
  status: StockCountStatus
  notes: string | null

  stock_location_code?: string
  stock_location_name?: string
  location_type?: string

  created_by_name?: string | null
  completed_by_name?: string | null
  cancelled_by_name?: string | null

  created_at: string
  completed_at: string | null
  cancelled_at: string | null
}

type StockCountItem = {
  id: string
  stock_count_id: string
  variant_id: string

  product_id: string
  product_name: string

  sku: string
  primary_barcode: string | null

  size_name: string | null
  color_name: string | null

  expected_quantity: string
  counted_quantity: string | null
  difference_quantity: string | null

  updated_by_name: string | null
  updated_at: string
}

type StockCountDetail = {
  stockCount: StockCountHeader
  items: StockCountItem[]
}

type StockCountDetailMeta = {
  itemCount: number
  countedItemCount: number
  differenceItemCount: number
  remainingItemCount: number
}

type ApiResponse<T> = {
  data: T
}

type StockCountDetailResponse = {
  data: StockCountDetail
  meta: StockCountDetailMeta
}

type OpenStockCountResponse = {
  data: {
    stockCount: StockCountHeader
    location: StockLocation
    itemCount: number
  }

  meta: {
    duplicate: boolean
  }
}

type StockCountsPageProps = {
  companyId: string
  branchId: string
}

const quantityFormatter = new Intl.NumberFormat('ar-EG', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
})

const dateTimeFormatter = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

// تنسيق كميات المخزون مع دعم الكسور حتى 3 خانات.
function formatQuantity(value: number | string | null) {
  if (value === null) {
    return '-'
  }

  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? quantityFormatter.format(numericValue)
    : '-'
}

// تنسيق التاريخ القادم من الـBackend حسب جهاز المستخدم.
function formatDateTime(value: string | null) {
  if (!value) {
    return '-'
  }

  const parsedDate = new Date(value)

  return Number.isNaN(parsedDate.getTime())
    ? '-'
    : dateTimeFormatter.format(parsedDate)
}

// ترجمة حالة مستند الجرد.
function translateStockCountStatus(status: StockCountStatus) {
  const labels: Record<StockCountStatus, string> = {
    draft: 'مفتوح',
    completed: 'مكتمل',
    cancelled: 'ملغي',
  }

  return labels[status]
}

// اختيار لون الحالة داخل الجدول.
function getStockCountStatusClass(status: StockCountStatus) {
  return `stock-count-status stock-count-status-${status}`
}

// ترجمة نوع مكان التخزين.
function translateLocationType(locationType: string) {
  const labels: Record<string, string> = {
    main_warehouse: 'المخزن الرئيسي',
    branch_warehouse: 'مخزن الفرع',
    sales_floor: 'صالة البيع',
    returns: 'مخزن المرتجعات',
    damaged: 'مخزن التالف',
    inspection: 'منطقة الفحص',
  }

  return labels[locationType] || locationType
}

function StockCountsPage({ companyId, branchId }: StockCountsPageProps) {
  const { user } = useAuth()

  const [stockLocations, setStockLocations] = useState<StockLocation[]>([])
  const [stockCounts, setStockCounts] = useState<StockCountSummary[]>([])

  const [selectedStockCountId, setSelectedStockCountId] = useState('')
  const [detail, setDetail] = useState<StockCountDetail | null>(null)
  const [detailMeta, setDetailMeta] = useState<StockCountDetailMeta | null>(
    null,
  )

  const [statusFilter, setStatusFilter] = useState('')
  const [locationFilter, setLocationFilter] = useState('')
  const [itemSearch, setItemSearch] = useState('')

  const [newStockLocationId, setNewStockLocationId] = useState('')
  const [newNotes, setNewNotes] = useState('')

  // كل Item له قيمة نصية مستقلة حتى يسمح الحقل بالقيمة الفارغة.
  const [quantityDrafts, setQuantityDrafts] = useState<Record<string, string>>(
    {},
  )

  const [loadingLocations, setLoadingLocations] = useState(false)
  const [loadingCounts, setLoadingCounts] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)

  const [openingCount, setOpeningCount] = useState(false)
  const [savingItemId, setSavingItemId] = useState('')
  const [completingCount, setCompletingCount] = useState(false)
  const [cancellingCount, setCancellingCount] = useState(false)

  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  // نفس المفتاح يُستخدم عند إعادة محاولة فتح نفس الجرد.
  const openingIdempotencyKeyRef = useRef<string | null>(null)

  const isAdmin = user?.roles.includes('admin') ?? false

  const canAdjustInventory =
    isAdmin || user?.permissions.includes('inventory.adjust') || false

  // تحميل أماكن التخزين المتاحة للمستخدم والفرع الحالي.
  async function loadStockLocations() {
    setLoadingLocations(true)

    try {
      const url =
        `/api/inventory/stock-locations` +
        `?companyId=${encodeURIComponent(companyId)}` +
        (branchId ? `&branchId=${encodeURIComponent(branchId)}` : '')

      const response = await requestJson<ApiResponse<StockLocation[]>>(url)

      setStockLocations(response.data)

      setNewStockLocationId((currentLocationId) => {
        const locationStillExists = response.data.some(
          (location) => location.id === currentLocationId,
        )

        return locationStillExists
          ? currentLocationId
          : (response.data[0]?.id ?? '')
      })
    } catch (currentError) {
      setStockLocations([])
      setNewStockLocationId('')

      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل أماكن التخزين.',
      )
    } finally {
      setLoadingLocations(false)
    }
  }

  // تحميل قائمة جلسات الجرد مع تطبيق الفلاتر الحالية.
  async function loadStockCounts() {
    setLoadingCounts(true)
    setError('')

    try {
      const query = new URLSearchParams()

      if (statusFilter) {
        query.set('status', statusFilter)
      }

      if (locationFilter) {
        query.set('stockLocationId', locationFilter)
      }

      query.set('limit', '200')

      const response = await requestJson<ApiResponse<StockCountSummary[]>>(
        `/api/inventory/stock-counts?${query.toString()}`,
      )

      setStockCounts(response.data)

      if (
        selectedStockCountId &&
        !response.data.some(
          (stockCount) => stockCount.id === selectedStockCountId,
        )
      ) {
        setSelectedStockCountId('')
        setDetail(null)
        setDetailMeta(null)
      }
    } catch (currentError) {
      setStockCounts([])

      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل جلسات الجرد.',
      )
    } finally {
      setLoadingCounts(false)
    }
  }

  // تحميل رأس جلسة الجرد وأصنافها والكميات المدخلة.
  async function loadStockCountDetail(stockCountId: string) {
    if (!stockCountId) {
      setDetail(null)
      setDetailMeta(null)
      return
    }

    setLoadingDetail(true)
    setError('')

    try {
      const response = await requestJson<StockCountDetailResponse>(
        `/api/inventory/stock-counts/${encodeURIComponent(stockCountId)}`,
      )

      setDetail(response.data)
      setDetailMeta(response.meta)

      // تجهيز Inputs بالكميات المحفوظة سابقًا.
      setQuantityDrafts(
        Object.fromEntries(
          response.data.items.map((item) => [
            item.id,
            item.counted_quantity ?? '',
          ]),
        ),
      )
    } catch (currentError) {
      setDetail(null)
      setDetailMeta(null)

      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل تفاصيل جلسة الجرد.',
      )
    } finally {
      setLoadingDetail(false)
    }
  }

  // أي تغيير في بيانات الجرد الجديد يعني طلبًا جديدًا.
  function resetOpeningRequest() {
    openingIdempotencyKeyRef.current = null
    setSuccess('')
  }

  // فتح جلسة جديدة وحفظ Snapshot من الرصيد الحالي.
  async function openStockCount() {
    if (!newStockLocationId) {
      setError('اختر مكان التخزين أولًا.')
      return
    }

    setOpeningCount(true)
    setError('')
    setSuccess('')

    try {
      const idempotencyKey =
        openingIdempotencyKeyRef.current ?? crypto.randomUUID()

      openingIdempotencyKeyRef.current = idempotencyKey

      const response = await requestJson<OpenStockCountResponse>(
        '/api/inventory/stock-counts',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            stockLocationId: newStockLocationId,
            notes: newNotes.trim() || null,
            idempotencyKey,
          }),
        },
      )

      const openedStockCount = response.data.stockCount

      setSelectedStockCountId(openedStockCount.id)
      setNewNotes('')
      openingIdempotencyKeyRef.current = null

      setSuccess(
        response.meta.duplicate
          ? 'تم فتح جلسة الجرد السابقة بدون إنشاء جلسة مكررة.'
          : `تم فتح جلسة الجرد ${openedStockCount.count_number}.`,
      )

      await loadStockCounts()
      await loadStockCountDetail(openedStockCount.id)
    } catch (currentError) {
      // نحتفظ بالمفتاح حتى تكون Retry لنفس الطلب آمنة.
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر فتح جلسة الجرد.',
      )
    } finally {
      setOpeningCount(false)
    }
  }

  // حفظ الكمية الفعلية لصنف واحد داخل جلسة Draft.
  async function saveCountedQuantity(item: StockCountItem) {
    const draftValue = quantityDrafts[item.id]?.trim() ?? ''

    if (!draftValue) {
      setError('اكتب الكمية الفعلية أولًا.')
      return
    }

    const numericQuantity = Number(draftValue)

    if (!Number.isFinite(numericQuantity) || numericQuantity < 0) {
      setError('الكمية الفعلية غير صالحة.')
      return
    }

    const normalizedQuantity = Number(numericQuantity.toFixed(3))

    if (Math.abs(numericQuantity - normalizedQuantity) > 0.0000001) {
      setError('الكمية تسمح بثلاث خانات عشرية فقط.')
      return
    }

    setSavingItemId(item.id)
    setError('')
    setSuccess('')

    try {
      await requestJson(
        `/api/inventory/stock-counts/${encodeURIComponent(
          item.stock_count_id,
        )}/items/${encodeURIComponent(item.id)}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            countedQuantity: normalizedQuantity,
          }),
        },
      )

      setSuccess(`تم حفظ كمية ${item.product_name}.`)

      await Promise.all([
        loadStockCounts(),
        loadStockCountDetail(item.stock_count_id),
      ])
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر حفظ الكمية الفعلية.',
      )
    } finally {
      setSavingItemId('')
    }
  }

  // اعتماد الجرد بعد التأكد من اكتمال إدخال كل الأصناف.
  async function completeStockCount() {
    if (!detail || !detailMeta) {
      return
    }

    if (detailMeta.remainingItemCount > 0) {
      setError(
        `يوجد ${detailMeta.remainingItemCount} صنف لم يتم إدخال كميته الفعلية.`,
      )
      return
    }

    const confirmed = window.confirm(
      `سيتم اعتماد الجرد ${detail.stockCount.count_number} ` +
        `وتطبيق فروق ${detailMeta.differenceItemCount} صنف على المخزون. ` +
        'هل تريد المتابعة؟',
    )

    if (!confirmed) {
      return
    }

    setCompletingCount(true)
    setError('')
    setSuccess('')

    try {
      await requestJson(
        `/api/inventory/stock-counts/${encodeURIComponent(
          detail.stockCount.id,
        )}/complete`,
        {
          method: 'POST',
        },
      )

      setSuccess(
        `تم اعتماد الجرد ${detail.stockCount.count_number} وتحديث المخزون.`,
      )

      await Promise.all([
        loadStockCounts(),
        loadStockCountDetail(detail.stockCount.id),
      ])
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر اعتماد جلسة الجرد.',
      )
    } finally {
      setCompletingCount(false)
    }
  }

  // إلغاء جلسة Draft بدون تعديل المخزون.
  async function cancelStockCount() {
    if (!detail) {
      return
    }

    const confirmed = window.confirm(
      `هل تريد إلغاء جلسة الجرد ${detail.stockCount.count_number}؟ ` +
        'لن يتم تعديل أي رصيد مخزون.',
    )

    if (!confirmed) {
      return
    }

    setCancellingCount(true)
    setError('')
    setSuccess('')

    try {
      await requestJson(
        `/api/inventory/stock-counts/${encodeURIComponent(
          detail.stockCount.id,
        )}/cancel`,
        {
          method: 'POST',
        },
      )

      setSuccess(`تم إلغاء جلسة الجرد ${detail.stockCount.count_number}.`)

      await Promise.all([
        loadStockCounts(),
        loadStockCountDetail(detail.stockCount.id),
      ])
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر إلغاء جلسة الجرد.',
      )
    } finally {
      setCancellingCount(false)
    }
  }

  // البحث داخل أصناف جلسة الجرد الحالية.
  const visibleItems = useMemo(() => {
    const normalizedSearch = itemSearch.trim().toLowerCase()

    if (!detail || !normalizedSearch) {
      return detail?.items ?? []
    }

    return detail.items.filter((item) => {
      const searchableValues = [
        item.product_name,
        item.sku,
        item.primary_barcode,
        item.size_name,
        item.color_name,
      ]

      return searchableValues.some(
        (value) =>
          typeof value === 'string' &&
          value.toLowerCase().includes(normalizedSearch),
      )
    })
  }, [detail, itemSearch])

  useEffect(() => {
    if (!companyId) {
      return
    }

    void loadStockLocations()
  }, [companyId, branchId])

  useEffect(() => {
    if (!companyId) {
      return
    }

    void loadStockCounts()
  }, [companyId, branchId, statusFilter, locationFilter])

  return (
    <div className="stock-count-page">
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>جلسات جرد المخزون</h2>

            <p className="muted">
              افتح جلسة جرد، أدخل الكميات الفعلية، ثم راجع الفروق واعتمدها.
            </p>
          </div>

          <button
            type="button"
            className="table-button"
            disabled={loadingCounts}
            onClick={() => void loadStockCounts()}
          >
            {loadingCounts ? 'جاري التحديث...' : 'تحديث القائمة'}
          </button>
        </div>

        {error ? <p className="error-message">{error}</p> : null}
        {success ? <p className="success-message">{success}</p> : null}
      </section>

      {canAdjustInventory ? (
        <section className="panel">
          <div className="section-header">
            <div>
              <h2>فتح جلسة جرد جديدة</h2>

              <p className="muted">
                سيتم حفظ الرصيد الحالي كرصيد متوقع وقت فتح الجلسة.
              </p>
            </div>
          </div>

          <div className="form-grid stock-count-opening-grid">
            <label>
              مكان التخزين
              <select
                value={newStockLocationId}
                disabled={loadingLocations || openingCount}
                onChange={(event) => {
                  setNewStockLocationId(event.target.value)
                  resetOpeningRequest()
                }}
              >
                <option value="">
                  {loadingLocations
                    ? 'جاري تحميل الأماكن...'
                    : 'اختر مكان التخزين'}
                </option>

                {stockLocations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name} ({location.code}) -{' '}
                    {translateLocationType(location.location_type)}
                  </option>
                ))}
              </select>
            </label>

            <label>
              ملاحظات الجرد
              <input
                value={newNotes}
                maxLength={500}
                disabled={openingCount}
                placeholder="مثال: جرد نهاية الشهر"
                onChange={(event) => {
                  setNewNotes(event.target.value)
                  resetOpeningRequest()
                }}
              />
            </label>

            <button
              type="button"
              className="primary-button stock-count-open-button"
              disabled={!newStockLocationId || openingCount}
              onClick={() => void openStockCount()}
            >
              {openingCount ? 'جاري فتح الجرد...' : 'فتح جلسة الجرد'}
            </button>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="section-header">
          <div>
            <h2>سجل جلسات الجرد</h2>

            <p className="muted">
              اختر جلسة لعرض الأصناف وإدخال أو مراجعة الكميات.
            </p>
          </div>
        </div>

        <div className="form-grid stock-count-filter-grid">
          <label>
            الحالة
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">كل الحالات</option>
              <option value="draft">مفتوح</option>
              <option value="completed">مكتمل</option>
              <option value="cancelled">ملغي</option>
            </select>
          </label>

          <label>
            مكان التخزين
            <select
              value={locationFilter}
              onChange={(event) => setLocationFilter(event.target.value)}
            >
              <option value="">كل أماكن التخزين</option>

              {stockLocations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name} ({location.code})
                </option>
              ))}
            </select>
          </label>
        </div>

        {stockCounts.length === 0 ? (
          <p className="muted stock-count-empty">
            {loadingCounts
              ? 'جاري تحميل جلسات الجرد...'
              : 'لا توجد جلسات جرد مطابقة.'}
          </p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>رقم الجرد</th>
                  <th>مكان التخزين</th>
                  <th>الحالة</th>
                  <th>الأصناف</th>
                  <th>تم عدها</th>
                  <th>بها فروق</th>
                  <th>تاريخ الفتح</th>
                  <th></th>
                </tr>
              </thead>

              <tbody>
                {stockCounts.map((stockCount) => (
                  <tr
                    key={stockCount.id}
                    className={
                      stockCount.id === selectedStockCountId
                        ? 'stock-count-row-selected'
                        : undefined
                    }
                  >
                    <td>
                      <strong>{stockCount.count_number}</strong>
                    </td>

                    <td>
                      {stockCount.stock_location_name}
                      <small className="stock-count-cell-note">
                        {stockCount.stock_location_code}
                      </small>
                    </td>

                    <td>
                      <span
                        className={getStockCountStatusClass(stockCount.status)}
                      >
                        {translateStockCountStatus(stockCount.status)}
                      </span>
                    </td>

                    <td>{stockCount.item_count}</td>
                    <td>{stockCount.counted_item_count}</td>
                    <td>{stockCount.difference_item_count}</td>
                    <td>{formatDateTime(stockCount.created_at)}</td>

                    <td>
                      <button
                        type="button"
                        className="table-button"
                        onClick={() => {
                          setSelectedStockCountId(stockCount.id)
                          setItemSearch('')

                          void loadStockCountDetail(stockCount.id)
                        }}
                      >
                        فتح
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {loadingDetail ? (
        <section className="panel">
          <p className="muted">جاري تحميل تفاصيل الجرد...</p>
        </section>
      ) : null}

      {detail && detailMeta && !loadingDetail ? (
        <>
          <section className="panel">
            <div className="section-header">
              <div>
                <div className="stock-count-title-row">
                  <h2>{detail.stockCount.count_number}</h2>

                  <span
                    className={getStockCountStatusClass(
                      detail.stockCount.status,
                    )}
                  >
                    {translateStockCountStatus(detail.stockCount.status)}
                  </span>
                </div>

                <p className="muted">
                  {detail.stockCount.stock_location_name} ·{' '}
                  {formatDateTime(detail.stockCount.created_at)}
                </p>
              </div>

              {detail.stockCount.status === 'draft' && canAdjustInventory ? (
                <div className="stock-count-actions">
                  <button
                    type="button"
                    className="table-button danger-button"
                    disabled={cancellingCount || completingCount}
                    onClick={() => void cancelStockCount()}
                  >
                    {cancellingCount ? 'جاري الإلغاء...' : 'إلغاء الجرد'}
                  </button>

                  <button
                    type="button"
                    className="primary-button small-button"
                    disabled={
                      detailMeta.remainingItemCount > 0 ||
                      cancellingCount ||
                      completingCount
                    }
                    onClick={() => void completeStockCount()}
                  >
                    {completingCount ? 'جاري الاعتماد...' : 'اعتماد الجرد'}
                  </button>
                </div>
              ) : null}
            </div>

            {detail.stockCount.notes ? (
              <p className="stock-count-notes">{detail.stockCount.notes}</p>
            ) : null}

            <div className="mini-cards-grid stock-count-summary-grid">
              <article className="mini-card">
                <span>إجمالي الأصناف</span>
                <strong>{detailMeta.itemCount}</strong>
              </article>

              <article className="mini-card">
                <span>تم عدها</span>
                <strong>{detailMeta.countedItemCount}</strong>
              </article>

              <article className="mini-card">
                <span>متبقي</span>
                <strong>{detailMeta.remainingItemCount}</strong>
              </article>

              <article className="mini-card">
                <span>أصناف بها فروق</span>
                <strong>{detailMeta.differenceItemCount}</strong>
              </article>
            </div>

            {detail.stockCount.status === 'completed' ? (
              <p className="success-message">
                تم اعتماد الجرد بواسطة{' '}
                {detail.stockCount.completed_by_name || '-'} في{' '}
                {formatDateTime(detail.stockCount.completed_at)}.
              </p>
            ) : null}

            {detail.stockCount.status === 'cancelled' ? (
              <p className="error-message">
                تم إلغاء الجرد بواسطة{' '}
                {detail.stockCount.cancelled_by_name || '-'} في{' '}
                {formatDateTime(detail.stockCount.cancelled_at)}.
              </p>
            ) : null}
          </section>

          <section className="panel">
            <div className="section-header">
              <div>
                <h2>أصناف الجرد</h2>

                <p className="muted">
                  الرصيد المتوقع هو الرصيد المسجل وقت فتح الجلسة.
                </p>
              </div>

              <label className="stock-count-search">
                بحث داخل الجرد
                <input
                  value={itemSearch}
                  placeholder="اسم، SKU، باركود، مقاس أو لون"
                  onChange={(event) => setItemSearch(event.target.value)}
                />
              </label>
            </div>

            {visibleItems.length === 0 ? (
              <p className="muted stock-count-empty">
                لا توجد أصناف مطابقة للبحث.
              </p>
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>الصنف</th>
                      <th>SKU / Barcode</th>
                      <th>المقاس</th>
                      <th>اللون</th>
                      <th>الرصيد المتوقع</th>
                      <th>الكمية الفعلية</th>
                      <th>الفرق</th>
                      <th></th>
                    </tr>
                  </thead>

                  <tbody>
                    {visibleItems.map((item) => {
                      const draftValue = quantityDrafts[item.id] ?? ''

                      const numericDraft = Number(draftValue)

                      const previewDifference =
                        draftValue.trim() && Number.isFinite(numericDraft)
                          ? numericDraft - Number(item.expected_quantity)
                          : null

                      return (
                        <tr key={item.id}>
                          <td>
                            <strong>{item.product_name}</strong>
                          </td>

                          <td>
                            {item.sku}

                            <small className="stock-count-cell-note">
                              {item.primary_barcode || '-'}
                            </small>
                          </td>

                          <td>{item.size_name || '-'}</td>
                          <td>{item.color_name || '-'}</td>

                          <td>{formatQuantity(item.expected_quantity)}</td>

                          <td>
                            {detail.stockCount.status === 'draft' &&
                            canAdjustInventory ? (
                              <input
                                className="stock-count-quantity-input"
                                type="number"
                                min="0"
                                step="0.001"
                                value={draftValue}
                                disabled={savingItemId === item.id}
                                onChange={(event) => {
                                  setQuantityDrafts((currentDrafts) => ({
                                    ...currentDrafts,
                                    [item.id]: event.target.value,
                                  }))

                                  setSuccess('')
                                }}
                              />
                            ) : (
                              formatQuantity(item.counted_quantity)
                            )}
                          </td>

                          <td>
                            <strong
                              className={
                                previewDifference === null ||
                                previewDifference === 0
                                  ? ''
                                  : previewDifference > 0
                                    ? 'stock-count-difference-positive'
                                    : 'stock-count-difference-negative'
                              }
                            >
                              {previewDifference === null
                                ? '-'
                                : `${previewDifference > 0 ? '+' : ''}${formatQuantity(
                                    previewDifference,
                                  )}`}
                            </strong>
                          </td>

                          <td>
                            {detail.stockCount.status === 'draft' &&
                            canAdjustInventory ? (
                              <button
                                type="button"
                                className="table-button"
                                disabled={
                                  !draftValue.trim() || savingItemId === item.id
                                }
                                onClick={() => void saveCountedQuantity(item)}
                              >
                                {savingItemId === item.id
                                  ? 'جاري الحفظ...'
                                  : 'حفظ'}
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  )
}

export default StockCountsPage
