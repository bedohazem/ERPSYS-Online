import { useState } from 'react'
import CustomersPage from './pages/CustomersPage'
import ProductsPage from './pages/ProductsPage'
import SalesPage from './pages/SalesPage'
import ReturnsPage from './pages/ReturnsPage'
import InventoryPage from './pages/InventoryPage'
import NewSalePage from './pages/NewSalePage'

const API_BASE_URL = 'http://localhost:3000'

type PageName =
  | 'dashboard'
  | 'products'
  | 'customers'
  | 'sales'
  | 'returns'
  | 'inventory'
  | 'new-sale'

type DailySummary = {
  companyId: string
  branchId: string | null
  date: string
  sales: {
    count: number
    total: number
    paid: number
    soldItemsQuantity: number
  }
  returns: {
    count: number
    totalRefunded: number
    returnedItemsQuantity: number
  }
  net: {
    netSales: number
  }
}

type StockMovement = {
  id: string
  product_name: string
  sku: string
  movement_type: string
  quantity: string
  quantity_before: string
  quantity_after: string
  stock_location_name: string
  created_at: string
}

type ApiResponse<T> = {
  data: T
}

// ======================================================
// fetchJson
// دالة صغيرة مسؤولة عن قراءة البيانات من الـ Backend API
//
// لو الـ API رجع error، نعرض الرسالة في الشاشة بدل ما التطبيق يقع
// ======================================================
async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  const data = await response.json()

  if (!response.ok) {
    throw new Error(data?.error || 'Request failed')
  }

  return data as T
}

function App() {
  const [activePage, setActivePage] = useState<PageName>('dashboard')

  const [companyId, setCompanyId] = useState(
    '57068e5c-b81e-40c0-aa3a-a9371923bf50',
  )
  const [branchId, setBranchId] = useState(
    'c834cecd-a7b7-4779-a2e5-799587059a94',
  )
  const [date, setDate] = useState('2026-07-12')

  const [dailySummary, setDailySummary] = useState<DailySummary | null>(null)
  const [stockMovements, setStockMovements] = useState<StockMovement[]>([])

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // ======================================================
  // loadDashboard
  // دي بتجيب بيانات الداشبورد من الـ API
  //
  // 1. daily-summary:
  //    تقرير اليوم: مبيعات + مرتجعات + صافي
  //
  // 2. stock-movements:
  //    آخر حركات المخزون
  // ======================================================
  async function loadDashboard() {
    setLoading(true)
    setError('')

    try {
      const selectedCompanyId = companyId.trim()
      const selectedBranchId = branchId.trim()

      const dailySummaryUrl =
        `${API_BASE_URL}/api/reports/daily-summary` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}` +
        `&date=${encodeURIComponent(date)}` +
        (selectedBranchId
          ? `&branchId=${encodeURIComponent(selectedBranchId)}`
          : '')

      const stockMovementsUrl =
        `${API_BASE_URL}/api/inventory/stock-movements` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}` +
        '&limit=10'

      const [dailySummaryResponse, stockMovementsResponse] = await Promise.all([
        fetchJson<ApiResponse<DailySummary>>(dailySummaryUrl),
        fetchJson<ApiResponse<StockMovement[]>>(stockMovementsUrl),
      ])

      setDailySummary(dailySummaryResponse.data)
      setStockMovements(stockMovementsResponse.data)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'Unknown dashboard error',
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="page">
      <section className="hero">
        <div>
          <p className="eyebrow">ERPSYS Online</p>
          <h1>لوحة الإدارة</h1>
          <p>
            Web Admin يقرأ من الـ Backend API ويعرض الداشبورد والمنتجات والعملاء
            والفواتير.
          </p>
        </div>
      </section>

      <nav className="tabs">
        <button
          className={activePage === 'dashboard' ? 'tab active-tab' : 'tab'}
          onClick={() => setActivePage('dashboard')}
        >
          Dashboard
        </button>

        <button
          className={activePage === 'products' ? 'tab active-tab' : 'tab'}
          onClick={() => setActivePage('products')}
        >
          Products
        </button>

        <button
          className={activePage === 'customers' ? 'tab active-tab' : 'tab'}
          onClick={() => setActivePage('customers')}
        >
          Customers
        </button>

        <button
          className={activePage === 'sales' ? 'tab active-tab' : 'tab'}
          onClick={() => setActivePage('sales')}
        >
          Sales
        </button>

        <button
          className={activePage === 'returns' ? 'tab active-tab' : 'tab'}
          onClick={() => setActivePage('returns')}
        >
          Returns
        </button>

        <button
          className={activePage === 'inventory' ? 'tab active-tab' : 'tab'}
          onClick={() => setActivePage('inventory')}
        >
          Inventory
        </button>

        <button
          className={activePage === 'new-sale' ? 'tab active-tab' : 'tab'}
          onClick={() => setActivePage('new-sale')}
        >
          New Sale
        </button>
      </nav>

      <section className="panel">
        <h2>بيانات التشغيل</h2>

        <div className="form-grid">
          <label>
            companyId
            <input
              value={companyId}
              onChange={(event) => setCompanyId(event.target.value)}
              placeholder="اكتب companyId هنا"
            />
          </label>

          <label>
            branchId اختياري
            <input
              value={branchId}
              onChange={(event) => setBranchId(event.target.value)}
              placeholder="اكتب branchId لو عايز تقرير فرع معين"
            />
          </label>

          <label>
            التاريخ
            <input
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>
        </div>
      </section>

      {activePage === 'dashboard' ? (
        <>
          <section className="panel">
            <div className="section-header">
              <div>
                <h2>Dashboard</h2>
                <p className="muted">
                  تقرير اليوم وآخر حركات المخزون من قاعدة البيانات.
                </p>
              </div>

              <button
                className="primary-button small-button"
                disabled={!companyId.trim() || !date || loading}
                onClick={loadDashboard}
              >
                {loading ? 'جاري التحميل...' : 'تحميل الداشبورد'}
              </button>
            </div>

            {error ? <p className="error-message">{error}</p> : null}
          </section>

          {dailySummary ? (
            <section className="cards-grid">
              <article className="card">
                <span>مبيعات اليوم</span>
                <strong>{dailySummary.sales.total}</strong>
                <small>عدد الفواتير: {dailySummary.sales.count}</small>
              </article>

              <article className="card">
                <span>المرتجعات</span>
                <strong>{dailySummary.returns.totalRefunded}</strong>
                <small>عدد المرتجعات: {dailySummary.returns.count}</small>
              </article>

              <article className="card">
                <span>صافي اليوم</span>
                <strong>{dailySummary.net.netSales}</strong>
                <small>مبيعات - مرتجعات</small>
              </article>

              <article className="card">
                <span>حركة القطع</span>
                <strong>
                  {dailySummary.sales.soldItemsQuantity -
                    dailySummary.returns.returnedItemsQuantity}
                </strong>
                <small>
                  مباع: {dailySummary.sales.soldItemsQuantity} / مرتجع:{' '}
                  {dailySummary.returns.returnedItemsQuantity}
                </small>
              </article>
            </section>
          ) : null}

          <section className="panel">
            <h2>آخر حركات المخزون</h2>

            {stockMovements.length === 0 ? (
              <p className="muted">لا توجد حركات معروضة حتى الآن.</p>
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
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}

      {activePage === 'products' ? (
        <ProductsPage companyId={companyId} />
      ) : null}

      {activePage === 'customers' ? (
        <CustomersPage companyId={companyId} />
      ) : null}

      {activePage === 'sales' ? (
        <SalesPage companyId={companyId} branchId={branchId} />
      ) : null}

      {activePage === 'returns' ? (
        <ReturnsPage companyId={companyId} branchId={branchId} />
      ) : null}

      {activePage === 'inventory' ? (
        <InventoryPage companyId={companyId} />
      ) : null}

      {activePage === 'new-sale' ? (
        <NewSalePage companyId={companyId} branchId={branchId} />
      ) : null}
    </main>
  )
}

export default App
