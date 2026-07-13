import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'

const API_BASE_URL = 'http://localhost:3000'

type Customer = {
  id: string
  name: string
  phone: string | null
  email: string | null
  address: string | null
  is_active: boolean
  created_at: string
}

type CustomerActivityItem = {
  activity_type: 'sale' | 'return'
  activity_id: string
  document_number: string
  amount: string
  paid_amount: string
  refund_amount: string
  status: string
  created_at: string
  branch_name: string
  stock_location_name: string
  items_count: number
}

type CustomerActivitySummary = {
  sales_count: number
  total_sales: string
  returns_count: number
  total_refunded: string
  net_sales: string
}

type CustomerActivityResponse = {
  customer: Customer
  summary: CustomerActivitySummary
  activity: CustomerActivityItem[]
}

type ApiResponse<T> = {
  data: T
}

type CustomersPageProps = {
  companyId: string
}

// ======================================================
// fetchJson
// دالة قراءة عامة من الـ API
//
// لو الـ API رجع error
// بنرمي Error عشان نعرضه في الشاشة
// ======================================================
async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  const data = await response.json()

  if (!response.ok) {
    throw new Error(data?.error || 'Request failed')
  }

  return data as T
}

function CustomersPage({ companyId }: CustomersPageProps) {
  const [searchText, setSearchText] = useState('')
  const [customers, setCustomers] = useState<Customer[]>([])
  const [selectedCustomerActivity, setSelectedCustomerActivity] =
    useState<CustomerActivityResponse | null>(null)

  const [loadingCustomers, setLoadingCustomers] = useState(false)
  const [loadingActivity, setLoadingActivity] = useState(false)
  const [error, setError] = useState('')

  const { user } = useAuth()

  const canViewCustomers =
    user?.roles.includes('admin') ||
    user?.permissions.includes('customers.view') ||
    false

  // ======================================================
  // loadCustomers
  // تجيب قائمة العملاء
  //
  // لو searchText فاضي:
  // تجيب آخر العملاء
  //
  // لو searchText فيه قيمة:
  // تبحث بالاسم أو التليفون أو الإيميل
  // ======================================================
  async function loadCustomers() {
    setLoadingCustomers(true)
    setError('')

    try {
      const selectedCompanyId = companyId.trim()
      const query = searchText.trim()

      const customersUrl =
        `${API_BASE_URL}/api/customers` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}` +
        (query ? `&q=${encodeURIComponent(query)}` : '')

      const customersResponse =
        await fetchJson<ApiResponse<Customer[]>>(customersUrl)

      setCustomers(customersResponse.data)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'Unknown customers error',
      )
    } finally {
      setLoadingCustomers(false)
    }
  }

  // ======================================================
  // loadCustomerActivity
  // تجيب نشاط عميل واحد
  //
  // النشاط يشمل:
  // - sales
  // - returns
  // - net sales
  // - timeline مرتب بالتاريخ
  // ======================================================
  async function loadCustomerActivity(customerId: string) {
    setLoadingActivity(true)
    setError('')

    try {
      const selectedCompanyId = companyId.trim()

      const activityUrl =
        `${API_BASE_URL}/api/customers/${encodeURIComponent(customerId)}` +
        `/activity?companyId=${encodeURIComponent(selectedCompanyId)}`

      const activityResponse =
        await fetchJson<ApiResponse<CustomerActivityResponse>>(activityUrl)

      setSelectedCustomerActivity(activityResponse.data)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'Unknown customer activity error',
      )
    } finally {
      setLoadingActivity(false)
    }
  }

  return (
    <>
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>العملاء</h2>
            <p className="muted">
              عرض العملاء والبحث عن عميل ثم فتح نشاطه بالكامل.
            </p>
          </div>

          {canViewCustomers ? (
            <button
              className="primary-button small-button"
              disabled={!companyId.trim() || loadingCustomers}
              onClick={loadCustomers}
            >
              {loadingCustomers ? 'جاري التحميل...' : 'تحميل العملاء'}
            </button>
          ) : null}
        </div>

        <div className="single-search-row">
          <label>
            بحث باسم العميل أو التليفون
            <input
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="مثال: Ahmed أو 010"
            />
          </label>
        </div>

        {error ? <p className="error-message">{error}</p> : null}

        {customers.length === 0 ? (
          <p className="muted">لا توجد عملاء معروضين حتى الآن.</p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>اسم العميل</th>
                  <th>التليفون</th>
                  <th>الإيميل</th>
                  <th>العنوان</th>
                  <th>الحالة</th>
                  <th>النشاط</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => (
                  <tr key={customer.id}>
                    <td>{customer.name}</td>
                    <td>{customer.phone || '-'}</td>
                    <td>{customer.email || '-'}</td>
                    <td>{customer.address || '-'}</td>
                    <td>{customer.is_active ? 'نشط' : 'غير نشط'}</td>
                    <td>
                      {canViewCustomers ? (
                        <button
                          className="table-button"
                          disabled={loadingActivity}
                          onClick={() => loadCustomerActivity(customer.id)}
                        >
                          عرض النشاط
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedCustomerActivity ? (
        <section className="panel">
          <div className="section-header">
            <div>
              <h2>نشاط العميل</h2>
              <p className="muted">
                {selectedCustomerActivity.customer.name} /{' '}
                {selectedCustomerActivity.customer.phone || 'بدون تليفون'}
              </p>
            </div>
          </div>

          <section className="mini-cards-grid">
            <article className="mini-card">
              <span>عدد الفواتير</span>
              <strong>{selectedCustomerActivity.summary.sales_count}</strong>
            </article>

            <article className="mini-card">
              <span>إجمالي المبيعات</span>
              <strong>{selectedCustomerActivity.summary.total_sales}</strong>
            </article>

            <article className="mini-card">
              <span>عدد المرتجعات</span>
              <strong>{selectedCustomerActivity.summary.returns_count}</strong>
            </article>

            <article className="mini-card">
              <span>إجمالي المرتجع</span>
              <strong>{selectedCustomerActivity.summary.total_refunded}</strong>
            </article>

            <article className="mini-card">
              <span>الصافي</span>
              <strong>{selectedCustomerActivity.summary.net_sales}</strong>
            </article>
          </section>

          <h3>Timeline</h3>

          {selectedCustomerActivity.activity.length === 0 ? (
            <p className="muted">لا توجد حركات لهذا العميل.</p>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>النوع</th>
                    <th>رقم المستند</th>
                    <th>المبلغ</th>
                    <th>مدفوع</th>
                    <th>مرتجع</th>
                    <th>عدد الأصناف</th>
                    <th>الفرع</th>
                    <th>الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedCustomerActivity.activity.map((activity) => (
                    <tr
                      key={`${activity.activity_type}-${activity.activity_id}`}
                    >
                      <td>
                        {activity.activity_type === 'sale' ? 'بيع' : 'مرتجع'}
                      </td>
                      <td>{activity.document_number}</td>
                      <td>{activity.amount}</td>
                      <td>{activity.paid_amount}</td>
                      <td>{activity.refund_amount}</td>
                      <td>{activity.items_count}</td>
                      <td>{activity.branch_name}</td>
                      <td>{activity.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </>
  )
}

export default CustomersPage
