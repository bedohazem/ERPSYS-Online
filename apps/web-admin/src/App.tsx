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
// شاشة إدارة مستخدمي الشركة.
import UsersPage from './pages/UsersPage'
// شاشة عرض الأدوار والصلاحيات.
import RolesPage from './pages/RolesPage'

// requestJson مسؤول عن إضافة عنوان السيرفر تلقائيًا.
import { requestJson } from './lib/http'

type PageName =
  | 'dashboard'
  | 'products'
  | 'customers'
  | 'sales'
  | 'returns'
  | 'inventory'
  | 'users'
  | 'roles'
  | 'new-sale'
  | 'new-return'

// ======================================================
// صفحات لوحة الإدارة.
//
// label:
// الاسم العربي الظاهر في Sidebar وTopbar.
//
// icon:
// رمز بسيط لا يحتاج مكتبة Icons خارجية.
//
// permission:
// صلاحية Backend المطلوبة لعرض الصفحة.
// ======================================================
const pageDefinitions: Array<{
  name: PageName
  label: string
  icon: string
  permission: string
}> = [
  {
    name: 'dashboard',
    label: 'الرئيسية',
    icon: '▦',
    permission: 'dashboard.view',
  },
  {
    name: 'new-sale',
    label: 'فاتورة بيع جديدة',
    icon: '+',
    permission: 'sales.create',
  },
  {
    name: 'sales',
    label: 'فواتير المبيعات',
    icon: '↗',
    permission: 'sales.view',
  },
  {
    name: 'new-return',
    label: 'مرتجع جديد',
    icon: '↩',
    permission: 'returns.create',
  },
  {
    name: 'returns',
    label: 'المرتجعات',
    icon: '↙',
    permission: 'returns.view',
  },
  {
    name: 'products',
    label: 'المنتجات والأصناف',
    icon: '▤',
    permission: 'products.view',
  },
  {
    name: 'inventory',
    label: 'المخزون',
    icon: '▥',
    permission: 'inventory.view',
  },
  {
    name: 'customers',
    label: 'العملاء',
    icon: '◎',
    permission: 'customers.view',
  },
  {
    name: 'users',
    label: 'المستخدمون',
    icon: '♙',
    permission: 'users.manage',
  },
  {
    name: 'roles',
    label: 'الأدوار والصلاحيات',
    icon: '⚙',
    permission: 'roles.manage',
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

  const canViewDashboard =
    user?.roles.includes('admin') ||
    user?.permissions.includes('dashboard.view') ||
    false

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
  // ======================================================
  // بيانات الصفحة المفتوحة حاليًا.
  //
  // تستخدم داخل Topbar لإظهار اسم ورمز الصفحة.
  // ======================================================
  const activePageDefinition =
    visiblePages.find((page) => page.name === activePage) ??
    pageDefinitions.find((page) => page.name === activePage) ??
    pageDefinitions[0]

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
        `/api/reports/daily-summary` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}` +
        `&date=${encodeURIComponent(date)}` +
        (selectedBranchId
          ? `&branchId=${encodeURIComponent(selectedBranchId)}`
          : '')

      const stockMovementsUrl =
        `/api/inventory/stock-movements` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}` +
        '&limit=10'

      const [dailySummaryResponse, stockMovementsResponse] = await Promise.all([
        requestJson<ApiResponse<DailySummary>>(dailySummaryUrl),
        requestJson<ApiResponse<StockMovement[]>>(stockMovementsUrl),
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
  // تحميل الداشبورد تلقائيًا.
  //
  // يتم التحديث عند:
  // - فتح صفحة الداشبورد.
  // - اكتمال بيانات Session.
  // - تغيير الفرع.
  // - تغيير تاريخ التقرير.
  // ======================================================
  useEffect(() => {
    if (
      activePage !== 'dashboard' ||
      !canViewDashboard ||
      !companyId.trim() ||
      !date
    ) {
      return
    }

    void loadDashboard()
  }, [activePage, canViewDashboard, companyId, branchId, date])

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
    <main className="app-shell" dir="rtl">
      {/* ==================================================
      Sidebar

      تحتوي على:
      - هوية النظام.
      - الصفحات المسموح بها.
      - بيانات المستخدم الحالي.
  ================================================== */}
      <aside className="app-sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-logo">E</div>

          <div>
            <strong>ERPSYS Online</strong>
            <span>نظام إدارة الأعمال</span>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="التنقل الرئيسي">
          {visiblePages.map((page) => (
            <button
              key={page.name}
              type="button"
              className={
                activePage === page.name
                  ? 'sidebar-nav-button sidebar-nav-button-active'
                  : 'sidebar-nav-button'
              }
              onClick={() => {
                if (page.name === 'new-return') {
                  setSelectedReturnSaleId(null)
                }

                setActivePage(page.name)
              }}
            >
              <span className="sidebar-nav-icon">{page.icon}</span>

              <span>{page.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-session">
          <div className="sidebar-user-avatar">
            {(user?.fullName || 'م').trim().charAt(0) || 'م'}
          </div>

          <div className="sidebar-user-details">
            <strong>{user?.fullName || '-'}</strong>
            <span>@{user?.username || '-'}</span>
          </div>
        </div>
      </aside>

      {/* ==================================================
      مساحة العمل الرئيسية
  ================================================== */}
      <section className="app-workspace">
        <header className="app-topbar">
          <div className="topbar-heading">
            <span className="topbar-page-icon">
              {activePageDefinition.icon}
            </span>

            <div>
              <p className="topbar-kicker">لوحة الإدارة</p>
              <h1>{activePageDefinition.label}</h1>
            </div>
          </div>

          <div className="topbar-actions">
            {/* تاريخ التقرير يظهر داخل الداشبورد فقط. */}
            {activePage === 'dashboard' ? (
              <label className="topbar-date">
                <span>تاريخ التقرير</span>

                <input
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                />
              </label>
            ) : null}

            <div className="topbar-context">
              <span>الشركة</span>

              <strong>{user?.companyName || user?.companyCode || '-'}</strong>
            </div>

            <div className="topbar-context">
              <span>الفرع</span>

              <strong>{user?.branchName || 'كل الفروع'}</strong>
            </div>

            <button
              type="button"
              className="logout-button topbar-logout"
              onClick={() => {
                void logout()
              }}
            >
              تسجيل الخروج
            </button>
          </div>
        </header>

        <div className="app-content">
          {activePage === 'dashboard' ? (
            <>
              <section className="panel">
                <div className="section-header">
                  <div>
                    <h2>نظرة عامة</h2>
                    <p className="muted">
                      تقرير اليوم وآخر حركات المخزون من قاعدة البيانات.
                    </p>
                  </div>

                  {canViewDashboard ? (
                    <button
                      className="primary-button small-button"
                      disabled={!companyId.trim() || !date || loading}
                      onClick={loadDashboard}
                    >
                      {loading ? 'جاري التحديث...' : 'تحديث البيانات'}
                    </button>
                  ) : null}
                </div>

                {error ? <p className="error-message">{error}</p> : null}
                {loading && !dailySummary ? (
                  <p className="muted">جاري تحميل بيانات الداشبورد...</p>
                ) : null}
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

          {activePage === 'users' ? <UsersPage /> : null}

          {activePage === 'roles' ? <RolesPage /> : null}

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
        </div>
      </section>
    </main>
  )
}

export default App
