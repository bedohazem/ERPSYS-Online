import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { hasPermission } from '../auth/permissions'
// requestJson مسؤول عن إضافة عنوان السيرفر تلقائيًا.
import { ApiError, requestJson } from '../lib/http'

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

  void_reason: string | null
  voided_by: string | null
  voided_by_name: string | null
  voided_at: string | null

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

  refund_role: 'refund' | 'void_reversal'

  payment_direction: 'refunded_to_customer' | 'collected_from_customer'

  reverses_refund_id: string | null

  created_at: string
}

type ReturnStockMovement = {
  id: string
  variant_id: string

  sku: string

  primary_barcode: string | null

  product_name: string

  size_name: string | null

  color_name: string | null

  stock_location_name: string

  movement_type: string

  quantity: string
  quantity_before: string
  quantity_after: string

  reference_type: string | null

  reference_id: string | null

  reversal_of_movement_id: string | null

  note: string | null

  created_at: string
}

type ReturnDetails = {
  return: ReturnDocument
  items: ReturnItem[]
  refunds: ReturnRefund[]
  stockMovements: ReturnStockMovement[]
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

function translateRefundDirection(direction: string) {
  if (direction === 'refunded_to_customer') {
    return 'تم رده للعميل'
  }

  if (direction === 'collected_from_customer') {
    return 'تم تحصيله من العميل'
  }

  return direction
}

function getReturnMovementClass(quantity: number | string) {
  const numericQuantity = Number(quantity)

  if (numericQuantity > 0) {
    return 'movement-badge ' + 'movement-badge-in'
  }

  if (numericQuantity < 0) {
    return 'movement-badge ' + 'movement-badge-out'
  }

  return 'movement-badge'
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

  const [success, setSuccess] = useState('')

  const [voidingReturnId, setVoidingReturnId] = useState<string | null>(null)

  const { user } = useAuth()

  const canReadReturns =
    hasPermission(user, 'returns.view') ||
    hasPermission(user, 'returns.create') ||
    hasPermission(user, 'returns.void')

  const canVoidReturn = hasPermission(user, 'returns.void')

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
    if (!canReadReturns || !companyId.trim()) {
      return
    }

    void loadReturns()
  }, [canReadReturns, companyId, branchId])

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

  async function voidReturn(returnDocument: {
    id: string
    return_number: string
    status: string
    refund_total: string
  }) {
    if (!canVoidReturn || voidingReturnId) {
      return
    }

    if (returnDocument.status !== 'completed') {
      setError('لا يمكن إلغاء إلا مرتجع مكتمل.')

      return
    }

    const reason = window.prompt('سبب إلغاء المرتجع — مطلوب:', '')

    if (reason === null) {
      return
    }

    if (reason.trim().length < 3) {
      setError('سبب الإلغاء يجب ألا يقل عن 3 أحرف.')

      return
    }

    const enteredReference = window.prompt(
      'مرجع تحصيل المبلغ من العميل — اختياري:',
      '',
    )

    if (enteredReference === null) {
      return
    }

    const collectionReference = enteredReference.trim()

    const confirmed = window.confirm(
      `إلغاء المرتجع ${returnDocument.return_number}؟\n\n` +
        `سيتم خصم الأصناف المرتجعة من المخزون.\n` +
        `وسيتم تسجيل تحصيل ${formatReturnCurrency(
          returnDocument.refund_total,
        )} من العميل.\n\n` +
        'لن يتم حذف السجلات الأصلية، وسيتم إنشاء سجلات عكسية مرتبطة بها.',
    )

    if (!confirmed) {
      return
    }

    setVoidingReturnId(returnDocument.id)

    setError('')
    setSuccess('')

    try {
      const response = await requestJson<
        ApiResponse<{
          return: ReturnDocument

          stockReversalIds: string[]

          refundReversalIds: string[]
        }> & {
          alreadyVoided: boolean
        }
      >(
        `/api/returns/${encodeURIComponent(returnDocument.id)}/void`,

        {
          method: 'POST',

          headers: {
            'Content-Type': 'application/json',
          },

          body: JSON.stringify({
            reason: reason.trim(),

            collectionReference: collectionReference || null,
          }),
        },
      )

      await loadReturns()

      await loadReturnDetails(returnDocument.id)

      setSuccess(
        response.alreadyVoided
          ? 'المرتجع ملغى بالفعل، ولم تتكرر أي حركة.'
          : `تم إلغاء المرتجع ${returnDocument.return_number} وعكس المخزون والمبلغ المرتجع.`,
      )
    } catch (currentError) {
      if (currentError instanceof ApiError) {
        const errorData = currentError.data as {
          details?: {
            shortages?: Array<{
              variantId?: unknown
              currentQuantity?: unknown
              reversalQuantity?: unknown
              finalQuantity?: unknown
            }>
          }
        } | null

        const shortages = errorData?.details?.shortages

        if (Array.isArray(shortages) && shortages.length > 0) {
          const shortageText = shortages
            .map(
              (shortage) =>
                `${String(shortage.variantId || '-')}: الحالي ${String(
                  shortage.currentQuantity ?? 0,
                )}، حركة الإلغاء ${String(
                  shortage.reversalQuantity ?? 0,
                )}، الناتج ${String(shortage.finalQuantity ?? 0)}`,
            )
            .join(' — ')

          setError(`${currentError.message}: ${shortageText}`)
        } else {
          setError(currentError.message)
        }
      } else {
        setError(
          currentError instanceof Error
            ? currentError.message
            : 'تعذر إلغاء المرتجع.',
        )
      }
    } finally {
      setVoidingReturnId(null)
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

          {canReadReturns ? (
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
        {success ? <p className="success-message">{success}</p> : null}

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
                  <th>الإجراءات</th>
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
                      <div className="section-actions">
                        {canReadReturns ? (
                          <button
                            type="button"
                            className="table-button"
                            disabled={
                              loadingDetails || voidingReturnId !== null
                            }
                            onClick={() =>
                              void loadReturnDetails(returnDocument.id)
                            }
                          >
                            عرض التفاصيل
                          </button>
                        ) : null}

                        {canVoidReturn &&
                        returnDocument.status === 'completed' ? (
                          <button
                            type="button"
                            className="table-button danger-button"
                            disabled={voidingReturnId !== null}
                            onClick={() => void voidReturn(returnDocument)}
                          >
                            {voidingReturnId === returnDocument.id
                              ? 'جاري الإلغاء...'
                              : 'إلغاء المرتجع'}
                          </button>
                        ) : returnDocument.status === 'voided' ? (
                          <span className="muted">تم الإلغاء</span>
                        ) : null}
                      </div>
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
            <div className="section-actions">
              {canVoidReturn &&
              selectedReturnDetails.return.status === 'completed' ? (
                <button
                  type="button"
                  className="table-button danger-button"
                  disabled={voidingReturnId !== null}
                  onClick={() => void voidReturn(selectedReturnDetails.return)}
                >
                  {voidingReturnId === selectedReturnDetails.return.id
                    ? 'جاري الإلغاء...'
                    : 'إلغاء المرتجع'}
                </button>
              ) : null}

              <button
                type="button"
                className="table-button"
                disabled={loadingDetails || voidingReturnId !== null}
                onClick={() => setSelectedReturnDetails(null)}
              >
                إغلاق التفاصيل
              </button>
            </div>
          </div>

          {selectedReturnDetails.return.status === 'voided' ? (
            <p className="error-message">
              تم إلغاء هذا المرتجع
              {selectedReturnDetails.return.voided_at
                ? ` بتاريخ ${formatReturnDateTime(
                    selectedReturnDetails.return.voided_at,
                  )}`
                : ''}
              {selectedReturnDetails.return.voided_by_name
                ? ` بواسطة ${selectedReturnDetails.return.voided_by_name}`
                : ''}
              {selectedReturnDetails.return.void_reason
                ? ` — السبب: ${selectedReturnDetails.return.void_reason}`
                : ''}
            </p>
          ) : null}

          {selectedReturnDetails.return.status === 'completed' &&
          canVoidReturn ? (
            <p className="muted">
              عند الإلغاء سيتم خصم الأصناف التي دخلت المخزون بسبب المرتجع، كما
              سيتم تسجيل تحصيل المبلغ الذي سبق رده للعميل.
            </p>
          ) : null}

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

          <h3>الحركات المالية للمرتجع</h3>

          {selectedReturnDetails.refunds.length === 0 ? (
            <p className="muted">لا توجد بيانات رد مبلغ لهذا المرتجع.</p>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>نوع السجل</th>
                    <th>الاتجاه</th>
                    <th>الطريقة</th>
                    <th>المبلغ</th>
                    <th>المرجع</th>
                    <th>التاريخ</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedReturnDetails.refunds.map((refund) => (
                    <tr key={refund.id}>
                      <td>
                        {refund.refund_role === 'void_reversal' ? (
                          <span className="status-badge status-badge-warning">
                            تحصيل بسبب الإلغاء
                          </span>
                        ) : (
                          <span className="status-badge status-badge-success">
                            رد المبلغ الأصلي
                          </span>
                        )}
                      </td>

                      <td>
                        {translateRefundDirection(refund.payment_direction)}
                      </td>
                      <td>
                        <span className="payment-method-badge">
                          {translateRefundMethod(refund.method)}
                        </span>
                      </td>

                      <td className="money-cell refund-money-cell">
                        {formatReturnCurrency(refund.amount)}
                      </td>
                      <td>{refund.reference || '-'}</td>
                      <td>{formatReturnDateTime(refund.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3>حركات المخزون</h3>

          {selectedReturnDetails.stockMovements.length === 0 ? (
            <p className="muted">لا توجد حركات مخزون مرتبطة بهذا المرتجع.</p>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>نوع السجل</th>
                    <th>الصنف</th>
                    <th>SKU</th>
                    <th>المقاس</th>
                    <th>اللون</th>
                    <th>قبل</th>
                    <th>الحركة</th>
                    <th>بعد</th>
                    <th>مكان التخزين</th>
                    <th>التاريخ</th>
                  </tr>
                </thead>

                <tbody>
                  {selectedReturnDetails.stockMovements.map((movement) => (
                    <tr key={movement.id}>
                      <td>
                        {movement.reversal_of_movement_id ? (
                          <span className="status-badge status-badge-warning">
                            حركة عكسية
                          </span>
                        ) : (
                          <span className="status-badge status-badge-success">
                            حركة أصلية
                          </span>
                        )}
                      </td>

                      <td>{movement.product_name}</td>

                      <td>{movement.sku}</td>

                      <td>{movement.size_name || '-'}</td>

                      <td>{movement.color_name || '-'}</td>

                      <td>{formatReturnQuantity(movement.quantity_before)}</td>

                      <td>
                        <span
                          className={getReturnMovementClass(movement.quantity)}
                        >
                          {formatReturnQuantity(movement.quantity)}
                        </span>
                      </td>

                      <td>{formatReturnQuantity(movement.quantity_after)}</td>

                      <td>{movement.stock_location_name}</td>

                      <td>{formatReturnDateTime(movement.created_at)}</td>
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
