import { useEffect, useMemo, useState } from 'react'

import { useAuth } from '../auth/AuthContext'
import { requestJson } from '../lib/http'

type ConditionType = 'condition' | 'damaged' | 'inspection'

type StockLocation = {
  id: string
  branch_id: string | null
  code: string
  name: string
  location_type: string
}

type ConditionBalance = {
  id: string
  branch_id: string | null
  branch_name: string | null

  stock_location_id: string
  stock_location_name: string
  stock_location_code: string
  location_type: 'damaged' | 'inspection'

  variant_id: string
  product_name: string
  sku: string
  primary_barcode: string | null

  size_name: string | null
  color_name: string | null

  quantity: string
  updated_at: string
}

type ConditionBalancesResponse = {
  data: ConditionBalance[]

  meta: {
    limit: number
    filteredCount: number
    filteredQuantity: string
    damagedQuantity: string
    inspectionQuantity: string
    branchSelectionLocked: boolean
  }
}

type LocationsResponse = {
  data: StockLocation[]
}

type InventoryConditionsPageProps = {
  onOpenTransfers: () => void
}

const quantityFormatter = new Intl.NumberFormat('ar-EG', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
})

const dateFormatter = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

// تنسيق كميات المخزون القادمة من PostgreSQL.
function formatQuantity(value: string | number) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? quantityFormatter.format(numericValue)
    : '-'
}

// ترجمة نوع مكان التخزين إلى وصف واضح للمستخدم.
function translateConditionType(locationType: string) {
  if (locationType === 'damaged') {
    return 'مخزون تالف'
  }

  if (locationType === 'inspection') {
    return 'تحت الفحص'
  }

  return locationType
}

function formatDate(value: string) {
  const parsedDate = new Date(value)

  return Number.isNaN(parsedDate.getTime())
    ? '-'
    : dateFormatter.format(parsedDate)
}

function InventoryConditionsPage({
  onOpenTransfers,
}: InventoryConditionsPageProps) {
  const { user } = useAuth()

  const [locations, setLocations] = useState<StockLocation[]>([])
  const [balances, setBalances] = useState<ConditionBalance[]>([])

  const [conditionType, setConditionType] = useState<ConditionType>('condition')

  const [stockLocationId, setStockLocationId] = useState('')
  const [searchDraft, setSearchDraft] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')

  const [meta, setMeta] = useState<ConditionBalancesResponse['meta']>({
    limit: 200,
    filteredCount: 0,
    filteredQuantity: '0',
    damagedQuantity: '0',
    inspectionQuantity: '0',
    branchSelectionLocked: false,
  })

  const [loading, setLoading] = useState(false)
  const [loadingLocations, setLoadingLocations] = useState(false)
  const [error, setError] = useState('')

  const isAdmin = user?.roles.includes('admin') ?? false

  const canCreateTransfer =
    isAdmin || user?.permissions.includes('inventory.transfer.create') || false

  // نظهر فقط أماكن التالف والفحص؛ باقي الأماكن تدار من شاشة المخزون.
  const conditionLocations = useMemo(
    () =>
      locations.filter((location) => {
        if (!['damaged', 'inspection'].includes(location.location_type)) {
          return false
        }

        if (conditionType === 'condition') {
          return true
        }

        return location.location_type === conditionType
      }),
    [locations, conditionType],
  )

  async function loadLocations() {
    setLoadingLocations(true)

    try {
      const response = await requestJson<LocationsResponse>(
        '/api/inventory/stock-locations',
      )

      setLocations(response.data)
    } catch (currentError) {
      setLocations([])

      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل أماكن التخزين.',
      )
    } finally {
      setLoadingLocations(false)
    }
  }

  // تحميل أرصدة التالف والفحص من PostgreSQL من خلال الـBackend فقط.
  async function loadConditionBalances() {
    setLoading(true)
    setError('')

    try {
      const query = new URLSearchParams({
        locationType: conditionType,
        positiveOnly: 'true',
        limit: '200',
      })

      if (stockLocationId) {
        query.set('stockLocationId', stockLocationId)
      }

      if (appliedSearch) {
        query.set('search', appliedSearch)
      }

      const response = await requestJson<ConditionBalancesResponse>(
        `/api/inventory/stock-balances?${query.toString()}`,
      )

      setBalances(response.data)
      setMeta(response.meta)
    } catch (currentError) {
      setBalances([])

      setMeta((currentMeta) => ({
        ...currentMeta,
        filteredCount: 0,
        filteredQuantity: '0',
        damagedQuantity: '0',
        inspectionQuantity: '0',
      }))

      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل مخزون التالف وتحت الفحص.',
      )
    } finally {
      setLoading(false)
    }
  }

  function applySearch() {
    setAppliedSearch(searchDraft.trim())
  }

  function resetFilters() {
    setConditionType('condition')
    setStockLocationId('')
    setSearchDraft('')
    setAppliedSearch('')
  }

  useEffect(() => {
    void loadLocations()
  }, [])

  useEffect(() => {
    // لو مكان التخزين المختار لم يعد مناسبًا لنوع الفلتر،
    // نلغي اختياره بدل إرسال فلتر متناقض للـBackend.
    if (
      stockLocationId &&
      !conditionLocations.some((location) => location.id === stockLocationId)
    ) {
      setStockLocationId('')
      return
    }

    void loadConditionBalances()
  }, [conditionType, stockLocationId, appliedSearch, conditionLocations])

  return (
    <div>
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>المخزون التالف وتحت الفحص</h2>

            <p className="muted">
              متابعة الكميات المعزولة عن مخزون البيع. نقل الأصناف يتم من خلال
              دورة تحويلات المخزون الحالية.
            </p>
          </div>

          <div className="stock-count-actions">
            <button
              type="button"
              className="table-button"
              disabled={loading}
              onClick={() => void loadConditionBalances()}
            >
              {loading ? 'جاري التحديث...' : 'تحديث'}
            </button>

            {canCreateTransfer ? (
              <button
                type="button"
                className="primary-button small-button"
                onClick={onOpenTransfers}
              >
                إنشاء تحويل مخزون
              </button>
            ) : null}
          </div>
        </div>

        {error ? <p className="error-message">{error}</p> : null}
      </section>

      <section className="mini-cards-grid stock-count-summary-grid">
        <article className="mini-card">
          <span>إجمالي السجلات</span>
          <strong>{meta.filteredCount}</strong>
        </article>

        <article className="mini-card">
          <span>إجمالي الكمية</span>
          <strong>{formatQuantity(meta.filteredQuantity)}</strong>
        </article>

        <article className="mini-card">
          <span>تحت الفحص</span>
          <strong>{formatQuantity(meta.inspectionQuantity)}</strong>
        </article>

        <article className="mini-card">
          <span>تالف</span>
          <strong>{formatQuantity(meta.damagedQuantity)}</strong>
        </article>
      </section>

      <section className="panel">
        <div className="section-header">
          <div>
            <h2>الفلاتر</h2>
            <p className="muted">ابحث بالاسم أو SKU أو الباركود.</p>
          </div>
        </div>

        <div className="form-grid">
          <label>
            حالة المخزون
            <select
              value={conditionType}
              onChange={(event) => {
                setConditionType(event.target.value as ConditionType)
              }}
            >
              <option value="condition">التالف وتحت الفحص</option>
              <option value="inspection">تحت الفحص فقط</option>
              <option value="damaged">التالف فقط</option>
            </select>
          </label>

          <label>
            مكان التخزين
            <select
              value={stockLocationId}
              disabled={loadingLocations}
              onChange={(event) => setStockLocationId(event.target.value)}
            >
              <option value="">كل الأماكن</option>

              {conditionLocations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name} ({location.code})
                </option>
              ))}
            </select>
          </label>

          <label>
            البحث
            <input
              value={searchDraft}
              placeholder="اسم، SKU أو باركود"
              onChange={(event) => setSearchDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  applySearch()
                }
              }}
            />
          </label>

          <button
            type="button"
            className="primary-button small-button"
            onClick={applySearch}
          >
            بحث
          </button>

          <button type="button" className="table-button" onClick={resetFilters}>
            مسح الفلاتر
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="section-header">
          <div>
            <h2>الأرصدة الحالية</h2>

            <p className="muted">
              هذه الكميات جزء من مخزون الشركة، لكنها غير متاحة للبيع من مواقع
              التالف أو الفحص.
            </p>
          </div>
        </div>

        {balances.length === 0 ? (
          <p className="muted">
            {loading ? 'جاري تحميل الأرصدة...' : 'لا توجد أرصدة مطابقة.'}
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
                  <th>الحالة</th>
                  <th>مكان التخزين</th>
                  <th>الفرع</th>
                  <th>الكمية</th>
                  <th>آخر تحديث</th>
                </tr>
              </thead>

              <tbody>
                {balances.map((balance) => (
                  <tr key={balance.id}>
                    <td>
                      <strong>{balance.product_name}</strong>
                    </td>

                    <td>
                      {balance.sku}
                      <small className="stock-count-cell-note">
                        {balance.primary_barcode || '-'}
                      </small>
                    </td>

                    <td>{balance.size_name || '-'}</td>
                    <td>{balance.color_name || '-'}</td>

                    <td>{translateConditionType(balance.location_type)}</td>

                    <td>
                      {balance.stock_location_name}
                      <small className="stock-count-cell-note">
                        {balance.stock_location_code}
                      </small>
                    </td>

                    <td>{balance.branch_name || 'مركزي'}</td>

                    <td>
                      <strong>{formatQuantity(balance.quantity)}</strong>
                    </td>

                    <td>{formatDate(balance.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

export default InventoryConditionsPage
