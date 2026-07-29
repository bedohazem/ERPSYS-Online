import { useEffect, useState } from 'react'

import { requestJson } from '../lib/http'

type StockLocation = {
  id: string
  code: string
  name: string
  location_type: string
}

type ItemCardBalance = {
  id: string
  branch_name: string | null

  stock_location_id: string
  stock_location_code: string
  stock_location_name: string
  location_type: string

  quantity: string
  updated_at: string
}

type ItemCardMovement = {
  id: string
  branch_name: string | null

  stock_location_code: string
  stock_location_name: string

  movement_type: string

  quantity: string
  quantity_before: string | null
  quantity_after: string | null

  reference_type: string | null
  reference_id: string | null

  note: string | null
  created_by_name: string | null
  created_at: string
}

type ItemCardResponse = {
  data: {
    item: {
      variant_id: string
      product_id: string
      product_name: string

      product_status: string
      variant_status: string

      sku: string
      primary_barcode: string | null

      size_name: string | null
      color_name: string | null
      category_name: string | null
      brand_name: string | null
    }

    balances: ItemCardBalance[]
    movements: ItemCardMovement[]

    summary: {
      currentQuantity: string
      locationCount: number
      movementCount: number
      inboundQuantity: string
      outboundQuantity: string
      netQuantity: string
    }
  }
}

type LocationsResponse = {
  data: StockLocation[]
}

const quantityFormatter = new Intl.NumberFormat('ar-EG', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
})

const dateFormatter = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatQuantity(value: string | number | null) {
  if (value === null) {
    return '-'
  }

  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? quantityFormatter.format(numericValue)
    : '-'
}

function formatSignedQuantity(value: string | number) {
  const numericValue = Number(value)

  if (!Number.isFinite(numericValue)) {
    return '-'
  }

  const sign = numericValue > 0 ? '+' : ''

  return `${sign}${quantityFormatter.format(numericValue)}`
}

function formatDate(value: string) {
  const parsedDate = new Date(value)

  return Number.isNaN(parsedDate.getTime())
    ? '-'
    : dateFormatter.format(parsedDate)
}

// ترجمة أنواع حركات المخزون المسجلة في PostgreSQL.
function translateMovementType(movementType: string) {
  const labels: Record<string, string> = {
    purchase: 'شراء',
    sale: 'بيع',
    return: 'مرتجع',
    exchange: 'استبدال',
    transfer_in: 'تحويل وارد',
    transfer_out: 'تحويل صادر',
    adjustment: 'تسوية',
    damage: 'تالف',
    stock_count: 'جرد',
  }

  return labels[movementType] || movementType
}

function InventoryItemCardPage() {
  const [locations, setLocations] = useState<StockLocation[]>([])

  const [code, setCode] = useState('')
  const [stockLocationId, setStockLocationId] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const [result, setResult] = useState<ItemCardResponse['data'] | null>(null)

  const [loading, setLoading] = useState(false)
  const [loadingLocations, setLoadingLocations] = useState(false)

  const [error, setError] = useState('')

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

  // تحميل كارت الصنف من الـBackend.
  // الواجهة لا ترسل companyId أو branchId.
  async function loadItemCard() {
    const normalizedCode = code.trim()

    if (!normalizedCode) {
      setError('اكتب SKU أو باركود الصنف.')
      return
    }

    if (dateFrom && dateTo && dateFrom > dateTo) {
      setError('تاريخ البداية لا يمكن أن يكون بعد تاريخ النهاية.')
      return
    }

    setLoading(true)
    setError('')

    try {
      const query = new URLSearchParams({
        code: normalizedCode,
        limit: '500',
      })

      if (stockLocationId) {
        query.set('stockLocationId', stockLocationId)
      }

      if (dateFrom) {
        query.set('dateFrom', dateFrom)
      }

      if (dateTo) {
        query.set('dateTo', dateTo)
      }

      const response = await requestJson<ItemCardResponse>(
        `/api/inventory/item-card?${query.toString()}`,
      )

      setResult(response.data)
    } catch (currentError) {
      setResult(null)

      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل كارت حركة الصنف.',
      )
    } finally {
      setLoading(false)
    }
  }

  function resetFilters() {
    setCode('')
    setStockLocationId('')
    setDateFrom('')
    setDateTo('')
    setResult(null)
    setError('')
  }

  useEffect(() => {
    void loadLocations()
  }, [])

  return (
    <div>
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>كارت حركة صنف</h2>

            <p className="muted">
              اعرض الرصيد الحالي وسجل حركات صنف باستخدام SKU أو الباركود.
            </p>
          </div>
        </div>

        {error ? <p className="error-message">{error}</p> : null}

        <div className="form-grid">
          <label>
            SKU أو الباركود
            <input
              value={code}
              placeholder="امسح الباركود أو اكتب SKU"
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void loadItemCard()
                }
              }}
            />
          </label>

          <label>
            مكان التخزين
            <select
              value={stockLocationId}
              disabled={loadingLocations}
              onChange={(event) => setStockLocationId(event.target.value)}
            >
              <option value="">كل أماكن التخزين</option>

              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name} ({location.code})
                </option>
              ))}
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

          <button
            type="button"
            className="primary-button small-button"
            disabled={loading}
            onClick={() => void loadItemCard()}
          >
            {loading ? 'جاري التحميل...' : 'عرض كارت الصنف'}
          </button>

          <button
            type="button"
            className="table-button"
            disabled={loading}
            onClick={resetFilters}
          >
            مسح
          </button>
        </div>
      </section>

      {result ? (
        <>
          <section className="panel">
            <div className="section-header">
              <div>
                <h2>{result.item.product_name}</h2>

                <p className="muted">
                  SKU: {result.item.sku}
                  {' · '}
                  Barcode: {result.item.primary_barcode || '-'}
                </p>
              </div>
            </div>

            <div className="mini-cards-grid stock-count-summary-grid">
              <article className="mini-card">
                <span>الرصيد الحالي</span>
                <strong>
                  {formatQuantity(result.summary.currentQuantity)}
                </strong>
              </article>

              <article className="mini-card">
                <span>إجمالي الداخل</span>
                <strong>
                  {formatQuantity(result.summary.inboundQuantity)}
                </strong>
              </article>

              <article className="mini-card">
                <span>إجمالي الخارج</span>
                <strong>
                  {formatQuantity(result.summary.outboundQuantity)}
                </strong>
              </article>

              <article className="mini-card">
                <span>صافي الحركة</span>
                <strong>
                  {formatSignedQuantity(result.summary.netQuantity)}
                </strong>
              </article>

              <article className="mini-card">
                <span>عدد الحركات</span>
                <strong>{result.summary.movementCount}</strong>
              </article>
            </div>

            <p className="muted">
              المقاس: {result.item.size_name || '-'}
              {' · '}
              اللون: {result.item.color_name || '-'}
              {' · '}
              البراند: {result.item.brand_name || '-'}
              {' · '}
              القسم: {result.item.category_name || '-'}
            </p>
          </section>

          <section className="panel">
            <div className="section-header">
              <div>
                <h2>الأرصدة الحالية</h2>

                <p className="muted">
                  عدد الأماكن التي تحتوي على رصيد:{' '}
                  {result.summary.locationCount}
                </p>
              </div>
            </div>

            {result.balances.length === 0 ? (
              <p className="muted">لا يوجد رصيد حالي للصنف.</p>
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>مكان التخزين</th>
                      <th>الفرع</th>
                      <th>نوع المكان</th>
                      <th>الكمية</th>
                      <th>آخر تحديث</th>
                    </tr>
                  </thead>

                  <tbody>
                    {result.balances.map((balance) => (
                      <tr key={balance.id}>
                        <td>
                          {balance.stock_location_name}

                          <small className="stock-count-cell-note">
                            {balance.stock_location_code}
                          </small>
                        </td>

                        <td>{balance.branch_name || 'مركزي'}</td>
                        <td>{balance.location_type}</td>

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

          <section className="panel">
            <div className="section-header">
              <div>
                <h2>سجل الحركات</h2>

                <p className="muted">الحركات مرتبة من الأحدث إلى الأقدم.</p>
              </div>
            </div>

            {result.movements.length === 0 ? (
              <p className="muted">لا توجد حركات مطابقة للفترة والفلاتر.</p>
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>التاريخ</th>
                      <th>الحركة</th>
                      <th>مكان التخزين</th>
                      <th>قبل</th>
                      <th>الكمية</th>
                      <th>بعد</th>
                      <th>المرجع</th>
                      <th>بواسطة</th>
                    </tr>
                  </thead>

                  <tbody>
                    {result.movements.map((movement) => (
                      <tr key={movement.id}>
                        <td>{formatDate(movement.created_at)}</td>

                        <td>{translateMovementType(movement.movement_type)}</td>

                        <td>
                          {movement.stock_location_name}

                          <small className="stock-count-cell-note">
                            {movement.stock_location_code}
                          </small>
                        </td>

                        <td>{formatQuantity(movement.quantity_before)}</td>

                        <td>
                          <strong>
                            {formatSignedQuantity(movement.quantity)}
                          </strong>
                        </td>

                        <td>{formatQuantity(movement.quantity_after)}</td>

                        <td>
                          {movement.reference_type || '-'}

                          {movement.note ? (
                            <small className="stock-count-cell-note">
                              {movement.note}
                            </small>
                          ) : null}
                        </td>

                        <td>{movement.created_by_name || '-'}</td>
                      </tr>
                    ))}
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

export default InventoryItemCardPage
