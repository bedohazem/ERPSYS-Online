import { useState } from 'react'

const API_BASE_URL = 'http://localhost:3000'

type Sale = {
  id: string
  company_id: string
  branch_id: string
  branch_name: string
  stock_location_id: string
  stock_location_name: string
  customer_id: string | null
  customer_name: string | null
  sale_number: string
  source: string
  local_sale_id: string | null
  subtotal: string
  discount_total: string
  tax_total: string
  total: string
  paid_total: string
  change_total: string
  status: string
  created_at: string
  synced_at: string | null
  items_count: number
}

type SaleItem = {
  id: string
  sale_id: string
  variant_id: string
  sku_snapshot: string
  barcode_snapshot: string | null
  product_name_snapshot: string
  size_snapshot: string | null
  color_snapshot: string | null
  quantity: string
  unit_price: string
  discount_amount: string
  tax_amount: string
  line_total: string
  created_at: string
}

type SalePayment = {
  id: string
  sale_id: string
  method: string
  amount: string
  reference: string | null
  created_at: string
}

type SaleDetails = {
  sale: Sale & {
    cashier_id: string | null
    cashier_name: string | null
    idempotency_key: string
  }
  items: SaleItem[]
  payments: SalePayment[]
}

type ApiResponse<T> = {
  data: T
}

type SalesPageProps = {
  companyId: string
  branchId: string
}

// ======================================================
// fetchJson
// دالة قراءة من الـ Backend API
//
// لو الـ API رجع Error
// بنعرضه للمستخدم بدل ما الشاشة تقع
// ======================================================
async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  const data = await response.json()

  if (!response.ok) {
    throw new Error(data?.error || 'Request failed')
  }

  return data as T
}

function SalesPage({ companyId, branchId }: SalesPageProps) {
  const [sales, setSales] = useState<Sale[]>([])
  const [selectedSaleDetails, setSelectedSaleDetails] =
    useState<SaleDetails | null>(null)

  const [loadingSales, setLoadingSales] = useState(false)
  const [loadingDetails, setLoadingDetails] = useState(false)
  const [error, setError] = useState('')

  // ======================================================
  // loadSales
  // تجيب قائمة الفواتير
  //
  // لو branchId موجود:
  // نجيب فواتير الفرع فقط
  //
  // لو branchId فاضي:
  // نجيب فواتير الشركة كلها
  // ======================================================
  async function loadSales() {
    setLoadingSales(true)
    setError('')

    try {
      const selectedCompanyId = companyId.trim()
      const selectedBranchId = branchId.trim()

      const salesUrl =
        `${API_BASE_URL}/api/sales` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}` +
        (selectedBranchId
          ? `&branchId=${encodeURIComponent(selectedBranchId)}`
          : '')

      const salesResponse = await fetchJson<ApiResponse<Sale[]>>(salesUrl)

      setSales(salesResponse.data)
      setSelectedSaleDetails(null)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'Unknown sales error',
      )
    } finally {
      setLoadingSales(false)
    }
  }

  // ======================================================
  // loadSaleDetails
  // تجيب تفاصيل فاتورة واحدة
  //
  // التفاصيل تشمل:
  // 1. بيانات الفاتورة
  // 2. الأصناف المباعة
  // 3. طرق الدفع
  // ======================================================
  async function loadSaleDetails(saleId: string) {
    setLoadingDetails(true)
    setError('')

    try {
      const selectedCompanyId = companyId.trim()

      const saleDetailsUrl =
        `${API_BASE_URL}/api/sales/${encodeURIComponent(saleId)}` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}`

      const saleDetailsResponse =
        await fetchJson<ApiResponse<SaleDetails>>(saleDetailsUrl)

      setSelectedSaleDetails(saleDetailsResponse.data)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'Unknown sale details error',
      )
    } finally {
      setLoadingDetails(false)
    }
  }

  return (
    <>
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>الفواتير</h2>
            <p className="muted">
              عرض الفواتير المحفوظة وفتح تفاصيل كل فاتورة.
            </p>
          </div>

          <button
            className="primary-button small-button"
            disabled={!companyId.trim() || loadingSales}
            onClick={loadSales}
          >
            {loadingSales ? 'جاري التحميل...' : 'تحميل الفواتير'}
          </button>
        </div>

        {error ? <p className="error-message">{error}</p> : null}

        {sales.length === 0 ? (
          <p className="muted">لا توجد فواتير معروضة حتى الآن.</p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>رقم الفاتورة</th>
                  <th>العميل</th>
                  <th>الفرع</th>
                  <th>الإجمالي</th>
                  <th>المدفوع</th>
                  <th>الباقي/الباقي للعميل</th>
                  <th>الأصناف</th>
                  <th>الحالة</th>
                  <th>التفاصيل</th>
                </tr>
              </thead>
              <tbody>
                {sales.map((sale) => (
                  <tr key={sale.id}>
                    <td>{sale.sale_number}</td>
                    <td>{sale.customer_name || 'بيع عام'}</td>
                    <td>{sale.branch_name}</td>
                    <td>{sale.total}</td>
                    <td>{sale.paid_total}</td>
                    <td>{sale.change_total}</td>
                    <td>{sale.items_count}</td>
                    <td>{sale.status}</td>
                    <td>
                      <button
                        className="table-button"
                        disabled={loadingDetails}
                        onClick={() => loadSaleDetails(sale.id)}
                      >
                        عرض التفاصيل
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedSaleDetails ? (
        <section className="panel">
          <div className="section-header">
            <div>
              <h2>تفاصيل الفاتورة</h2>
              <p className="muted">
                {selectedSaleDetails.sale.sale_number} /{' '}
                {selectedSaleDetails.sale.customer_name || 'بيع عام'}
              </p>
            </div>
          </div>

          <section className="mini-cards-grid">
            <article className="mini-card">
              <span>الإجمالي</span>
              <strong>{selectedSaleDetails.sale.total}</strong>
            </article>

            <article className="mini-card">
              <span>المدفوع</span>
              <strong>{selectedSaleDetails.sale.paid_total}</strong>
            </article>

            <article className="mini-card">
              <span>الخصم</span>
              <strong>{selectedSaleDetails.sale.discount_total}</strong>
            </article>

            <article className="mini-card">
              <span>الضريبة</span>
              <strong>{selectedSaleDetails.sale.tax_total}</strong>
            </article>

            <article className="mini-card">
              <span>الحالة</span>
              <strong>{selectedSaleDetails.sale.status}</strong>
            </article>
          </section>

          <h3>الأصناف</h3>

          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>الصنف</th>
                  <th>SKU</th>
                  <th>Barcode</th>
                  <th>المقاس</th>
                  <th>اللون</th>
                  <th>الكمية</th>
                  <th>السعر</th>
                  <th>الإجمالي</th>
                </tr>
              </thead>
              <tbody>
                {selectedSaleDetails.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.product_name_snapshot}</td>
                    <td>{item.sku_snapshot}</td>
                    <td>{item.barcode_snapshot || '-'}</td>
                    <td>{item.size_snapshot || '-'}</td>
                    <td>{item.color_snapshot || '-'}</td>
                    <td>{item.quantity}</td>
                    <td>{item.unit_price}</td>
                    <td>{item.line_total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>طرق الدفع</h3>

          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>طريقة الدفع</th>
                  <th>المبلغ</th>
                  <th>مرجع الدفع</th>
                </tr>
              </thead>
              <tbody>
                {selectedSaleDetails.payments.map((payment) => (
                  <tr key={payment.id}>
                    <td>{payment.method}</td>
                    <td>{payment.amount}</td>
                    <td>{payment.reference || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  )
}

export default SalesPage
