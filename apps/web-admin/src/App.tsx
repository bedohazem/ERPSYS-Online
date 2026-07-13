import { useEffect, useMemo, useState } from 'react'
// بيانات المستخدم والشركة تأتي من Session الموثقة.
import { useAuth } from './auth/AuthContext'
import CustomersPage from './pages/CustomersPage'
import ProductsPage from './pages/ProductsPage'
import SalesPage from './pages/SalesPage'
import ReturnsPage from './pages/ReturnsPage'
import InventoryPage from './pages/InventoryPage'
import NewSalePage from './pages/NewSalePage'
import NewReturnPage from './pages/NewReturnPage'

const API_BASE_URL = 'http://localhost:3000'

type PageName =
  | 'dashboard'
  | 'products'
  | 'customers'
  | 'sales'
  | 'returns'
  | 'inventory'
  | 'new-sale'
  | 'new-return'

// كل صفحة مرتبطة بصلاحية Backend.
const pageDefinitions: Array<{
  name: PageName
  label: string
  permission: string
}> = [
  {
    name: 'dashboard',
    label: 'Dashboard',
    permission: 'dashboard.view',
  },
  {
    name: 'products',
    label: 'Products',
    permission: 'products.view',
  },
  {
    name: 'customers',
    label: 'Customers',
    permission: 'customers.view',
  },
  {
    name: 'sales',
    label: 'Sales',
    permission: 'sales.view',
  },
  {
    name: 'returns',
    label: 'Returns',
    permission: 'returns.view',
  },
  {
    name: 'inventory',
    label: 'Inventory',
    permission: 'inventory.view',
  },
  {
    name: 'new-sale',
    label: 'New Sale',
    permission: 'sales.create',
  },
  {
    name: 'new-return',
    label: 'New Return',
    permission: 'returns.create',
  },
]

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

// ======================================================
// تاريخ اليوم حسب توقيت جهاز المستخدم
//
// نطرح timezone offset حتى لا يتغير اليوم عند تحويله
// إلى ISO String.
// ======================================================
function createTodayDateValue() {
  const now = new Date()

  const localDate = new Date(
    now.getTime() - now.getTimezoneOffset() * 60 * 1000,
  )

  return localDate.toISOString().slice(0, 10)
}

function App() {
  const [activePage, setActivePage] = useState<PageName>('dashboard')

  // رقم الفاتورة التي سيتم فتح مرتجع لها مباشرة
  // null يعني فتح شاشة New Return بدون فاتورة محددة
  const [selectedReturnSaleId, setSelectedReturnSaleId] = useState<
    string | null
  >(null)

  // بيانات الشركة والفرع لا تُكتب يدويًا بعد الآن.
  // مصدرها Session المستخدم المسجل.
  const { user, logout } = useAuth()

  // الصفحات التي يملك المستخدم صلاحية عرضها.
  const visiblePages = useMemo(() => {
    const isAdmin = user?.roles.includes('admin') ?? false

    return pageDefinitions.filter((page) => {
      return isAdmin || user?.permissions.includes(page.permission)
    })
  }, [user])

  // لو المستخدم لا يملك صلاحية الصفحة الحالية،
  // ننقله لأول صفحة مسموحة.
  useEffect(() => {
    const pageIsAllowed = visiblePages.some((page) => page.name === activePage)

    if (!pageIsAllowed) {
      const firstAllowedPage = visiblePages[0]?.name

      if (firstAllowedPage) {
        setActivePage(firstAllowedPage)
      }
    }
  }, [activePage, visiblePages])

  const companyId = user?.companyId || ''

  const branchId = user?.branchId || ''

  const [date, setDate] = useState(createTodayDateValue)

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

  // ======================================================
  // openNewReturnFromSale
  //
  // تستقبل saleId من شاشة Sales
  // ثم تفتح شاشة New Return على نفس الفاتورة مباشرة
  // ======================================================
  function openNewReturnFromSale(saleId: string) {
    setSelectedReturnSaleId(saleId)
    setActivePage('new-return')
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
        {visiblePages.map((page) => (
          <button
            key={page.name}
            className={activePage === page.name ? 'tab active-tab' : 'tab'}
            onClick={() => {
              if (page.name === 'new-return') {
                setSelectedReturnSaleId(null)
              }

              setActivePage(page.name)
            }}
          >
            {page.label}
          </button>
        ))}
      </nav>

      {/* =================================================
          جلسة التشغيل

          الشركة والفرع والمستخدم أصبحوا Read Only لأن
          مصدرهم هو Session الموثقة من Backend.
      ================================================= */}
      <section className="panel session-panel">
        <div className="section-header">
          <div>
            <h2>جلسة التشغيل</h2>

            <p className="muted">
              بيانات الشركة والفرع مرتبطة بالمستخدم المسجل حاليًا.
            </p>
          </div>

          <button
            type="button"
            className="logout-button small-button"
            onClick={() => {
              void logout()
            }}
          >
            تسجيل الخروج
          </button>
        </div>

        <div className="session-info-grid">
          <article>
            <span>المستخدم</span>

            <strong>{user?.fullName || '-'}</strong>

            <small>@{user?.username || '-'}</small>
          </article>

          <article>
            <span>الشركة</span>

            <strong>{user?.companyName || user?.companyCode || '-'}</strong>

            <small>{user?.companyCode || '-'}</small>
          </article>

          <article>
            <span>الفرع</span>

            <strong>{user?.branchName || 'غير مرتبط بفرع'}</strong>

            <small>Session Branch</small>
          </article>

          <label className="session-date-card">
            <span>تاريخ الداشبورد</span>

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
        <SalesPage
          companyId={companyId}
          branchId={branchId}
          onCreateReturn={openNewReturnFromSale}
        />
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

      {activePage === 'new-return' ? (
        <NewReturnPage
          companyId={companyId}
          branchId={branchId}
          initialSaleId={selectedReturnSaleId}
          onInitialSaleHandled={() => setSelectedReturnSaleId(null)}
        />
      ) : null}
    </main>
  )
}

export default App
