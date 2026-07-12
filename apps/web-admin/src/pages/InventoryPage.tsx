import { useState } from 'react'

const API_BASE_URL = 'http://localhost:3000'

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

type InventoryPageProps = {
  companyId: string
}

// ======================================================
// fetchJson
// دالة قراءة من الـ Backend API
// ======================================================
async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  const data = await response.json()

  if (!response.ok) {
    throw new Error(data?.error || 'Request failed')
  }

  return data as T
}

function InventoryPage({ companyId }: InventoryPageProps) {
  const [stockBalances, setStockBalances] = useState<StockBalance[]>([])
  const [stockMovements, setStockMovements] = useState<StockMovement[]>([])

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

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
        `${API_BASE_URL}/api/inventory/stock-balances` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}`

      const movementsUrl =
        `${API_BASE_URL}/api/inventory/stock-movements` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}` +
        '&limit=50'

      const [balancesResponse, movementsResponse] = await Promise.all([
        fetchJson<ApiResponse<StockBalance[]>>(balancesUrl),
        fetchJson<ApiResponse<StockMovement[]>>(movementsUrl),
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

  return (
    <>
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>المخزون</h2>
            <p className="muted">عرض رصيد المخزون الحالي وآخر حركات المخزون.</p>
          </div>

          <button
            className="primary-button small-button"
            disabled={!companyId.trim() || loading}
            onClick={loadInventory}
          >
            {loading ? 'جاري التحميل...' : 'تحميل المخزون'}
          </button>
        </div>

        {error ? <p className="error-message">{error}</p> : null}
      </section>

      <section className="panel">
        <h2>رصيد المخزون الحالي</h2>

        {stockBalances.length === 0 ? (
          <p className="muted">لا توجد أرصدة مخزون معروضة حتى الآن.</p>
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
                </tr>
              </thead>
              <tbody>
                {stockBalances.map((balance) => (
                  <tr key={balance.id}>
                    <td>{balance.product_name}</td>
                    <td>{balance.sku}</td>
                    <td>{balance.primary_barcode || '-'}</td>
                    <td>{balance.size_name || '-'}</td>
                    <td>{balance.color_name || '-'}</td>
                    <td>{balance.stock_location_name}</td>
                    <td>{balance.location_type}</td>
                    <td>
                      <strong>{balance.quantity}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>حركات المخزون</h2>

        {stockMovements.length === 0 ? (
          <p className="muted">لا توجد حركات مخزون معروضة حتى الآن.</p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>الصنف</th>
                  <th>SKU</th>
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
                    <td>{movement.product_name}</td>
                    <td>{movement.sku}</td>
                    <td>{movement.movement_type}</td>
                    <td>{movement.quantity_before}</td>
                    <td>{movement.quantity}</td>
                    <td>{movement.quantity_after}</td>
                    <td>{movement.stock_location_name}</td>
                    <td>{movement.reference_type || '-'}</td>
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
