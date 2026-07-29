import { useEffect, useMemo, useState } from 'react'
// بيانات المستخدم والشركة تأتي من Session الموثقة.
import { useAuth } from './auth/AuthContext'
import CustomersPage from './pages/CustomersPage'
import ProductsPage from './pages/ProductsPage'
import SalesPage from './pages/SalesPage'
import ReturnsPage from './pages/ReturnsPage'
import InventoryPage from './pages/InventoryPage'
import StockCountsPage from './pages/StockCountsPage'
import TransfersPage from './pages/TransfersPage'
import PurchasesPage from './pages/PurchasesPage'
import PurchaseOrdersPage from './pages/PurchaseOrdersPage'
import PosDevicesPage from './pages/PosDevicesPage'
import PosSyncPage from './pages/PosSyncPage'
import NewSalePage from './pages/NewSalePage'
import NewReturnPage from './pages/NewReturnPage'
import NewExchangePage from './pages/NewExchangePage'
import ExchangesPage from './pages/ExchangesPage'
// شاشة إدارة مستخدمي الشركة.
import UsersPage from './pages/UsersPage'
// شاشة عرض الأدوار والصلاحيات.
import RolesPage from './pages/RolesPage'
import CashierShiftsPage from './pages/CashierShiftsPage'
import SalesPerformancePage from './pages/SalesPerformancePage'
import ProductPerformancePage from './pages/ProductPerformancePage'
import InventoryShortagesPage from './pages/InventoryShortagesPage'
import InventoryConditionsPage from './pages/InventoryConditionsPage'
import InventoryItemCardPage from './pages/InventoryItemCardPage'
// requestJson مسؤول عن إضافة عنوان السيرفر تلقائيًا.
import { requestJson } from './lib/http'

type PageName =
  | 'dashboard'
  | 'products'
  | 'customers'
  | 'sales'
  | 'returns'
  | 'inventory'
  | 'inventory-item-card'
  | 'stock-counts'
  | 'inventory-conditions'
  | 'transfers'
  | 'purchases'
  | 'purchase-orders'
  | 'pos-devices'
  | 'pos-sync'
  | 'users'
  | 'roles'
  | 'new-sale'
  | 'new-return'
  | 'new-exchange'
  | 'exchanges'
  | 'cashier-shifts'
  | 'sales-performance'
  | 'product-performance'
  | 'inventory-shortages'

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
  anyPermissions?: string[]
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

    anyPermissions: [
      'sales.view',
      'sales.void',
      'returns.create',
      'exchanges.create',
    ],
  },
  {
    name: 'new-return',
    label: 'مرتجع جديد',
    icon: '↩',
    permission: 'returns.create',
  },
  {
    name: 'new-exchange',
    label: 'استبدال جديد',
    icon: '⇄',
    permission: 'exchanges.create',
  },
  {
    name: 'exchanges',
    label: 'سجل الاستبدالات',
    icon: '≋',
    permission: 'exchanges.view',

    anyPermissions: ['exchanges.view', 'exchanges.create', 'exchanges.void'],
  },
  {
    name: 'returns',
    label: 'المرتجعات',
    icon: '↙',
    permission: 'returns.view',

    anyPermissions: ['returns.view', 'returns.create', 'returns.void'],
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
    name: 'inventory-item-card',
    label: 'كارت حركة صنف',
    icon: '▤',
    permission: 'inventory.view',
  },
  {
    name: 'stock-counts',
    label: 'جرد المخزون',
    icon: '✓',
    permission: 'inventory.view',
  },
  {
    name: 'inventory-conditions',
    label: 'التالف وتحت الفحص',
    icon: '⚠',
    permission: 'inventory.view',
  },
  {
    name: 'transfers',
    label: 'تحويلات المخزون',
    icon: '⇄',
    permission: 'inventory.transfer.view',

    anyPermissions: [
      'inventory.transfer.view',
      'inventory.transfer.create',
      'inventory.transfer.approve',
      'inventory.transfer.receive',
    ],
  },
  {
    name: 'purchases',
    label: 'المشتريات والموردون',
    icon: '↓',
    permission: 'purchases.view',

    anyPermissions: [
      'purchases.view',
      'purchases.create',
      'suppliers.view',
      'suppliers.manage',
    ],
  },
  {
    name: 'purchase-orders',
    label: 'أوامر الشراء',
    icon: '▣',
    permission: 'purchases.view',

    anyPermissions: ['purchases.view', 'purchases.create'],
  },
  {
    name: 'pos-devices',
    label: 'أجهزة نقاط البيع',
    icon: '▣',
    permission: 'pos.devices.view',

    anyPermissions: ['pos.devices.view', 'pos.devices.manage'],
  },
  {
    name: 'pos-sync',
    label: 'مزامنة نقاط البيع',
    icon: '⟳',
    permission: 'pos.sync.view',

    anyPermissions: ['pos.sync.view', 'pos.sync.manage'],
  },
  {
    name: 'cashier-shifts',
    label: 'تسوية الورديات',
    icon: '⌁',
    permission: 'reports.view',
  },
  {
    name: 'sales-performance',
    label: 'تقارير المبيعات',
    icon: '▥',
    permission: 'reports.view',
  },
  {
    name: 'product-performance',
    label: 'أداء الأصناف',
    icon: '▤',
    permission: 'reports.view',
  },
  {
    name: 'inventory-shortages',
    label: 'نواقص المخزون',
    icon: '⚠',
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

// ======================================================
// مجموعات التنقل.
//
// الصفحات تظل مستقلة ولها نفس الروابط والصلاحيات، لكن
// الـSidebar يعرضها داخل أقسام لتقليل الزحام.
// ======================================================
type NavigationGroupName =
  | 'sales'
  | 'inventory'
  | 'purchases'
  | 'pos'
  | 'reports'
  | 'administration'

const navigationGroups: Array<{
  name: NavigationGroupName
  label: string
  icon: string
  pages: PageName[]
}> = [
  {
    name: 'sales',
    label: 'المبيعات والعملاء',
    icon: '↗',
    pages: [
      'new-sale',
      'sales',
      'new-return',
      'returns',
      'new-exchange',
      'exchanges',
      'customers',
    ],
  },
  {
    name: 'inventory',
    label: 'المنتجات والمخزون',
    icon: '▥',
    pages: [
      'products',
      'inventory',
      'inventory-item-card',
      'stock-counts',
      'inventory-conditions',
      'transfers',
      'inventory-shortages',
    ],
  },
  {
    name: 'purchases',
    label: 'المشتريات',
    icon: '↓',
    pages: ['purchases', 'purchase-orders'],
  },
  {
    name: 'pos',
    label: 'نقاط البيع',
    icon: '▣',
    pages: ['pos-devices', 'pos-sync', 'cashier-shifts'],
  },
  {
    name: 'reports',
    label: 'التقارير',
    icon: '▤',
    pages: ['sales-performance', 'product-performance'],
  },
  {
    name: 'administration',
    label: 'الإدارة والصلاحيات',
    icon: '⚙',
    pages: ['users', 'roles'],
  },
]

// ======================================================
// readPageFromHash
//
// قراءة اسم الصفحة من رابط المتصفح.
//
// أمثلة:
// #/dashboard
// #/products
// #/sales
//
// أي قيمة غير معروفة ترجع null بدل فتح صفحة غير موجودة.
// ======================================================
function readPageFromHash(): PageName | null {
  const hashValue = window.location.hash.replace(/^#\/?/, '').trim()

  const pageExists = pageDefinitions.some((page) => page.name === hashValue)

  return pageExists ? (hashValue as PageName) : null
}

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

// ======================================================
// تنسيق مبالغ الداشبورد بالجنيه المصري.
// ======================================================
const currencyFormatter = new Intl.NumberFormat('ar-EG', {
  style: 'currency',
  currency: 'EGP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})

// ======================================================
// تنسيق كميات المخزون بحد أقصى 3 أرقام عشرية.
// ======================================================
const quantityFormatter = new Intl.NumberFormat('ar-EG', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
})

function formatCurrency(value: number | string) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? currencyFormatter.format(numericValue)
    : '-'
}

function formatQuantity(value: number | string) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? quantityFormatter.format(numericValue)
    : '-'
}

// ======================================================
// ترجمة أنواع حركة المخزون.
// ======================================================
function translateStockMovement(movementType: string) {
  const movementLabels: Record<string, string> = {
    sale: 'بيع',
    return: 'مرتجع',
    exchange: 'استبدال',
    purchase: 'شراء',
    adjustment: 'تسوية',
    opening_balance: 'رصيد افتتاحي',
    transfer_in: 'تحويل وارد',
    transfer_out: 'تحويل صادر',
  }

  return movementLabels[movementType] || movementType
}

function getMovementBadgeClass(movementType: string) {
  if (
    movementType === 'return' ||
    movementType === 'purchase' ||
    movementType === 'transfer_in'
  ) {
    return 'movement-badge movement-badge-in'
  }

  if (movementType === 'sale' || movementType === 'transfer_out') {
    return 'movement-badge movement-badge-out'
  }

  return 'movement-badge'
}

function App() {
  // فتح آخر صفحة موجودة في الرابط عند تحميل التطبيق.
  const [activePage, setActivePage] = useState<PageName>(
    () => readPageFromHash() ?? 'dashboard',
  )

  // الأقسام المفتوحة في الـSidebar.
  // عند فتح صفحة من رابط مباشر سيتم فتح مجموعتها تلقائيًا.
  const [openNavigationGroups, setOpenNavigationGroups] = useState<
    NavigationGroupName[]
  >([])

  // رقم الفاتورة التي سيتم فتح مرتجع لها مباشرة
  // null يعني فتح شاشة New Return بدون فاتورة محددة
  const [selectedReturnSaleId, setSelectedReturnSaleId] = useState<
    string | null
  >(null)

  const [selectedExchangeSaleId, setSelectedExchangeSaleId] = useState<
    string | null
  >(null)

  const [selectedPosSyncSaleId, setSelectedPosSyncSaleId] = useState<
    string | null
  >(null)

  // بيانات الشركة والفرع لا تُكتب يدويًا بعد الآن.
  // مصدرها Session المستخدم المسجل.
  const { user, logout } = useAuth()

  // ======================================================
  // navigateToPage
  //
  // تغيير الصفحة مع تحديث رابط المتصفح.
  //
  // replace:
  // يستخدم عند تصحيح رابط غير مسموح حتى لا نضيفه
  // إلى سجل زر الرجوع في المتصفح.
  // ======================================================
  function navigateToPage(pageName: PageName, replace = false) {
    const nextHash = `#/${pageName}`

    if (window.location.hash !== nextHash) {
      if (replace) {
        window.history.replaceState(null, '', nextHash)
      } else {
        window.history.pushState(null, '', nextHash)
      }
    }

    setActivePage(pageName)
  }

  function openSaleFromPosSync(saleId: string) {
    setSelectedPosSyncSaleId(saleId)
    navigateToPage('sales')
  }

  const canViewDashboard =
    user?.roles.includes('admin') ||
    user?.permissions.includes('dashboard.view') ||
    false

  // الصفحات التي يملك المستخدم صلاحية عرضها.
  const visiblePages = useMemo(() => {
    const isAdmin = user?.roles.includes('admin') ?? false

    return pageDefinitions.filter((page) => {
      const hasPrimaryPermission =
        user?.permissions.includes(page.permission) ?? false

      const hasAnyOptionalPermission =
        page.anyPermissions?.some((permission) =>
          user?.permissions.includes(permission),
        ) ?? false

      return isAdmin || hasPrimaryPermission || hasAnyOptionalPermission
    })
  }, [user])

  // لا نظهر مجموعة فارغة.
  // الصفحات داخل كل مجموعة تمر أولًا على فحص الصلاحيات الحالي.
  const visibleNavigationGroups = useMemo(() => {
    return navigationGroups
      .map((group) => ({
        ...group,

        pages: group.pages.flatMap((pageName) => {
          const page = visiblePages.find(
            (visiblePage) => visiblePage.name === pageName,
          )

          return page ? [page] : []
        }),
      }))
      .filter((group) => group.pages.length > 0)
  }, [visiblePages])

  const dashboardNavigationPage = visiblePages.find(
    (page) => page.name === 'dashboard',
  )

  // عند فتح صفحة من رابط أو زر داخلي، نفتح مجموعتها تلقائيًا.
  useEffect(() => {
    const activeGroup = navigationGroups.find((group) =>
      group.pages.includes(activePage),
    )

    if (!activeGroup) {
      return
    }

    setOpenNavigationGroups((currentGroups) => {
      if (currentGroups.includes(activeGroup.name)) {
        return currentGroups
      }

      return [...currentGroups, activeGroup.name]
    })
  }, [activePage])

  // ======================================================
  // مزامنة الصفحة مع أزرار الرجوع والتقدم في المتصفح.
  // ======================================================
  useEffect(() => {
    function handleLocationChange() {
      setActivePage(readPageFromHash() ?? 'dashboard')
    }

    window.addEventListener('popstate', handleLocationChange)
    window.addEventListener('hashchange', handleLocationChange)

    return () => {
      window.removeEventListener('popstate', handleLocationChange)

      window.removeEventListener('hashchange', handleLocationChange)
    }
  }, [])

  // لو المستخدم لا يملك صلاحية الصفحة الحالية،
  // ننقله لأول صفحة مسموحة.
  useEffect(() => {
    const pageIsAllowed = visiblePages.some((page) => page.name === activePage)

    // منع فتح صفحة لا يملك المستخدم صلاحيتها.
    if (!pageIsAllowed) {
      const firstAllowedPage = visiblePages[0]?.name

      if (firstAllowedPage) {
        navigateToPage(firstAllowedPage, true)
      }

      // مهم: لا نكمل تصحيح الرابط باستخدام الصفحة القديمة.
      return
    }

    // تصحيح الرابط القديم أو غير المعروف
    // بدون إضافة سجل جديد للمتصفح.
    if (readPageFromHash() !== activePage) {
      window.history.replaceState(null, '', `#/${activePage}`)
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

  // تحديث عنوان تبويب المتصفح حسب الصفحة المفتوحة.
  useEffect(() => {
    document.title = `${activePageDefinition.label} | ERPSYS Online`
  }, [activePageDefinition.label])

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

      // حركات المخزون معزولة حسب Session، لذلك لا نرسل Tenant IDs.
      const stockMovementsUrl = '/api/inventory/stock-movements?limit=10'

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
    navigateToPage('new-return')
  }

  function openNewExchangeFromSale(saleId: string) {
    setSelectedExchangeSaleId(saleId)

    navigateToPage('new-exchange')
  }

  // فتح أو غلق مجموعة بدون تغيير الصفحة الحالية.
  function toggleNavigationGroup(groupName: NavigationGroupName) {
    setOpenNavigationGroups((currentGroups) =>
      currentGroups.includes(groupName)
        ? currentGroups.filter((currentGroup) => currentGroup !== groupName)
        : [...currentGroups, groupName],
    )
  }

  // يحافظ على تنظيف بيانات المرتجع والاستبدال
  // الموجود سابقًا عند فتح الصفحات من الـSidebar.
  function openNavigationPage(pageName: PageName) {
    if (pageName === 'new-return') {
      setSelectedReturnSaleId(null)
    }

    if (pageName === 'new-exchange') {
      setSelectedExchangeSaleId(null)
    }

    navigateToPage(pageName)
  }

  // توحيد رسم زر الصفحة بدل تكرار نفس الكود
  // داخل الرئيسية وداخل مجموعات التنقل.
  function renderNavigationPageButton(
    page: (typeof pageDefinitions)[number],
    isDashboard = false,
  ) {
    const classNames = [
      'sidebar-nav-button',
      isDashboard ? 'sidebar-nav-dashboard' : '',
      activePage === page.name ? 'sidebar-nav-button-active' : '',
    ]
      .filter(Boolean)
      .join(' ')

    return (
      <button
        key={page.name}
        type="button"
        className={classNames}
        onClick={() => openNavigationPage(page.name)}
      >
        <span className="sidebar-nav-icon">{page.icon}</span>
        <span>{page.label}</span>
      </button>
    )
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
          {dashboardNavigationPage
            ? renderNavigationPageButton(dashboardNavigationPage, true)
            : null}

          {visibleNavigationGroups.map((group) => {
            const isOpen = openNavigationGroups.includes(group.name)

            const containsActivePage = group.pages.some(
              (page) => page.name === activePage,
            )

            const groupContentId = `sidebar-group-${group.name}`

            return (
              <section key={group.name} className="sidebar-nav-group">
                <button
                  type="button"
                  className={
                    containsActivePage
                      ? 'sidebar-nav-group-button sidebar-nav-group-button-active'
                      : 'sidebar-nav-group-button'
                  }
                  aria-expanded={isOpen}
                  aria-controls={groupContentId}
                  onClick={() => toggleNavigationGroup(group.name)}
                >
                  <span className="sidebar-nav-icon">{group.icon}</span>

                  <span className="sidebar-nav-group-label">{group.label}</span>

                  <span
                    className={
                      isOpen
                        ? 'sidebar-nav-group-arrow sidebar-nav-group-arrow-open'
                        : 'sidebar-nav-group-arrow'
                    }
                    aria-hidden="true"
                  >
                    ‹
                  </span>
                </button>

                {isOpen ? (
                  <div id={groupContentId} className="sidebar-nav-group-pages">
                    {group.pages.map((page) =>
                      renderNavigationPageButton(page),
                    )}
                  </div>
                ) : null}
              </section>
            )
          })}
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
              <section className="panel dashboard-overview-panel">
                <div className="section-header dashboard-overview-header">
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
                <section className="cards-grid dashboard-stats-grid">
                  <article className="card dashboard-stat-card dashboard-stat-sales">
                    <div className="dashboard-stat-header">
                      <span>مبيعات اليوم</span>
                      <span className="dashboard-stat-icon">↗</span>
                    </div>

                    <strong>{formatCurrency(dailySummary.sales.total)}</strong>

                    <small>عدد الفواتير: {dailySummary.sales.count}</small>
                  </article>

                  <article className="card dashboard-stat-card dashboard-stat-returns">
                    <div className="dashboard-stat-header">
                      <span>المرتجعات</span>
                      <span className="dashboard-stat-icon">↩</span>
                    </div>

                    <strong>
                      {formatCurrency(dailySummary.returns.totalRefunded)}
                    </strong>

                    <small>عدد المرتجعات: {dailySummary.returns.count}</small>
                  </article>

                  <article className="card dashboard-stat-card dashboard-stat-net">
                    <div className="dashboard-stat-header">
                      <span>صافي اليوم</span>
                      <span className="dashboard-stat-icon">Σ</span>
                    </div>

                    <strong>{formatCurrency(dailySummary.net.netSales)}</strong>

                    <small>المبيعات بعد خصم المرتجعات</small>
                  </article>

                  <article className="card dashboard-stat-card dashboard-stat-items">
                    <div className="dashboard-stat-header">
                      <span>صافي حركة القطع</span>
                      <span className="dashboard-stat-icon">▥</span>
                    </div>

                    <strong>
                      {formatQuantity(
                        dailySummary.sales.soldItemsQuantity -
                          dailySummary.returns.returnedItemsQuantity,
                      )}
                    </strong>

                    <small>
                      مباع:{' '}
                      {formatQuantity(dailySummary.sales.soldItemsQuantity)} /
                      مرتجع:{' '}
                      {formatQuantity(
                        dailySummary.returns.returnedItemsQuantity,
                      )}
                    </small>
                  </article>
                </section>
              ) : null}

              <section className="panel dashboard-movements-panel">
                <div className="section-header dashboard-table-header">
                  <div>
                    <h2>آخر حركات المخزون</h2>

                    <p className="muted">
                      أحدث عمليات البيع والمرتجعات والاستبدالات والتسويات.
                    </p>
                  </div>

                  <span className="dashboard-record-count">
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
                            <td>
                              <span
                                className={getMovementBadgeClass(
                                  movement.movement_type,
                                )}
                              >
                                {translateStockMovement(movement.movement_type)}
                              </span>
                            </td>

                            <td>{formatQuantity(movement.quantity_before)}</td>

                            <td>
                              <strong
                                className={
                                  Number(movement.quantity) < 0
                                    ? 'stock-quantity stock-quantity-out'
                                    : 'stock-quantity stock-quantity-in'
                                }
                              >
                                {formatQuantity(movement.quantity)}
                              </strong>
                            </td>

                            <td>{formatQuantity(movement.quantity_after)}</td>
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
              initialSaleId={selectedPosSyncSaleId}
              onInitialSaleHandled={() => setSelectedPosSyncSaleId(null)}
              onCreateReturn={openNewReturnFromSale}
              onCreateExchange={openNewExchangeFromSale}
            />
          ) : null}

          {activePage === 'returns' ? (
            <ReturnsPage companyId={companyId} branchId={branchId} />
          ) : null}

          {activePage === 'inventory' ? (
            <InventoryPage companyId={companyId} branchId={branchId} />
          ) : null}

          {activePage === 'inventory-item-card' ? (
            <InventoryItemCardPage />
          ) : null}

          {activePage === 'stock-counts' ? (
            <StockCountsPage companyId={companyId} branchId={branchId} />
          ) : null}

          {activePage === 'inventory-conditions' ? (
            <InventoryConditionsPage
              onOpenTransfers={() => navigateToPage('transfers')}
            />
          ) : null}

          {activePage === 'transfers' ? (
            <TransfersPage companyId={companyId} branchId={branchId} />
          ) : null}

          {activePage === 'purchases' ? (
            <PurchasesPage companyId={companyId} branchId={branchId} />
          ) : null}

          {activePage === 'purchase-orders' ? (
            <PurchaseOrdersPage companyId={companyId} branchId={branchId} />
          ) : null}

          {activePage === 'pos-devices' ? (
            <PosDevicesPage companyId={companyId} branchId={branchId} />
          ) : null}

          {activePage === 'pos-sync' ? (
            <PosSyncPage
              companyId={companyId}
              branchId={branchId}
              onOpenSale={openSaleFromPosSync}
            />
          ) : null}

          {activePage === 'cashier-shifts' ? <CashierShiftsPage /> : null}

          {activePage === 'sales-performance' ? <SalesPerformancePage /> : null}

          {activePage === 'inventory-shortages' ? (
            <InventoryShortagesPage />
          ) : null}

          {activePage === 'product-performance' ? (
            <ProductPerformancePage />
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

          {activePage === 'new-exchange' ? (
            <NewExchangePage
              companyId={companyId}
              branchId={branchId}
              initialSaleId={selectedExchangeSaleId}
              onInitialSaleHandled={() => setSelectedExchangeSaleId(null)}
            />
          ) : null}

          {activePage === 'exchanges' ? (
            <ExchangesPage
              companyId={companyId}
              branchId={branchId}
              onOpenSale={openSaleFromPosSync}
            />
          ) : null}
        </div>
      </section>
    </main>
  )
}

export default App
