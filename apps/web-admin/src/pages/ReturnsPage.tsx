import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { hasPermission } from '../auth/permissions'
// requestJson مسؤول عن إضافة عنوان السيرفر تلقائيًا.
import { requestJson } from '../lib/http'

type ReturnDocument = {
  id: string
  company_id: string
  branch_id: string
  branch_name: string
  stock_location_id: string
  stock_location_name: string
  customer_id: string | null
  customer_name: string | null
  original_sale_id: string | null
  original_sale_number: string | null
  return_number: string
  subtotal: string
  refund_total: string
  status: string
  reason: string | null
  created_at: string
  items_count: number
}

type ReturnItem = {
  id: string
  return_id: string

  // سطر الفاتورة الأصلية الذي تم إرجاع الصنف منه
  original_sale_item_id: string | null

  variant_id: string | null
  sku_snapshot: string | null
  barcode_snapshot: string | null
  product_name_snapshot: string | null
  size_snapshot: string | null
  color_snapshot: string | null
  quantity: string
  unit_price: string

  // القيمة الفعلية التي تم ردها لهذا الصنف
  // Backend يحسبها من سطر الفاتورة الأصلية
  refund_amount: string

  // سبب خاص بالصنف إن كان موجودًا
  reason: string | null
}

type ReturnRefund = {
  id: string
  return_id: string
  method: string
  amount: string
  reference: string | null
  created_at: string
}

type ReturnDetails = {
  return: ReturnDocument
  items: ReturnItem[]
  refunds: ReturnRefund[]
}

type ApiResponse<T> = {
  data: T
}

type ReturnsPageProps = {
  companyId: string
  branchId: string
}

function ReturnsPage({ companyId, branchId }: ReturnsPageProps) {
  const [returns, setReturns] = useState<ReturnDocument[]>([])
  const [selectedReturnDetails, setSelectedReturnDetails] =
    useState<ReturnDetails | null>(null)

  const [loadingReturns, setLoadingReturns] = useState(false)
  const [loadingDetails, setLoadingDetails] = useState(false)
  const [error, setError] = useState('')

  const { user } = useAuth()

  const canViewReturns = hasPermission(user, 'returns.view')

  // ======================================================
  // loadReturns
  // تجيب قائمة المرتجعات
  //
  // لو branchId موجود:
  // نجيب مرتجعات الفرع فقط
  //
  // لو branchId فاضي:
  // نجيب مرتجعات الشركة كلها
  // ======================================================
  async function loadReturns() {
    setLoadingReturns(true)
    setError('')

    try {
      const selectedCompanyId = companyId.trim()
      const selectedBranchId = branchId.trim()

      const returnsUrl =
        `/api/returns` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}` +
        (selectedBranchId
          ? `&branchId=${encodeURIComponent(selectedBranchId)}`
          : '')

      const returnsResponse =
        await requestJson<ApiResponse<ReturnDocument[]>>(returnsUrl)

      setReturns(returnsResponse.data)
      setSelectedReturnDetails(null)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'Unknown returns error',
      )
    } finally {
      setLoadingReturns(false)
    }
  }

  // ======================================================
  // loadReturnDetails
  // تجيب تفاصيل مرتجع واحد
  //
  // التفاصيل تشمل:
  // 1. بيانات المرتجع
  // 2. الأصناف المرتجعة
  // 3. طرق رد المبلغ
  // ======================================================
  async function loadReturnDetails(returnId: string) {
    setLoadingDetails(true)
    setError('')

    try {
      const selectedCompanyId = companyId.trim()

      const returnDetailsUrl =
        `/api/returns/${encodeURIComponent(returnId)}` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}`

      const returnDetailsResponse =
        await requestJson<ApiResponse<ReturnDetails>>(returnDetailsUrl)

      setSelectedReturnDetails(returnDetailsResponse.data)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'Unknown return details error',
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
            <h2>المرتجعات</h2>
            <p className="muted">
              عرض المرتجعات المحفوظة وفتح تفاصيل كل مرتجع.
            </p>
          </div>

          {canViewReturns ? (
            <button
              className="primary-button small-button"
              disabled={!companyId.trim() || loadingReturns}
              onClick={loadReturns}
            >
              {loadingReturns ? 'جاري التحميل...' : 'تحميل المرتجعات'}
            </button>
          ) : null}
        </div>

        {error ? <p className="error-message">{error}</p> : null}

        {returns.length === 0 ? (
          <p className="muted">لا توجد مرتجعات معروضة حتى الآن.</p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>رقم المرتجع</th>
                  <th>الفاتورة الأصلية</th>
                  <th>العميل</th>
                  <th>الفرع</th>
                  <th>الإجمالي</th>
                  <th>المبلغ المرتجع</th>
                  <th>الأصناف</th>
                  <th>الحالة</th>
                  <th>التفاصيل</th>
                </tr>
              </thead>
              <tbody>
                {returns.map((returnDocument) => (
                  <tr key={returnDocument.id}>
                    <td>{returnDocument.return_number}</td>
                    <td>{returnDocument.original_sale_number || '-'}</td>
                    <td>{returnDocument.customer_name || 'بدون عميل'}</td>
                    <td>{returnDocument.branch_name}</td>
                    <td>{returnDocument.subtotal}</td>
                    <td>{returnDocument.refund_total}</td>
                    <td>{returnDocument.items_count}</td>
                    <td>{returnDocument.status}</td>
                    <td>
                      {canViewReturns ? (
                        <button
                          className="table-button"
                          disabled={loadingDetails}
                          onClick={() => loadReturnDetails(returnDocument.id)}
                        >
                          عرض التفاصيل
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

      {selectedReturnDetails ? (
        <section className="panel">
          <div className="section-header">
            <div>
              <h2>تفاصيل المرتجع</h2>
              <p className="muted">
                {selectedReturnDetails.return.return_number} / فاتورة أصلية:{' '}
                {selectedReturnDetails.return.original_sale_number || '-'}
              </p>
            </div>
          </div>

          <section className="mini-cards-grid">
            <article className="mini-card">
              <span>الإجمالي</span>
              <strong>{selectedReturnDetails.return.subtotal}</strong>
            </article>

            <article className="mini-card">
              <span>المبلغ المرتجع</span>
              <strong>{selectedReturnDetails.return.refund_total}</strong>
            </article>

            <article className="mini-card">
              <span>عدد الأصناف</span>
              <strong>{selectedReturnDetails.items.length}</strong>
            </article>

            <article className="mini-card">
              <span>العميل</span>
              <strong>
                {selectedReturnDetails.return.customer_name || 'بدون عميل'}
              </strong>
            </article>

            <article className="mini-card">
              <span>الحالة</span>
              <strong>{selectedReturnDetails.return.status}</strong>
            </article>
          </section>

          <h3>الأصناف المرتجعة</h3>

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
                  <th>السعر الأصلي</th>
                  <th>المبلغ المرتجع</th>
                  <th>السبب</th>
                </tr>
              </thead>
              <tbody>
                {selectedReturnDetails.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.product_name_snapshot || '-'}</td>
                    <td>{item.sku_snapshot || '-'}</td>
                    <td>{item.barcode_snapshot || '-'}</td>
                    <td>{item.size_snapshot || '-'}</td>
                    <td>{item.color_snapshot || '-'}</td>
                    <td>{item.quantity}</td>
                    <td>{item.unit_price}</td>

                    {/* المبلغ الحقيقي الذي تم رده لهذا الصنف */}
                    <td>{item.refund_amount}</td>

                    <td>{item.reason || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>طرق رد المبلغ</h3>

          {selectedReturnDetails.refunds.length === 0 ? (
            <p className="muted">لا توجد بيانات رد مبلغ لهذا المرتجع.</p>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>طريقة الرد</th>
                    <th>المبلغ</th>
                    <th>المرجع</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedReturnDetails.refunds.map((refund) => (
                    <tr key={refund.id}>
                      <td>{refund.method}</td>
                      <td>{refund.amount}</td>
                      <td>{refund.reference || '-'}</td>
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

export default ReturnsPage
