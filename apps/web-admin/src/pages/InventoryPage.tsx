import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
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
    stock_count: 'جرد مخزون',
    damage: 'تالف',
  }

  return referenceLabels[referenceType] || referenceType
}

type InventoryPageProps = {
  companyId: string
}

function InventoryPage({ companyId }: InventoryPageProps) {
  const [stockBalances, setStockBalances] = useState<StockBalance[]>([])
  const [stockMovements, setStockMovements] = useState<StockMovement[]>([])

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

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

      const balancesUrl =
        `/api/inventory/stock-balances` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}`

      const movementsUrl =
        `/api/inventory/stock-movements` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}` +
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
          : 'Unknown inventory error',
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
  }, [canViewInventory, companyId])

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
