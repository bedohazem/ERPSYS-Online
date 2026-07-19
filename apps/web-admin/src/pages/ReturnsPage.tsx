import { useEffect, useState } from 'react'
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

// ======================================================
// تنسيق مبالغ وكميات وتواريخ المرتجعات.
// ======================================================
const returnsCurrencyFormatter = new Intl.NumberFormat('ar-EG', {
  style: 'currency',
  currency: 'EGP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})

const returnsQuantityFormatter = new Intl.NumberFormat('ar-EG', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
})

const returnsDateTimeFormatter = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatReturnCurrency(value: number | string) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? returnsCurrencyFormatter.format(numericValue)
    : '-'
}

function formatReturnQuantity(value: number | string) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? returnsQuantityFormatter.format(numericValue)
    : '-'
}

function formatReturnDateTime(value: string) {
  const parsedDate = new Date(value)

  return Number.isNaN(parsedDate.getTime())
    ? '-'
    : returnsDateTimeFormatter.format(parsedDate)
}

// ======================================================
// ترجمة حالات المرتجعات المعرفة في قاعدة البيانات.
// ======================================================
function translateReturnStatus(status: string) {
  const statusLabels: Record<string, string> = {
    draft: 'مسودة',
    completed: 'مكتمل',
    voided: 'ملغى',
    pending_review: 'بانتظار المراجعة',
  }

  return statusLabels[status] || status
}

function getReturnStatusClass(status: string) {
  if (status === 'completed') {
    return 'status-badge status-badge-success'
  }

  if (status === 'voided') {
    return 'status-badge status-badge-danger'
  }

  if (status === 'draft' || status === 'pending_review') {
    return 'status-badge status-badge-warning'
  }

  return 'status-badge'
}

// ======================================================
// ترجمة طرق رد المبلغ المعرفة في قاعدة البيانات.
// ======================================================
function translateRefundMethod(method: string) {
  const methodLabels: Record<string, string> = {
    cash: 'نقدي',
    card: 'بطاقة بنكية',
    wallet: 'محفظة إلكترونية',
    bank_transfer: 'تحويل بنكي',
    other: 'طريقة أخرى',
  }

  return methodLabels[method] || method
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
  // تحميل المرتجعات تلقائيًا عند فتح الصفحة
  // أو تغير الشركة أو الفرع المرتبط بالجلسة.
  // ======================================================
  useEffect(() => {
    if (!canViewReturns || !companyId.trim()) {
      return
    }

    void loadReturns()
  }, [canViewReturns, companyId, branchId])

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
            <div className="section-actions">
              <span className="record-count-badge">{returns.length} مرتجع</span>

              <button
                type="button"
                className="primary-button small-button"
                disabled={!companyId.trim() || loadingReturns}
                onClick={loadReturns}
              >
                {loadingReturns ? 'جاري التحديث...' : 'تحديث البيانات'}
              </button>
            </div>
          ) : null}
        </div>

        {error ? <p className="error-message">{error}</p> : null}

        {returns.length === 0 ? (
          <p className="muted">
            {loadingReturns
              ? 'جاري تحميل المرتجعات...'
              : 'لا توجد مرتجعات مسجلة حاليًا.'}
          </p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>رقم المرتجع</th>
                  <th>التاريخ</th>
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
                    <td>
                      <strong className="document-number">
                        {returnDocument.return_number}
                      </strong>
                    </td>

                    <td>{formatReturnDateTime(returnDocument.created_at)}</td>

                    <td>
                      {returnDocument.original_sale_number ? (
                        <span className="original-document-number">
                          {returnDocument.original_sale_number}
                        </span>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td>{returnDocument.customer_name || 'بدون عميل'}</td>
                    <td>{returnDocument.branch_name}</td>
                    <td className="money-cell">
                      {formatReturnCurrency(returnDocument.subtotal)}
                    </td>

                    <td className="money-cell refund-money-cell">
                      {formatReturnCurrency(returnDocument.refund_total)}
                    </td>

                    <td>{returnDocument.items_count}</td>

                    <td>
                      <span
                        className={getReturnStatusClass(returnDocument.status)}
                      >
                        {translateReturnStatus(returnDocument.status)}
                      </span>
                    </td>
                    <td>
                      {canViewReturns ? (
                        <button
                          type="button"
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
                {selectedReturnDetails.return.return_number}
                {' • '}
                فاتورة أصلية:{' '}
                {selectedReturnDetails.return.original_sale_number || '-'}
                {' • '}
                {formatReturnDateTime(selectedReturnDetails.return.created_at)}
              </p>
            </div>
            <button
              type="button"
              className="table-button"
              disabled={loadingDetails}
              onClick={() => setSelectedReturnDetails(null)}
            >
              إغلاق التفاصيل
            </button>
          </div>

          <section className="mini-cards-grid">
            <article className="mini-card">
              <span>الإجمالي</span>
              <strong>
                {formatReturnCurrency(selectedReturnDetails.return.subtotal)}
              </strong>
            </article>

            <article className="mini-card">
              <span>المبلغ المرتجع</span>
              <strong className="refund-total-value">
                {formatReturnCurrency(
                  selectedReturnDetails.return.refund_total,
                )}
              </strong>
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

              <div className="mini-card-status">
                <span
                  className={getReturnStatusClass(
                    selectedReturnDetails.return.status,
                  )}
                >
                  {translateReturnStatus(selectedReturnDetails.return.status)}
                </span>
              </div>
            </article>
          </section>

          {selectedReturnDetails.return.reason ? (
            <div className="return-reason-card">
              <span>سبب المرتجع</span>

              <strong>{selectedReturnDetails.return.reason}</strong>
            </div>
          ) : null}

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
                    <td>{formatReturnQuantity(item.quantity)}</td>

                    <td className="money-cell">
                      {formatReturnCurrency(item.unit_price)}
                    </td>

                    {/* المبلغ الحقيقي الذي تم رده لهذا الصنف */}
                    <td className="money-cell refund-money-cell">
                      {formatReturnCurrency(item.refund_amount)}
                    </td>

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
                      <td>
                        <span className="payment-method-badge">
                          {translateRefundMethod(refund.method)}
                        </span>
                      </td>

                      <td className="money-cell refund-money-cell">
                        {formatReturnCurrency(refund.amount)}
                      </td>
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
