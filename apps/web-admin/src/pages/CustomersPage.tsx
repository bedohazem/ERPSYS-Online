import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../auth/AuthContext'
// requestJson مسؤول عن إضافة عنوان السيرفر تلقائيًا.
import { requestJson } from '../lib/http'

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

// ======================================================
// تنسيق مبالغ وتواريخ شاشة العملاء.
// ======================================================
const customerCurrencyFormatter = new Intl.NumberFormat('ar-EG', {
  style: 'currency',
  currency: 'EGP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})

const customerDateTimeFormatter = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatCustomerCurrency(value: number | string) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? customerCurrencyFormatter.format(numericValue)
    : '-'
}

function formatCustomerDateTime(value: string) {
  const parsedDate = new Date(value)

  return Number.isNaN(parsedDate.getTime())
    ? '-'
    : customerDateTimeFormatter.format(parsedDate)
}

// ======================================================
// ترجمة حالات مستندات نشاط العميل.
// ======================================================
function translateCustomerActivityStatus(status: string) {
  const statusLabels: Record<string, string> = {
    draft: 'مسودة',
    completed: 'مكتمل',
    voided: 'ملغى',
    refunded: 'مرتجع بالكامل',
    pending_review: 'بانتظار المراجعة',
  }

  return statusLabels[status] || status
}

function getCustomerActivityStatusClass(status: string) {
  if (status === 'completed') {
    return 'status-badge status-badge-success'
  }

  if (status === 'refunded') {
    return 'status-badge status-badge-info'
  }

  if (status === 'voided') {
    return 'status-badge status-badge-danger'
  }

  if (status === 'draft' || status === 'pending_review') {
    return 'status-badge status-badge-warning'
  }

  return 'status-badge'
}

function getCustomerActivityTypeClass(
  activityType: CustomerActivityItem['activity_type'],
) {
  return activityType === 'sale'
    ? 'customer-activity-badge customer-activity-sale'
    : 'customer-activity-badge customer-activity-return'
}

type CustomersPageProps = {
  companyId: string
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
  async function loadCustomers(searchOverride?: string) {
    setLoadingCustomers(true)
    setError('')

    try {
      const selectedCompanyId = companyId.trim()
      const query = (searchOverride ?? searchText).trim()

      const customersUrl =
        `/api/customers` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}` +
        (query ? `&q=${encodeURIComponent(query)}` : '')

      const customersResponse =
        await requestJson<ApiResponse<Customer[]>>(customersUrl)

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
  // تنفيذ البحث عند الضغط على Enter أو زر البحث.
  // ======================================================
  function submitCustomerSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSelectedCustomerActivity(null)
    void loadCustomers()
  }

  // ======================================================
  // مسح نص البحث وإعادة آخر العملاء.
  // ======================================================
  function clearCustomerSearch() {
    setSearchText('')
    setSelectedCustomerActivity(null)
    void loadCustomers('')
  }

  // ======================================================
  // تحميل قائمة العملاء تلقائيًا عند فتح الصفحة.
  //
  // البحث لا يعمل مع كل حرف لتجنب إرسال طلبات كثيرة.
  // زر البحث يستخدم لتطبيق النص المكتوب يدويًا.
  // ======================================================
  useEffect(() => {
    if (!canViewCustomers || !companyId.trim()) {
      return
    }

    void loadCustomers()
  }, [canViewCustomers, companyId])

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
        `/api/customers/${encodeURIComponent(customerId)}` +
        `/activity?companyId=${encodeURIComponent(selectedCompanyId)}`

      const activityResponse =
        await requestJson<ApiResponse<CustomerActivityResponse>>(activityUrl)

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
            <div className="section-actions">
              <span className="record-count-badge">
                {customers.length} عميل
              </span>

              <button
                type="button"
                className="table-button"
                disabled={!companyId.trim() || loadingCustomers}
                onClick={() => void loadCustomers()}
              >
                {loadingCustomers ? 'جاري التحديث...' : 'تحديث'}
              </button>
            </div>
          ) : null}
        </div>

        <form className="customer-list-search" onSubmit={submitCustomerSearch}>
          <label className="customer-search-field">
            بحث بالاسم أو رقم الهاتف أو البريد الإلكتروني
            <input
              value={searchText}
              disabled={loadingCustomers}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="مثال: أحمد أو 010 أو البريد الإلكتروني"
            />
          </label>

          <div className="customer-search-actions">
            <button
              type="submit"
              className="primary-button small-button"
              disabled={!companyId.trim() || loadingCustomers}
            >
              {loadingCustomers ? 'جاري البحث...' : 'بحث'}
            </button>

            <button
              type="button"
              className="table-button"
              disabled={loadingCustomers || !searchText.trim()}
              onClick={clearCustomerSearch}
            >
              مسح البحث
            </button>
          </div>
        </form>

        {error ? <p className="error-message">{error}</p> : null}

        {customers.length === 0 ? (
          <p className="muted">
            {loadingCustomers
              ? 'جاري تحميل العملاء...'
              : searchText.trim()
                ? 'لا توجد نتائج مطابقة للبحث.'
                : 'لا يوجد عملاء مسجلون حاليًا.'}
          </p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>اسم العميل</th>
                  <th>التليفون</th>
                  <th>الإيميل</th>
                  <th>العنوان</th>
                  <th>تاريخ التسجيل</th>
                  <th>الحالة</th>
                  <th>النشاط</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => (
                  <tr key={customer.id}>
                    <td>
                      <strong className="customer-name">{customer.name}</strong>
                    </td>

                    <td>
                      {customer.phone ? (
                        <a
                          className="customer-contact-link"
                          href={`tel:${customer.phone}`}
                        >
                          {customer.phone}
                        </a>
                      ) : (
                        '-'
                      )}
                    </td>

                    <td>
                      {customer.email ? (
                        <a
                          className="customer-contact-link"
                          href={`mailto:${customer.email}`}
                        >
                          {customer.email}
                        </a>
                      ) : (
                        '-'
                      )}
                    </td>

                    <td>{customer.address || '-'}</td>

                    <td>{formatCustomerDateTime(customer.created_at)}</td>

                    <td>
                      <span
                        className={
                          customer.is_active
                            ? 'status-badge status-badge-success'
                            : 'status-badge status-badge-danger'
                        }
                      >
                        {customer.is_active ? 'نشط' : 'غير نشط'}
                      </span>
                    </td>
                    <td>
                      {canViewCustomers ? (
                        <button
                          type="button"
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
            <button
              type="button"
              className="table-button"
              disabled={loadingActivity}
              onClick={() => setSelectedCustomerActivity(null)}
            >
              إغلاق النشاط
            </button>
          </div>

          <section className="mini-cards-grid">
            <article className="mini-card">
              <span>عدد الفواتير</span>
              <strong>{selectedCustomerActivity.summary.sales_count}</strong>
            </article>

            <article className="mini-card">
              <span>إجمالي المبيعات</span>
              <strong>
                {formatCustomerCurrency(
                  selectedCustomerActivity.summary.total_sales,
                )}
              </strong>
            </article>

            <article className="mini-card">
              <span>عدد المرتجعات</span>
              <strong>{selectedCustomerActivity.summary.returns_count}</strong>
            </article>

            <article className="mini-card">
              <span>إجمالي المرتجع</span>
              <strong className="refund-total-value">
                {formatCustomerCurrency(
                  selectedCustomerActivity.summary.total_refunded,
                )}
              </strong>
            </article>

            <article className="mini-card">
              <span>الصافي</span>
              <strong>
                {formatCustomerCurrency(
                  selectedCustomerActivity.summary.net_sales,
                )}
              </strong>
            </article>
          </section>

          <div className="section-header customer-activity-header">
            <div>
              <h3>سجل التعاملات</h3>

              <p className="muted">فواتير البيع والمرتجعات مرتبة من الأحدث.</p>
            </div>

            <span className="record-count-badge">
              {selectedCustomerActivity.activity.length} حركة
            </span>
          </div>

          {selectedCustomerActivity.activity.length === 0 ? (
            <p className="muted">لا توجد حركات لهذا العميل.</p>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>النوع</th>
                    <th>رقم المستند</th>
                    <th>التاريخ</th>
                    <th>المبلغ</th>
                    <th>مدفوع</th>
                    <th>مرتجع</th>
                    <th>عدد الأصناف</th>
                    <th>الفرع</th>
                    <th>مكان المخزون</th>
                    <th>الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedCustomerActivity.activity.map((activity) => (
                    <tr
                      key={`${activity.activity_type}-${activity.activity_id}`}
                    >
                      <td>
                        <span
                          className={getCustomerActivityTypeClass(
                            activity.activity_type,
                          )}
                        >
                          {activity.activity_type === 'sale'
                            ? 'فاتورة بيع'
                            : 'مرتجع'}
                        </span>
                      </td>

                      <td>
                        <strong className="document-number">
                          {activity.document_number}
                        </strong>
                      </td>

                      <td>{formatCustomerDateTime(activity.created_at)}</td>

                      <td className="money-cell">
                        {formatCustomerCurrency(activity.amount)}
                      </td>

                      <td className="money-cell">
                        {formatCustomerCurrency(activity.paid_amount)}
                      </td>

                      <td className="money-cell refund-money-cell">
                        {formatCustomerCurrency(activity.refund_amount)}
                      </td>

                      <td>{activity.items_count}</td>
                      <td>{activity.branch_name}</td>
                      <td>{activity.stock_location_name}</td>

                      <td>
                        <span
                          className={getCustomerActivityStatusClass(
                            activity.status,
                          )}
                        >
                          {translateCustomerActivityStatus(activity.status)}
                        </span>
                      </td>
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
