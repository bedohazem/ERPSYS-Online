import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import InventoryAdjustmentPanel from '../components/InventoryAdjustmentPanel'
// requestJson مسؤول عن إضافة عنوان السيرفر تلقائيًا.
import { requestJson } from '../lib/http'

type StockBalance = {
  id: string
  company_id: string
  branch_id: string
  stock_location_id: string
  stock_location_name: string
  stock_location_code: string
  location_type: string
  variant_id: string
  sku: string
  primary_barcode: string | null
  product_name: string
  size_name: string | null
  color_name: string | null
  quantity: string
  updated_at: string
}

type StockMovement = {
  id: string
  company_id: string
  branch_id: string | null
  branch_name: string | null
  stock_location_id: string
  stock_location_name: string
  stock_location_code: string
  variant_id: string
  sku: string
  primary_barcode: string | null
  product_name: string
  size_name: string | null
  color_name: string | null
  movement_type: string
  quantity: string
  quantity_before: string
  quantity_after: string
  reference_type: string | null
  reference_id: string | null
  note: string | null
  created_at: string
}

type StockLocation = {
  id: string
  branch_id: string | null
  code: string
  name: string
  location_type: string
  is_active: boolean
}

type InventoryLookupItem = {
  variant_id: string
  product_name: string
  sku: string
  primary_barcode: string | null
  size_name: string | null
  color_name: string | null
  current_quantity: string
  stock_location_id: string
  stock_location_name: string
}

type OpeningBalanceResponse = {
  balance: {
    quantity: string
  }
  item: {
    product_name: string
    sku: string
    stock_location_name: string
  }
}

type ApiResponse<T> = {
  data: T
}

// ======================================================
// تنسيق كميات وتواريخ المخزون.
// ======================================================
const inventoryQuantityFormatter = new Intl.NumberFormat('ar-EG', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
})

const inventoryDateTimeFormatter = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatInventoryQuantity(value: number | string) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? inventoryQuantityFormatter.format(numericValue)
    : '-'
}

function formatInventoryDateTime(value: string) {
  const parsedDate = new Date(value)

  return Number.isNaN(parsedDate.getTime())
    ? '-'
    : inventoryDateTimeFormatter.format(parsedDate)
}

// ======================================================
// ترجمة أنواع أماكن التخزين المعرفة في قاعدة البيانات.
// ======================================================
function translateLocationType(locationType: string) {
  const locationLabels: Record<string, string> = {
    main_warehouse: 'المخزن الرئيسي',
    branch_warehouse: 'مخزن الفرع',
    sales_floor: 'صالة البيع',
    returns: 'مخزن المرتجعات',
    damaged: 'مخزن التالف',
    inspection: 'منطقة الفحص',
  }

  return locationLabels[locationType] || locationType
}

// ======================================================
// ترجمة أنواع حركات المخزون المعرفة في قاعدة البيانات.
// ======================================================
function translateInventoryMovement(movementType: string) {
  const movementLabels: Record<string, string> = {
    purchase: 'شراء',
    sale: 'بيع',
    return: 'مرتجع',
    exchange: 'استبدال',
    transfer_in: 'تحويل وارد',
    transfer_out: 'تحويل صادر',
    adjustment: 'تسوية',
    damage: 'تالف',
    stock_count: 'جرد مخزون',
  }

  return movementLabels[movementType] || movementType
}

function getInventoryMovementBadgeClass(quantity: number | string) {
  const numericQuantity = Number(quantity)

  if (numericQuantity > 0) {
    return 'movement-badge movement-badge-in'
  }

  if (numericQuantity < 0) {
    return 'movement-badge movement-badge-out'
  }

  return 'movement-badge'
}

function translateInventoryReference(referenceType: string | null) {
  if (!referenceType) {
    return '-'
  }

  const referenceLabels: Record<string, string> = {
    sale: 'فاتورة بيع',
    return: 'مرتجع',
    exchange: 'استبدال',
    purchase: 'شراء',
    transfer: 'تحويل',
    adjustment: 'تسوية',
    inventory_adjustment: 'تسوية مخزون',
    stock_count: 'جرد مخزون',
    damage: 'تالف',
  }

  return referenceLabels[referenceType] || referenceType
}

type InventoryPageProps = {
  companyId: string
  branchId: string
}

function InventoryPage({ companyId, branchId }: InventoryPageProps) {
  const [stockBalances, setStockBalances] = useState<StockBalance[]>([])
  const [stockMovements, setStockMovements] = useState<StockMovement[]>([])

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [stockLocations, setStockLocations] = useState<StockLocation[]>([])

  const [openingStockLocationId, setOpeningStockLocationId] = useState('')

  const [openingCode, setOpeningCode] = useState('')
  const [openingItem, setOpeningItem] = useState<InventoryLookupItem | null>(
    null,
  )

  const [openingQuantity, setOpeningQuantity] = useState(1)

  const [openingNote, setOpeningNote] = useState('')

  const [loadingLocations, setLoadingLocations] = useState(false)

  const [loadingOpeningLookup, setLoadingOpeningLookup] = useState(false)

  const [savingOpeningBalance, setSavingOpeningBalance] = useState(false)

  const [success, setSuccess] = useState('')

  const openingLookupRequestRef = useRef(false)
  const openingSaveRequestRef = useRef(false)

  // ======================================================
  // مؤشرات مختصرة محسوبة من البيانات المحملة حاليًا.
  // ======================================================
  const inventorySummary = useMemo(() => {
    const totalQuantity = stockBalances.reduce((currentTotal, balance) => {
      const balanceQuantity = Number(balance.quantity)

      return (
        currentTotal + (Number.isFinite(balanceQuantity) ? balanceQuantity : 0)
      )
    }, 0)

    const locationIds = new Set(
      stockBalances.map((balance) => balance.stock_location_id),
    )

    return {
      balancesCount: stockBalances.length,
      totalQuantity,
      locationsCount: locationIds.size,
      movementsCount: stockMovements.length,
    }
  }, [stockBalances, stockMovements])

  const { user } = useAuth()

  const canViewInventory =
    user?.roles.includes('admin') ||
    user?.permissions.includes('inventory.view') ||
    false

  const canAdjustInventory =
    user?.roles.includes('admin') ||
    user?.permissions.includes('inventory.adjust') ||
    false

  async function loadStockLocations() {
    setLoadingLocations(true)
    setError('')

    try {
      const selectedCompanyId = companyId.trim()
      const selectedBranchId = branchId.trim()

      const locationsUrl =
        `/api/inventory/stock-locations` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}` +
        (selectedBranchId
          ? `&branchId=${encodeURIComponent(selectedBranchId)}`
          : '')

      const response =
        await requestJson<ApiResponse<StockLocation[]>>(locationsUrl)

      setStockLocations(response.data)

      setOpeningStockLocationId((currentLocationId) => {
        const stillExists = response.data.some(
          (location) => location.id === currentLocationId,
        )

        return stillExists ? currentLocationId : (response.data[0]?.id ?? '')
      })
    } catch (currentError) {
      setStockLocations([])
      setOpeningStockLocationId('')

      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل أماكن التخزين.',
      )
    } finally {
      setLoadingLocations(false)
    }
  }

  async function lookupOpeningBalanceItem() {
    if (openingLookupRequestRef.current) {
      return
    }

    openingLookupRequestRef.current = true
    setLoadingOpeningLookup(true)
    setError('')
    setSuccess('')
    setOpeningItem(null)

    try {
      if (!openingStockLocationId) {
        throw new Error('اختر مكان التخزين أولًا.')
      }

      if (!openingCode.trim()) {
        throw new Error('اكتب باركود أو SKU الصنف.')
      }

      const lookupUrl =
        `/api/inventory/lookup-item` +
        `?companyId=${encodeURIComponent(companyId.trim())}` +
        `&stockLocationId=${encodeURIComponent(openingStockLocationId)}` +
        `&code=${encodeURIComponent(openingCode.trim())}`

      const response =
        await requestJson<ApiResponse<InventoryLookupItem>>(lookupUrl)

      setOpeningItem(response.data)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر العثور على الصنف.',
      )
    } finally {
      openingLookupRequestRef.current = false
      setLoadingOpeningLookup(false)
    }
  }

  async function saveOpeningBalance() {
    if (openingSaveRequestRef.current) {
      return
    }

    openingSaveRequestRef.current = true
    setSavingOpeningBalance(true)
    setError('')
    setSuccess('')

    try {
      if (!openingItem) {
        throw new Error('ابحث عن الصنف واختره أولًا.')
      }

      if (!Number.isFinite(openingQuantity) || openingQuantity <= 0) {
        throw new Error('الكمية الافتتاحية يجب أن تكون أكبر من صفر.')
      }

      const response = await requestJson<ApiResponse<OpeningBalanceResponse>>(
        '/api/inventory/opening-balance',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            companyId: companyId.trim(),
            branchId: branchId.trim() || null,
            stockLocationId: openingStockLocationId,
            variantId: openingItem.variant_id,
            quantity: openingQuantity,
            note: openingNote.trim() || null,
          }),
        },
      )

      setSuccess(
        `تم تسجيل رصيد افتتاحي للصنف ${response.data.item.product_name} بكمية ${formatInventoryQuantity(
          response.data.balance.quantity,
        )}.`,
      )

      setOpeningCode('')
      setOpeningItem(null)
      setOpeningQuantity(1)
      setOpeningNote('')

      await loadInventory()
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تسجيل الرصيد الافتتاحي.',
      )
    } finally {
      openingSaveRequestRef.current = false
      setSavingOpeningBalance(false)
    }
  }

  // ======================================================
  // loadInventory
  // تجيب:
  // 1. رصيد المخزون الحالي
  // 2. آخر حركات المخزون
  // ======================================================
  async function loadInventory() {
    setLoading(true)
    setError('')

    try {
      const selectedCompanyId = companyId.trim()

      const selectedBranchId = branchId.trim()

      const branchQuery = selectedBranchId
        ? `&branchId=${encodeURIComponent(selectedBranchId)}`
        : ''

      const balancesUrl =
        `/api/inventory/stock-balances` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}` +
        branchQuery

      const movementsUrl =
        `/api/inventory/stock-movements` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}` +
        branchQuery +
        '&limit=50'

      const [balancesResponse, movementsResponse] = await Promise.all([
        requestJson<ApiResponse<StockBalance[]>>(balancesUrl),
        requestJson<ApiResponse<StockMovement[]>>(movementsUrl),
      ])

      setStockBalances(balancesResponse.data)
      setStockMovements(movementsResponse.data)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل بيانات المخزون.',
      )
    } finally {
      setLoading(false)
    }
  }

  // ======================================================
  // تحميل رصيد وحركات المخزون تلقائيًا عند فتح الصفحة.
  // ======================================================
  useEffect(() => {
    if (!canViewInventory || !companyId.trim()) {
      return
    }

    void loadInventory()
  }, [canViewInventory, companyId, branchId])

  useEffect(() => {
    setOpeningItem(null)
    setOpeningCode('')
    setSuccess('')

    if (!canAdjustInventory || !companyId.trim()) {
      return
    }

    void loadStockLocations()
  }, [canAdjustInventory, companyId, branchId])

  return (
    <>
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>المخزون</h2>
            <p className="muted">عرض رصيد المخزون الحالي وآخر حركات المخزون.</p>
          </div>

          {canViewInventory ? (
            <button
              type="button"
              className="primary-button small-button"
              disabled={!companyId.trim() || loading}
              onClick={loadInventory}
            >
              {loading ? 'جاري التحديث...' : 'تحديث البيانات'}
            </button>
          ) : null}
        </div>

        {error ? <p className="error-message">{error}</p> : null}
      </section>

      {canAdjustInventory ? (
        <section className="panel">
          <div className="section-header">
            <div>
              <h2>تسجيل رصيد افتتاحي</h2>

              <p className="muted">
                يستخدم مرة واحدة فقط قبل بدء حركة الصنف داخل مكان التخزين.
              </p>
            </div>
          </div>

          {success ? <p className="success-message">{success}</p> : null}

          <div className="form-grid opening-balance-grid">
            <label>
              مكان التخزين
              <select
                value={openingStockLocationId}
                disabled={loadingLocations || savingOpeningBalance}
                onChange={(event) => {
                  setOpeningStockLocationId(event.target.value)
                  setOpeningItem(null)
                }}
              >
                <option value="">
                  {loadingLocations
                    ? 'جاري تحميل الأماكن...'
                    : 'اختر مكان التخزين'}
                </option>

                {stockLocations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name} ({location.code})
                  </option>
                ))}
              </select>
            </label>

            <label>
              باركود أو SKU
              <input
                value={openingCode}
                disabled={loadingOpeningLookup || savingOpeningBalance}
                onChange={(event) => {
                  setOpeningCode(event.target.value)
                  setOpeningItem(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void lookupOpeningBalanceItem()
                  }
                }}
                placeholder="امسح الباركود أو اكتب SKU"
              />
            </label>

            <label>
              الكمية الافتتاحية
              <input
                type="number"
                min="0.001"
                step="0.001"
                value={openingQuantity}
                disabled={savingOpeningBalance}
                onChange={(event) =>
                  setOpeningQuantity(Number(event.target.value))
                }
              />
            </label>

            <label>
              ملاحظة
              <input
                value={openingNote}
                disabled={savingOpeningBalance}
                onChange={(event) => setOpeningNote(event.target.value)}
                placeholder="اختياري"
              />
            </label>
          </div>

          <div className="inventory-opening-actions">
            <button
              type="button"
              className="table-button"
              disabled={
                !openingStockLocationId ||
                !openingCode.trim() ||
                loadingOpeningLookup ||
                savingOpeningBalance
              }
              onClick={() => void lookupOpeningBalanceItem()}
            >
              {loadingOpeningLookup ? 'جاري البحث...' : 'بحث عن الصنف'}
            </button>

            <button
              type="button"
              className="primary-button small-button"
              disabled={
                !openingItem ||
                savingOpeningBalance ||
                loadingOpeningLookup ||
                openingQuantity <= 0
              }
              onClick={() => void saveOpeningBalance()}
            >
              {savingOpeningBalance
                ? 'جاري التسجيل...'
                : 'تسجيل الرصيد الافتتاحي'}
            </button>
          </div>

          {canAdjustInventory ? (
            <InventoryAdjustmentPanel
              companyId={companyId}
              stockLocations={stockLocations}
              loadingLocations={loadingLocations}
              onSaved={loadInventory}
            />
          ) : null}

          {openingItem ? (
            <article className="inventory-selected-item">
              <div>
                <span>الصنف المختار</span>
                <strong>{openingItem.product_name}</strong>
              </div>

              <div>
                <span>SKU</span>
                <strong>{openingItem.sku}</strong>
              </div>

              <div>
                <span>الرصيد الحالي</span>
                <strong>
                  {formatInventoryQuantity(openingItem.current_quantity)}
                </strong>
              </div>
            </article>
          ) : null}
        </section>
      ) : null}

      <section className="mini-cards-grid inventory-summary-grid">
        <article className="mini-card inventory-summary-card">
          <span>أرصدة الأصناف</span>

          <strong>{inventorySummary.balancesCount}</strong>
        </article>

        <article className="mini-card inventory-summary-card">
          <span>إجمالي الكمية</span>

          <strong>
            {formatInventoryQuantity(inventorySummary.totalQuantity)}
          </strong>
        </article>

        <article className="mini-card inventory-summary-card">
          <span>أماكن التخزين</span>

          <strong>{inventorySummary.locationsCount}</strong>
        </article>

        <article className="mini-card inventory-summary-card">
          <span>الحركات المعروضة</span>

          <strong>{inventorySummary.movementsCount}</strong>
        </article>
      </section>

      <section className="panel">
        <div className="section-header inventory-table-header">
          <div>
            <h2>رصيد المخزون الحالي</h2>

            <p className="muted">الكميات الحالية لكل صنف داخل أماكن التخزين.</p>
          </div>

          <span className="record-count-badge">
            {stockBalances.length} رصيد
          </span>
        </div>

        {stockBalances.length === 0 ? (
          <p className="muted">
            {loading
              ? 'جاري تحميل أرصدة المخزون...'
              : 'لا توجد أرصدة مخزون مسجلة حاليًا.'}
          </p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>الصنف</th>
                  <th>SKU</th>
                  <th>Barcode</th>
                  <th>المقاس</th>
                  <th>اللون</th>
                  <th>المكان</th>
                  <th>نوع المكان</th>
                  <th>الكمية</th>
                  <th>آخر تحديث</th>
                </tr>
              </thead>
              <tbody>
                {stockBalances.map((balance) => (
                  <tr key={balance.id}>
                    <td>
                      <strong className="inventory-product-name">
                        {balance.product_name}
                      </strong>
                    </td>

                    <td>
                      <span className="inventory-sku">{balance.sku}</span>
                    </td>

                    <td>{balance.primary_barcode || '-'}</td>
                    <td>{balance.size_name || '-'}</td>
                    <td>{balance.color_name || '-'}</td>
                    <td>{balance.stock_location_name}</td>

                    <td>
                      <span className="location-type-badge">
                        {translateLocationType(balance.location_type)}
                      </span>
                    </td>

                    <td>
                      <strong
                        className={
                          Number(balance.quantity) > 0
                            ? 'inventory-quantity inventory-quantity-positive'
                            : Number(balance.quantity) < 0
                              ? 'inventory-quantity inventory-quantity-negative'
                              : 'inventory-quantity inventory-quantity-zero'
                        }
                      >
                        {formatInventoryQuantity(balance.quantity)}
                      </strong>
                    </td>

                    <td>{formatInventoryDateTime(balance.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="section-header inventory-table-header">
          <div>
            <h2>حركات المخزون</h2>

            <p className="muted">
              آخر عمليات البيع والمرتجعات والتحويل والجرد.
            </p>
          </div>

          <span className="record-count-badge">
            {stockMovements.length} حركة
          </span>
        </div>

        {stockMovements.length === 0 ? (
          <p className="muted">
            {loading
              ? 'جاري تحميل حركات المخزون...'
              : 'لا توجد حركات مخزون مسجلة حاليًا.'}
          </p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>الصنف</th>
                  <th>SKU</th>
                  <th>التاريخ</th>
                  <th>الحركة</th>
                  <th>قبل</th>
                  <th>الكمية</th>
                  <th>بعد</th>
                  <th>المكان</th>
                  <th>المرجع</th>
                </tr>
              </thead>
              <tbody>
                {stockMovements.map((movement) => (
                  <tr key={movement.id}>
                    <td>
                      <strong className="inventory-product-name">
                        {movement.product_name}
                      </strong>
                    </td>

                    <td>
                      <span className="inventory-sku">{movement.sku}</span>
                    </td>

                    <td>{formatInventoryDateTime(movement.created_at)}</td>

                    <td>
                      <span
                        className={getInventoryMovementBadgeClass(
                          movement.quantity,
                        )}
                      >
                        {translateInventoryMovement(movement.movement_type)}
                      </span>
                    </td>

                    <td>{formatInventoryQuantity(movement.quantity_before)}</td>

                    <td>
                      <strong
                        className={
                          Number(movement.quantity) < 0
                            ? 'stock-quantity stock-quantity-out'
                            : 'stock-quantity stock-quantity-in'
                        }
                      >
                        {formatInventoryQuantity(movement.quantity)}
                      </strong>
                    </td>

                    <td>{formatInventoryQuantity(movement.quantity_after)}</td>

                    <td>{movement.stock_location_name}</td>

                    <td>
                      {movement.reference_type ? (
                        <span className="reference-type-badge">
                          {translateInventoryReference(movement.reference_type)}
                        </span>
                      ) : (
                        '-'
                      )}
                    </td>
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

export default InventoryPage
