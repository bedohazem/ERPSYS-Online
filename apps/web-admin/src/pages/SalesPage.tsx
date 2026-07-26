import { useEffect, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
// requestJson مسؤول عن إضافة عنوان السيرفر تلقائيًا.
import { ApiError, requestJson } from '../lib/http'

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

  shift_id: string | null

  shift_status: 'open' | 'closed' | null

  shift_closed_at: string | null

  subtotal: string
  discount_total: string
  tax_total: string
  total: string
  paid_total: string
  change_total: string
  status: string
  void_reason: string | null

  voided_by: string | null

  voided_by_name: string | null

  voided_at: string | null

  // وقت البيع الحقيقي من جهاز POS.
  occurred_at: string

  // وقت إنشاء السجل على PostgreSQL.
  created_at: string

  synced_at: string | null
  items_count: number

  // إجمالي الكمية المباعة داخل الفاتورة
  sold_quantity: string

  // الكمية التي تم إرجاعها سابقًا
  returned_quantity: string

  // الكمية التي ما زال يمكن إرجاعها
  remaining_returnable_quantity: string
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
  already_returned_quantity: string

  remaining_returnable_quantity: string
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

  payment_role: 'sale_collection' | 'void_reversal'

  payment_direction: 'received_from_customer' | 'refunded_to_customer'

  reverses_payment_id: string | null

  created_at: string
}

type SaleStockMovement = {
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

  reversal_of_movement_id: string | null

  note: string | null

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
  stockMovements: SaleStockMovement[]
}

type ApiResponse<T> = {
  data: T
}

// ======================================================
// تنسيق مبالغ وكميات وتواريخ فواتير المبيعات.
// ======================================================
const salesCurrencyFormatter = new Intl.NumberFormat('ar-EG', {
  style: 'currency',
  currency: 'EGP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})

const salesQuantityFormatter = new Intl.NumberFormat('ar-EG', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
})

const salesDateTimeFormatter = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatSaleCurrency(value: number | string) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? salesCurrencyFormatter.format(numericValue)
    : '-'
}

function formatSaleQuantity(value: number | string) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? salesQuantityFormatter.format(numericValue)
    : '-'
}

function formatSaleDateTime(value: string) {
  const parsedDate = new Date(value)

  return Number.isNaN(parsedDate.getTime())
    ? '-'
    : salesDateTimeFormatter.format(parsedDate)
}

// ======================================================
// ترجمة حالات الفواتير المعرفة داخل قاعدة البيانات.
// ======================================================
function translateSaleStatus(status: string) {
  const statusLabels: Record<string, string> = {
    draft: 'مسودة',
    completed: 'مكتملة',
    voided: 'ملغاة',
    refunded: 'مرتجعة بالكامل',
    pending_review: 'بانتظار المراجعة',
  }

  return statusLabels[status] || status
}

function getSaleStatusClass(status: string) {
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

// ======================================================
// ترجمة طرق الدفع المعرفة داخل قاعدة البيانات.
// ======================================================
function translatePaymentMethod(method: string) {
  const paymentLabels: Record<string, string> = {
    cash: 'نقدي',
    card: 'بطاقة بنكية',
    wallet: 'محفظة إلكترونية',
    bank_transfer: 'تحويل بنكي',
    mixed: 'دفع متعدد',
    other: 'طريقة أخرى',
  }

  return paymentLabels[method] || method
}

function translatePaymentDirection(direction: string) {
  if (direction === 'received_from_customer') {
    return 'تم تحصيله من العميل'
  }

  if (direction === 'refunded_to_customer') {
    return 'تم رده للعميل'
  }

  return direction
}

function getSaleMovementClass(quantity: number | string) {
  const numericQuantity = Number(quantity)

  if (numericQuantity > 0) {
    return 'movement-badge ' + 'movement-badge-in'
  }

  if (numericQuantity < 0) {
    return 'movement-badge ' + 'movement-badge-out'
  }

  return 'movement-badge'
}

type SalesPageProps = {
  companyId: string
  branchId: string

  initialSaleId: string | null
  onInitialSaleHandled: () => void

  // ترسل رقم الفاتورة إلى App
  // لفتح شاشة المرتجع عليها مباشرة
  onCreateReturn: (saleId: string) => void
  onCreateExchange: (saleId: string) => void
}

function SalesPage({
  companyId,
  branchId,
  initialSaleId,
  onInitialSaleHandled,
  onCreateReturn,
  onCreateExchange,
}: SalesPageProps) {
  const { user } = useAuth()
  const canVoidSale =
    user?.roles.includes('admin') ||
    user?.permissions.includes('sales.void') ||
    false
  const canCreateReturn =
    user?.roles.includes('admin') ||
    user?.permissions.includes('returns.create') ||
    false

  const canCreateExchange =
    user?.roles.includes('admin') ||
    user?.permissions.includes('exchanges.create') ||
    false

  const [sales, setSales] = useState<Sale[]>([])
  const [selectedSaleDetails, setSelectedSaleDetails] =
    useState<SaleDetails | null>(null)

  const [loadingSales, setLoadingSales] = useState(false)
  const [loadingDetails, setLoadingDetails] = useState(false)
  const [error, setError] = useState('')

  const [success, setSuccess] = useState('')

  const [voidingSaleId, setVoidingSaleId] = useState<string | null>(null)

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
        `/api/sales` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}` +
        (selectedBranchId
          ? `&branchId=${encodeURIComponent(selectedBranchId)}`
          : '')

      const salesResponse = await requestJson<ApiResponse<Sale[]>>(salesUrl)

      setSales(salesResponse.data)

      if (!initialSaleId) {
        setSelectedSaleDetails(null)
      }
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
  // تحميل الفواتير تلقائيًا عند فتح الصفحة
  // أو تغير الشركة أو الفرع المرتبط بالجلسة.
  // ======================================================
  useEffect(() => {
    if (!companyId.trim()) {
      return
    }

    void loadSales()
  }, [companyId, branchId])

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
        `/api/sales/${encodeURIComponent(saleId)}` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}`

      const saleDetailsResponse =
        await requestJson<ApiResponse<SaleDetails>>(saleDetailsUrl)

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

  async function voidSale(sale: Sale) {
    if (!canVoidSale || voidingSaleId) {
      return
    }

    if (sale.status !== 'completed') {
      setError('لا يمكن إلغاء إلا فاتورة مكتملة.')

      return
    }

    if (Number(sale.returned_quantity) > 0) {
      setError('يجب إلغاء المرتجعات والاستبدالات المرتبطة بالفاتورة أولًا.')

      return
    }

    if (sale.shift_id && sale.shift_status !== 'open') {
      setError(
        'لا يمكن إلغاء فاتورة تابعة لوردية مغلقة. استخدم دورة المرتجعات بدلًا من ذلك.',
      )

      return
    }

    const reason = window.prompt('سبب إلغاء الفاتورة — مطلوب:', '')

    if (reason === null) {
      return
    }

    if (reason.trim().length < 3) {
      setError('سبب الإلغاء يجب ألا يقل عن 3 أحرف.')

      return
    }

    const enteredReference = window.prompt(
      'مرجع رد المبلغ للعميل — اختياري:',
      '',
    )

    if (enteredReference === null) {
      return
    }

    const confirmed = window.confirm(
      `إلغاء الفاتورة ${sale.sale_number}؟\n\n` +
        `سيتم رد ${formatSaleCurrency(sale.total)} للعميل.\n` +
        'وسيتم إعادة جميع أصناف الفاتورة إلى المخزون.\n\n' +
        'لن تُحذف السجلات الأصلية، وسيتم إنشاء حركات عكسية مرتبطة بها.',
    )

    if (!confirmed) {
      return
    }

    setVoidingSaleId(sale.id)

    setError('')
    setSuccess('')

    try {
      const response = await requestJson<
        ApiResponse<{
          sale: Sale

          stockReversalIds: string[]

          paymentReversalIds: string[]
        }> & {
          alreadyVoided: boolean
        }
      >(
        `/api/sales/${encodeURIComponent(sale.id)}/void`,

        {
          method: 'POST',

          headers: {
            'Content-Type': 'application/json',
          },

          body: JSON.stringify({
            reason: reason.trim(),

            refundReference: enteredReference.trim() || null,
          }),
        },
      )

      await loadSales()

      await loadSaleDetails(sale.id)

      setSuccess(
        response.alreadyVoided
          ? 'الفاتورة ملغاة بالفعل، ولم تتكرر أي حركة.'
          : `تم إلغاء الفاتورة ${sale.sale_number} وعكس المخزون والمدفوعات.`,
      )
    } catch (currentError) {
      if (currentError instanceof ApiError) {
        const errorData = currentError.data as {
          details?: {
            activeReturns?: unknown

            activeExchanges?: unknown

            shiftStatus?: unknown

            closedAt?: unknown
          }
        } | null

        const details = errorData?.details

        if (
          Number(details?.activeReturns ?? 0) > 0 ||
          Number(details?.activeExchanges ?? 0) > 0
        ) {
          setError(
            'لا يمكن إلغاء الفاتورة قبل إلغاء المرتجعات والاستبدالات المرتبطة بها.',
          )
        } else if (details?.shiftStatus === 'closed') {
          setError(
            'وردية الفاتورة مغلقة، لذلك استخدم دورة المرتجعات بدل إلغاء البيع.',
          )
        } else {
          setError(currentError.message)
        }
      } else {
        setError(
          currentError instanceof Error
            ? currentError.message
            : 'تعذر إلغاء الفاتورة.',
        )
      }
    } finally {
      setVoidingSaleId(null)
    }
  }

  useEffect(() => {
    if (!companyId.trim() || !initialSaleId) {
      return
    }

    const saleId = initialSaleId

    onInitialSaleHandled()

    void loadSaleDetails(saleId)
  }, [companyId, initialSaleId])

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

          <div className="section-actions">
            <span className="record-count-badge">{sales.length} فاتورة</span>

            <button
              type="button"
              className="primary-button small-button"
              disabled={!companyId.trim() || loadingSales}
              onClick={loadSales}
            >
              {loadingSales ? 'جاري التحديث...' : 'تحديث البيانات'}
            </button>
          </div>
        </div>

        {error ? <p className="error-message">{error}</p> : null}
        {success ? <p className="success-message">{success}</p> : null}

        {sales.length === 0 ? (
          <p className="muted">
            {loadingSales
              ? 'جاري تحميل الفواتير...'
              : 'لا توجد فواتير مسجلة حاليًا.'}
          </p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>رقم الفاتورة</th>
                  <th>التاريخ</th>
                  <th>العميل</th>
                  <th>الفرع</th>
                  <th>الإجمالي</th>
                  <th>المدفوع</th>
                  <th>الباقي/الباقي للعميل</th>
                  <th>الأصناف</th>
                  <th>القطع المباعة</th>
                  <th>مرتجع / مستبدل</th>
                  <th>المتاح للإرجاع</th>
                  <th>الحالة</th>
                  <th>التفاصيل</th>
                  <th>مرتجع</th>
                  <th>استبدال</th>
                  <th>إلغاء</th>
                </tr>
              </thead>
              <tbody>
                {sales.map((sale) => (
                  <tr key={sale.id}>
                    <td>
                      <strong className="document-number">
                        {sale.sale_number}
                      </strong>
                    </td>

                    <td>{formatSaleDateTime(sale.occurred_at)}</td>

                    <td>{sale.customer_name || 'بيع عام'}</td>
                    <td>{sale.branch_name}</td>
                    <td className="money-cell">
                      {formatSaleCurrency(sale.total)}
                    </td>

                    <td className="money-cell">
                      {formatSaleCurrency(sale.paid_total)}
                    </td>

                    <td className="money-cell">
                      {formatSaleCurrency(sale.change_total)}
                    </td>

                    <td>{sale.items_count}</td>

                    {/* متابعة كميات البيع والمرتجعات */}
                    <td>{formatSaleQuantity(sale.sold_quantity)}</td>

                    <td>{formatSaleQuantity(sale.returned_quantity)}</td>

                    <td>
                      <strong
                        className={
                          Number(sale.remaining_returnable_quantity) > 0
                            ? 'returnable-quantity'
                            : 'muted'
                        }
                      >
                        {formatSaleQuantity(sale.remaining_returnable_quantity)}
                      </strong>
                    </td>

                    <td>
                      <span className={getSaleStatusClass(sale.status)}>
                        {translateSaleStatus(sale.status)}
                      </span>
                    </td>

                    <td>
                      <button
                        type="button"
                        className="table-button"
                        disabled={loadingDetails}
                        onClick={() => loadSaleDetails(sale.id)}
                      >
                        عرض التفاصيل
                      </button>
                    </td>

                    <td>
                      {canCreateReturn ? (
                        <button
                          type="button"
                          className="table-button sale-return-button"
                          disabled={
                            sale.status !== 'completed' ||
                            Number(sale.remaining_returnable_quantity) <= 0
                          }
                          onClick={() => onCreateReturn(sale.id)}
                        >
                          {Number(sale.remaining_returnable_quantity) <= 0
                            ? 'مرتجع بالكامل'
                            : 'إنشاء مرتجع'}
                        </button>
                      ) : null}
                    </td>

                    <td>
                      {canCreateExchange ? (
                        <button
                          type="button"
                          className="table-button"
                          disabled={
                            sale.status !== 'completed' ||
                            Number(sale.remaining_returnable_quantity) <= 0
                          }
                          onClick={() => onCreateExchange(sale.id)}
                        >
                          {Number(sale.remaining_returnable_quantity) <= 0
                            ? 'غير متاح'
                            : 'إنشاء استبدال'}
                        </button>
                      ) : null}
                    </td>

                    <td>
                      {canVoidSale && sale.status === 'completed' ? (
                        <button
                          type="button"
                          className="table-button danger-button"
                          disabled={
                            voidingSaleId !== null ||
                            Number(sale.returned_quantity) > 0 ||
                            Boolean(
                              sale.shift_id && sale.shift_status !== 'open',
                            )
                          }
                          onClick={() => void voidSale(sale)}
                        >
                          {voidingSaleId === sale.id
                            ? 'جاري الإلغاء...'
                            : Number(sale.returned_quantity) > 0
                              ? 'ألغِ العمليات التابعة أولًا'
                              : sale.shift_id && sale.shift_status !== 'open'
                                ? 'الوردية مغلقة'
                                : 'إلغاء الفاتورة'}
                        </button>
                      ) : sale.status === 'voided' ? (
                        <span className="muted">تم الإلغاء</span>
                      ) : null}
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
                {selectedSaleDetails.sale.sale_number}
                {' • '}
                {selectedSaleDetails.sale.customer_name || 'بيع عام'}
                {' • '}
                {formatSaleDateTime(selectedSaleDetails.sale.occurred_at)}
              </p>
            </div>
            <div className="section-actions">
              {canVoidSale &&
              selectedSaleDetails.sale.status === 'completed' ? (
                <button
                  type="button"
                  className="table-button danger-button"
                  disabled={
                    voidingSaleId !== null ||
                    selectedSaleDetails.items.some(
                      (item) => Number(item.already_returned_quantity) > 0,
                    ) ||
                    Boolean(
                      selectedSaleDetails.sale.shift_id &&
                      selectedSaleDetails.sale.shift_status !== 'open',
                    )
                  }
                  onClick={() => void voidSale(selectedSaleDetails.sale)}
                >
                  {voidingSaleId === selectedSaleDetails.sale.id
                    ? 'جاري الإلغاء...'
                    : 'إلغاء الفاتورة'}
                </button>
              ) : null}

              <button
                type="button"
                className="table-button"
                disabled={voidingSaleId !== null}
                onClick={() => setSelectedSaleDetails(null)}
              >
                إغلاق التفاصيل
              </button>
            </div>
          </div>

          {selectedSaleDetails.sale.status === 'voided' ? (
            <p className="error-message">
              تم إلغاء هذه الفاتورة
              {selectedSaleDetails.sale.voided_at
                ? ` بتاريخ ${formatSaleDateTime(
                    selectedSaleDetails.sale.voided_at,
                  )}`
                : ''}
              {selectedSaleDetails.sale.voided_by_name
                ? ` بواسطة ${selectedSaleDetails.sale.voided_by_name}`
                : ''}
              {selectedSaleDetails.sale.void_reason
                ? ` — السبب: ${selectedSaleDetails.sale.void_reason}`
                : ''}
            </p>
          ) : null}

          {selectedSaleDetails.items.some(
            (item) => Number(item.already_returned_quantity) > 0,
          ) ? (
            <p className="error-message">
              توجد عمليات مرتجع أو استبدال مرتبطة بهذه الفاتورة. يجب إلغاؤها
              أولًا قبل إلغاء البيع.
            </p>
          ) : null}

          {selectedSaleDetails.sale.shift_id &&
          selectedSaleDetails.sale.shift_status !== 'open' ? (
            <p className="error-message">
              وردية الفاتورة مغلقة؛ لا يمكن إلغاء البيع، ويمكن تنفيذ مرتجع بدلًا
              من ذلك.
            </p>
          ) : null}

          <section className="mini-cards-grid">
            <article className="mini-card">
              <span>الإجمالي</span>
              <strong>
                {formatSaleCurrency(selectedSaleDetails.sale.total)}
              </strong>
            </article>

            <article className="mini-card">
              <span>المدفوع</span>
              <strong>
                {formatSaleCurrency(selectedSaleDetails.sale.paid_total)}
              </strong>
            </article>

            <article className="mini-card">
              <span>الخصم</span>
              <strong>
                {formatSaleCurrency(selectedSaleDetails.sale.discount_total)}
              </strong>
            </article>

            <article className="mini-card">
              <span>الضريبة</span>
              <strong>
                {formatSaleCurrency(selectedSaleDetails.sale.tax_total)}
              </strong>
            </article>

            <article className="mini-card">
              <span>الحالة</span>

              <div className="mini-card-status">
                <span
                  className={getSaleStatusClass(
                    selectedSaleDetails.sale.status,
                  )}
                >
                  {translateSaleStatus(selectedSaleDetails.sale.status)}
                </span>
              </div>
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
                    <td>{formatSaleQuantity(item.quantity)}</td>

                    <td className="money-cell">
                      {formatSaleCurrency(item.unit_price)}
                    </td>

                    <td className="money-cell">
                      {formatSaleCurrency(item.line_total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>الحركات المالية للفاتورة</h3>

          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <tr>
                    <th>نوع السجل</th>
                    <th>الاتجاه</th>
                    <th>طريقة الدفع</th>
                    <th>المبلغ</th>
                    <th>مرجع الدفع</th>
                    <th>التاريخ</th>
                  </tr>
                </tr>
              </thead>
              <tbody>
                {selectedSaleDetails.payments.map((payment) => (
                  <tr key={payment.id}>
                    <td>
                      {payment.payment_role === 'void_reversal' ? (
                        <span className="status-badge status-badge-warning">
                          رد بسبب الإلغاء
                        </span>
                      ) : (
                        <span className="status-badge status-badge-success">
                          تحصيل البيع الأصلي
                        </span>
                      )}
                    </td>

                    <td>
                      {translatePaymentDirection(payment.payment_direction)}
                    </td>
                    <td>
                      <span className="payment-method-badge">
                        {translatePaymentMethod(payment.method)}
                      </span>
                    </td>

                    <td className="money-cell">
                      {formatSaleCurrency(payment.amount)}
                    </td>
                    <td>{payment.reference || '-'}</td>
                    <td>{formatSaleDateTime(payment.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          
          <h3>حركات المخزون</h3>

          {selectedSaleDetails.stockMovements.length === 0 ? (
            <p className="muted">لا توجد حركات مخزون مرتبطة بهذه الفاتورة.</p>
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
                  {selectedSaleDetails.stockMovements.map((movement) => (
                    <tr key={movement.id}>
                      <td>
                        {movement.reversal_of_movement_id ? (
                          <span className="status-badge status-badge-warning">
                            حركة عكسية
                          </span>
                        ) : (
                          <span className="status-badge status-badge-success">
                            حركة البيع الأصلية
                          </span>
                        )}
                      </td>

                      <td>{movement.product_name}</td>

                      <td>{movement.sku}</td>

                      <td>{movement.size_name || '-'}</td>

                      <td>{movement.color_name || '-'}</td>

                      <td>{formatSaleQuantity(movement.quantity_before)}</td>

                      <td>
                        <span
                          className={getSaleMovementClass(movement.quantity)}
                        >
                          {formatSaleQuantity(movement.quantity)}
                        </span>
                      </td>

                      <td>{formatSaleQuantity(movement.quantity_after)}</td>

                      <td>{movement.stock_location_name}</td>

                      <td>{formatSaleDateTime(movement.created_at)}</td>
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

export default SalesPage
