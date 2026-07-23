import { useEffect, useMemo, useRef, useState } from 'react'

import { useAuth } from '../auth/AuthContext'
import { requestJson } from '../lib/http'

type SaleSummary = {
  id: string
  sale_number: string

  customer_name: string | null
  branch_name: string

  total: string
  status: string
  occurred_at: string

  remaining_returnable_quantity: string
}

type OriginalSale = {
  id: string
  sale_number: string

  branch_id: string
  branch_name: string

  stock_location_id: string
  stock_location_name: string

  customer_id: string | null
  customer_name: string | null

  total: string
  status: string
  occurred_at: string
}

type OriginalSaleItem = {
  id: string
  variant_id: string

  sku_snapshot: string
  barcode_snapshot: string | null
  product_name_snapshot: string

  size_snapshot: string | null
  color_snapshot: string | null

  quantity: string
  unit_price: string
  line_total: string

  previously_returned_quantity: string

  remaining_returnable_quantity: number
}

type OriginalSaleDetails = {
  sale: OriginalSale
  items: OriginalSaleItem[]
}

type IssueVariant = {
  id: string
  product_id: string

  sku: string
  style_code: string | null
  primary_barcode: string | null

  selling_price: string
  product_name: string

  size_name: string | null
  color_name: string | null
}

type IssueCartItem = {
  variant: IssueVariant
  quantity: number
}

type CreatedExchangeDetails = {
  exchange: {
    id: string
    exchange_number: string

    original_sale_number: string | null

    customer_name: string | null

    returned_total: string
    issued_total: string
    difference_total: string

    paid_difference_total: string
    refunded_difference_total: string

    status: string
    created_at: string
  }

  returnItems: Array<{
    id: string
    product_name_snapshot: string
    sku_snapshot: string
    quantity: string
    line_total: string
  }>

  issueItems: Array<{
    id: string
    product_name_snapshot: string
    sku_snapshot: string
    quantity: string
    line_total: string
  }>

  payments: Array<{
    id: string
    payment_direction: string
    method: string
    amount: string
    reference: string | null
  }>
}

type ApiResponse<T> = {
  data: T
}

type NewExchangePageProps = {
  companyId: string
  branchId: string

  initialSaleId: string | null

  onInitialSaleHandled: () => void
}

const exchangeCurrencyFormatter = new Intl.NumberFormat('ar-EG', {
  style: 'currency',
  currency: 'EGP',

  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})

const exchangeQuantityFormatter = new Intl.NumberFormat('ar-EG', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
})

const exchangeDateFormatter = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatCurrency(value: number | string) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? exchangeCurrencyFormatter.format(numericValue)
    : '-'
}

function formatQuantity(value: number | string) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? exchangeQuantityFormatter.format(numericValue)
    : '-'
}

function formatDate(value: string) {
  const date = new Date(value)

  return Number.isNaN(date.getTime()) ? '-' : exchangeDateFormatter.format(date)
}

function roundMoney(value: number) {
  return Number(value.toFixed(2))
}

function createIdempotencyKey() {
  return (
    `web-admin-exchange-` +
    `${Date.now()}-` +
    `${Math.random().toString(16).slice(2)}`
  )
}

function calculateReturnValue(item: OriginalSaleItem, quantity: number) {
  const soldQuantity = Number(item.quantity)

  const originalLineTotal = Number(item.line_total)

  if (
    !Number.isFinite(soldQuantity) ||
    soldQuantity <= 0 ||
    !Number.isFinite(originalLineTotal) ||
    originalLineTotal < 0 ||
    quantity <= 0
  ) {
    return 0
  }

  return roundMoney((originalLineTotal / soldQuantity) * quantity)
}

function NewExchangePage({
  companyId,
  branchId,
  initialSaleId,
  onInitialSaleHandled,
}: NewExchangePageProps) {
  const { user } = useAuth()

  const canCreateExchange =
    user?.roles.includes('admin') ||
    user?.permissions.includes('exchanges.create') ||
    false

  const [sales, setSales] = useState<SaleSummary[]>([])

  const [saleSearchText, setSaleSearchText] = useState('')

  const [selectedSaleDetails, setSelectedSaleDetails] =
    useState<OriginalSaleDetails | null>(null)

  const [returnQuantities, setReturnQuantities] = useState<
    Record<string, number>
  >({})

  const [issueSearchText, setIssueSearchText] = useState('')

  const [issueSearchResults, setIssueSearchResults] = useState<IssueVariant[]>(
    [],
  )

  const [issueCart, setIssueCart] = useState<IssueCartItem[]>([])

  const [paymentMethod, setPaymentMethod] = useState('cash')

  const [paymentReference, setPaymentReference] = useState('')

  const [reason, setReason] = useState('')

  const [idempotencyKey, setIdempotencyKey] = useState(createIdempotencyKey)

  const [lastSavedExchange, setLastSavedExchange] =
    useState<CreatedExchangeDetails | null>(null)

  const [loadingSales, setLoadingSales] = useState(false)

  const [loadingSale, setLoadingSale] = useState(false)

  const [searchingItems, setSearchingItems] = useState(false)

  const [savingExchange, setSavingExchange] = useState(false)

  const savingRequestRef = useRef(false)

  const [error, setError] = useState('')

  const [success, setSuccess] = useState('')

  const filteredSales = useMemo(() => {
    const searchValue = saleSearchText.trim().toLowerCase()

    if (!searchValue) {
      return sales
    }

    return sales.filter((sale) => {
      const saleNumber = sale.sale_number.toLowerCase()

      const customerName = (sale.customer_name || '').toLowerCase()

      return (
        saleNumber.includes(searchValue) || customerName.includes(searchValue)
      )
    })
  }, [sales, saleSearchText])

  const selectedReturnItems = useMemo(() => {
    if (!selectedSaleDetails) {
      return []
    }

    return selectedSaleDetails.items
      .map((item) => ({
        item,

        quantity: returnQuantities[item.id] || 0,
      }))
      .filter((selectedItem) => selectedItem.quantity > 0)
  }, [selectedSaleDetails, returnQuantities])

  const returnedTotal = useMemo(() => {
    return roundMoney(
      selectedReturnItems.reduce(
        (currentTotal, selectedItem) =>
          currentTotal +
          calculateReturnValue(selectedItem.item, selectedItem.quantity),

        0,
      ),
    )
  }, [selectedReturnItems])

  const issuedTotal = useMemo(() => {
    return roundMoney(
      issueCart.reduce(
        (currentTotal, cartItem) =>
          currentTotal +
          Number(cartItem.variant.selling_price) * cartItem.quantity,

        0,
      ),
    )
  }, [issueCart])

  const differenceTotal = roundMoney(issuedTotal - returnedTotal)

  const paymentDirection: 'paid_by_customer' | 'refunded_to_customer' | null =
    differenceTotal > 0
      ? 'paid_by_customer'
      : differenceTotal < 0
        ? 'refunded_to_customer'
        : null

  const paymentAmount = roundMoney(Math.abs(differenceTotal))

  async function loadSales() {
    setLoadingSales(true)

    setError('')

    try {
      const selectedCompanyId = companyId.trim()

      const selectedBranchId = branchId.trim()

      if (!selectedCompanyId) {
        throw new Error('بيانات الشركة غير مكتملة.')
      }

      const requestUrl =
        `/api/sales` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}` +
        (selectedBranchId
          ? `&branchId=${encodeURIComponent(selectedBranchId)}`
          : '') +
        '&limit=100'

      const response = await requestJson<ApiResponse<SaleSummary[]>>(requestUrl)

      setSales(
        response.data.filter(
          (sale) =>
            sale.status === 'completed' &&
            Number(sale.remaining_returnable_quantity) > 0,
        ),
      )
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل فواتير المبيعات.',
      )
    } finally {
      setLoadingSales(false)
    }
  }

  async function loadOriginalSale(saleId: string) {
    setLoadingSale(true)

    setError('')
    setSuccess('')

    try {
      const response = await requestJson<ApiResponse<OriginalSaleDetails>>(
        `/api/exchanges/original-sale/${encodeURIComponent(saleId)}`,
      )

      setSelectedSaleDetails(response.data)

      setReturnQuantities({})
      setIssueCart([])
      setIssueSearchResults([])
      setIssueSearchText('')

      setReason('')
      setPaymentReference('')

      setIdempotencyKey(createIdempotencyKey())
    } catch (currentError) {
      setSelectedSaleDetails(null)

      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل الفاتورة الأصلية.',
      )
    } finally {
      setLoadingSale(false)
    }
  }

  useEffect(() => {
    if (!companyId.trim()) {
      return
    }

    void loadSales()
  }, [companyId, branchId])

  useEffect(() => {
    const saleId = initialSaleId?.trim()

    if (!saleId) {
      return
    }

    void loadOriginalSale(saleId)

    onInitialSaleHandled()
  }, [initialSaleId])

  function updateReturnQuantity(item: OriginalSaleItem, rawValue: string) {
    const requestedQuantity = Number(rawValue)

    const maximumQuantity = Number(item.remaining_returnable_quantity)

    let nextQuantity = Number.isFinite(requestedQuantity)
      ? requestedQuantity
      : 0

    if (nextQuantity < 0) {
      nextQuantity = 0
    }

    if (nextQuantity > maximumQuantity) {
      nextQuantity = maximumQuantity
    }

    nextQuantity = Number(nextQuantity.toFixed(3))

    setReturnQuantities((currentQuantities) => ({
      ...currentQuantities,

      [item.id]: nextQuantity,
    }))
  }

  async function searchIssueItems() {
    const searchValue = issueSearchText.trim()

    if (!searchValue) {
      setError('اكتب اسم الصنف أو SKU أو الباركود.')

      return
    }

    setSearchingItems(true)

    setError('')

    try {
      const response = await requestJson<ApiResponse<IssueVariant[]>>(
        `/api/exchanges/lookup-item?query=${encodeURIComponent(searchValue)}`,
      )

      setIssueSearchResults(response.data)

      if (response.data.length === 0) {
        setError('لم يتم العثور على أصناف مطابقة.')
      }
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر البحث عن الصنف البديل.',
      )
    } finally {
      setSearchingItems(false)
    }
  }

  function addIssueVariant(variant: IssueVariant) {
    setIssueCart((currentCart) => {
      const existingItem = currentCart.find(
        (cartItem) => cartItem.variant.id === variant.id,
      )

      if (existingItem) {
        return currentCart.map((cartItem) =>
          cartItem.variant.id === variant.id
            ? {
                ...cartItem,

                quantity: Number((cartItem.quantity + 1).toFixed(3)),
              }
            : cartItem,
        )
      }

      return [
        ...currentCart,

        {
          variant,
          quantity: 1,
        },
      ]
    })

    setSuccess(`تمت إضافة ${variant.product_name} إلى الأصناف البديلة.`)
  }

  function updateIssueQuantity(variantId: string, rawValue: string) {
    const parsedQuantity = Number(rawValue)

    const quantity =
      Number.isFinite(parsedQuantity) && parsedQuantity > 0
        ? Number(parsedQuantity.toFixed(3))
        : 0

    setIssueCart((currentCart) =>
      currentCart.map((cartItem) =>
        cartItem.variant.id === variantId
          ? {
              ...cartItem,
              quantity,
            }
          : cartItem,
      ),
    )
  }

  function removeIssueVariant(variantId: string) {
    setIssueCart((currentCart) =>
      currentCart.filter((cartItem) => cartItem.variant.id !== variantId),
    )
  }

  async function saveExchange() {
    if (savingRequestRef.current || !canCreateExchange) {
      return
    }

    if (!selectedSaleDetails) {
      setError('اختر الفاتورة الأصلية أولًا.')

      return
    }

    if (selectedReturnItems.length === 0) {
      setError('حدد صنفًا واحدًا على الأقل سيتم استرجاعه.')

      return
    }

    if (issueCart.length === 0) {
      setError('أضف صنفًا بديلًا واحدًا على الأقل.')

      return
    }

    if (issueCart.some((item) => item.quantity <= 0)) {
      setError('كمية الصنف البديل يجب أن تكون أكبر من صفر.')

      return
    }

    const confirmed = window.confirm(
      `تأكيد الاستبدال؟\n\n` +
        `قيمة المرتجع: ${formatCurrency(returnedTotal)}\n` +
        `قيمة البديل: ${formatCurrency(issuedTotal)}\n` +
        `الفرق: ${formatCurrency(differenceTotal)}`,
    )

    if (!confirmed) {
      return
    }

    savingRequestRef.current = true

    setSavingExchange(true)

    setError('')
    setSuccess('')

    try {
      const payments = paymentDirection
        ? [
            {
              paymentDirection,

              method: paymentMethod,

              amount: paymentAmount,

              reference: paymentReference.trim() || null,
            },
          ]
        : []

      const response = await requestJson<
        ApiResponse<CreatedExchangeDetails> & {
          duplicated: boolean
        }
      >(
        '/api/exchanges',

        {
          method: 'POST',

          headers: {
            'Content-Type': 'application/json',
          },

          body: JSON.stringify({
            originalSaleId: selectedSaleDetails.sale.id,

            idempotencyKey,

            reason: reason.trim() || null,

            returnItems: selectedReturnItems.map((selectedItem) => ({
              originalSaleItemId: selectedItem.item.id,

              quantity: selectedItem.quantity,
            })),

            issueItems: issueCart.map((cartItem) => ({
              variantId: cartItem.variant.id,

              quantity: cartItem.quantity,
            })),

            payments,
          }),
        },
      )

      setLastSavedExchange(response.data)

      setSuccess(
        response.duplicated
          ? 'تم العثور على نفس عملية الاستبدال المحفوظة سابقًا.'
          : `تم إنشاء الاستبدال ${response.data.exchange.exchange_number} بنجاح.`,
      )

      setReturnQuantities({})
      setIssueCart([])
      setIssueSearchResults([])
      setIssueSearchText('')

      setReason('')
      setPaymentReference('')

      setIdempotencyKey(createIdempotencyKey())

      try {
        const refreshedResponse = await requestJson<
          ApiResponse<OriginalSaleDetails>
        >(
          `/api/exchanges/original-sale/${encodeURIComponent(
            selectedSaleDetails.sale.id,
          )}`,
        )

        setSelectedSaleDetails(refreshedResponse.data)
      } catch {
        // الاستبدال تم حفظه بالفعل.
        // فشل تحديث الفاتورة لا يلغي العملية.
      }

      await loadSales()
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر إنشاء عملية الاستبدال.',
      )
    } finally {
      savingRequestRef.current = false

      setSavingExchange(false)
    }
  }

  return (
    <>
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>إنشاء استبدال جديد</h2>

            <p className="muted">
              اختر فاتورة مكتملة، وحدد الأصناف المرتجعة والأصناف البديلة، وسيحسب
              النظام الفرق تلقائيًا.
            </p>
          </div>

          <button
            type="button"
            className="primary-button small-button"
            disabled={loadingSales || !companyId.trim()}
            onClick={() => void loadSales()}
          >
            {loadingSales ? 'جاري التحديث...' : 'تحديث الفواتير'}
          </button>
        </div>

        {error ? <p className="error-message">{error}</p> : null}

        {success ? <p className="success-message">{success}</p> : null}
      </section>

      <section className="panel">
        <div className="section-header">
          <div>
            <h2>الفاتورة الأصلية</h2>

            <p className="muted">ابحث برقم الفاتورة أو باسم العميل.</p>
          </div>

          <span className="record-count-badge">
            {filteredSales.length} فاتورة
          </span>
        </div>

        <div className="form-grid">
          <label className="form-field">
            <span>البحث</span>

            <input
              type="search"
              value={saleSearchText}
              placeholder="رقم الفاتورة أو اسم العميل"
              onChange={(event) => setSaleSearchText(event.target.value)}
            />
          </label>
        </div>

        {filteredSales.length === 0 ? (
          <p className="muted">
            {loadingSales
              ? 'جاري تحميل الفواتير...'
              : 'لا توجد فواتير مكتملة مطابقة.'}
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

                  <th>الاختيار</th>
                </tr>
              </thead>

              <tbody>
                {filteredSales.map((sale) => (
                  <tr key={sale.id}>
                    <td>
                      <strong className="document-number">
                        {sale.sale_number}
                      </strong>
                    </td>

                    <td>{formatDate(sale.occurred_at)}</td>

                    <td>{sale.customer_name || 'بيع عام'}</td>

                    <td>{sale.branch_name}</td>

                    <td className="money-cell">{formatCurrency(sale.total)}</td>

                    <td>
                      <button
                        type="button"
                        className="table-button"
                        disabled={loadingSale}
                        onClick={() => void loadOriginalSale(sale.id)}
                      >
                        {selectedSaleDetails?.sale.id === sale.id
                          ? 'الفاتورة المختارة'
                          : 'اختيار'}
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
        <>
          <section className="mini-cards-grid">
            <article className="mini-card">
              <span>رقم الفاتورة</span>

              <strong>{selectedSaleDetails.sale.sale_number}</strong>
            </article>

            <article className="mini-card">
              <span>العميل</span>

              <strong>
                {selectedSaleDetails.sale.customer_name || 'بيع عام'}
              </strong>
            </article>

            <article className="mini-card">
              <span>الفرع</span>

              <strong>{selectedSaleDetails.sale.branch_name}</strong>
            </article>

            <article className="mini-card">
              <span>مكان التخزين</span>

              <strong>{selectedSaleDetails.sale.stock_location_name}</strong>
            </article>
          </section>

          <section className="panel">
            <div className="section-header">
              <div>
                <h2>الأصناف المرتجعة</h2>

                <p className="muted">
                  حدد الكمية التي سيعيدها العميل من كل صنف.
                </p>
              </div>
            </div>

            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>الصنف</th>

                    <th>SKU</th>

                    <th>المباع</th>

                    <th>المرتجع سابقًا</th>

                    <th>المتاح</th>

                    <th>كمية الاستبدال</th>

                    <th>القيمة</th>
                  </tr>
                </thead>

                <tbody>
                  {selectedSaleDetails.items.map((item) => {
                    const quantity = returnQuantities[item.id] || 0

                    const remainingQuantity = Number(
                      item.remaining_returnable_quantity,
                    )

                    return (
                      <tr key={item.id}>
                        <td>
                          {item.product_name_snapshot}

                          <div className="muted">
                            {item.size_snapshot || '-'}

                            {' / '}

                            {item.color_snapshot || '-'}
                          </div>
                        </td>

                        <td>{item.sku_snapshot}</td>

                        <td>{formatQuantity(item.quantity)}</td>

                        <td>
                          {formatQuantity(item.previously_returned_quantity)}
                        </td>

                        <td>{formatQuantity(remainingQuantity)}</td>

                        <td>
                          <input
                            type="number"
                            min="0"
                            max={remainingQuantity}
                            step="0.001"
                            value={quantity}
                            disabled={remainingQuantity <= 0}
                            onChange={(event) =>
                              updateReturnQuantity(
                                item,

                                event.target.value,
                              )
                            }
                          />
                        </td>

                        <td className="money-cell">
                          {formatCurrency(calculateReturnValue(item, quantity))}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="section-header">
              <div>
                <h2>البحث عن الصنف البديل</h2>

                <p className="muted">البحث بالاسم أو SKU أو الباركود.</p>
              </div>
            </div>

            <div className="form-grid">
              <label className="form-field">
                <span>الصنف البديل</span>

                <input
                  type="search"
                  value={issueSearchText}
                  placeholder="اسم، SKU أو Barcode"
                  onChange={(event) => setIssueSearchText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()

                      void searchIssueItems()
                    }
                  }}
                />
              </label>

              <button
                type="button"
                className="primary-button"
                disabled={searchingItems}
                onClick={() => void searchIssueItems()}
              >
                {searchingItems ? 'جاري البحث...' : 'بحث'}
              </button>
            </div>

            {issueSearchResults.length > 0 ? (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>الصنف</th>

                      <th>SKU</th>

                      <th>Barcode</th>

                      <th>المقاس</th>

                      <th>اللون</th>

                      <th>السعر</th>

                      <th>الإضافة</th>
                    </tr>
                  </thead>

                  <tbody>
                    {issueSearchResults.map((variant) => (
                      <tr key={variant.id}>
                        <td>{variant.product_name}</td>

                        <td>{variant.sku}</td>

                        <td>{variant.primary_barcode || '-'}</td>

                        <td>{variant.size_name || '-'}</td>

                        <td>{variant.color_name || '-'}</td>

                        <td className="money-cell">
                          {formatCurrency(variant.selling_price)}
                        </td>

                        <td>
                          <button
                            type="button"
                            className="table-button"
                            onClick={() => addIssueVariant(variant)}
                          >
                            إضافة
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>

          <section className="panel">
            <div className="section-header">
              <div>
                <h2>الأصناف البديلة</h2>

                <p className="muted">الأصناف التي سيتم تسليمها للعميل.</p>
              </div>

              <span className="record-count-badge">{issueCart.length} صنف</span>
            </div>

            {issueCart.length === 0 ? (
              <p className="muted">لم تتم إضافة أصناف بديلة بعد.</p>
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>الصنف</th>

                      <th>SKU</th>

                      <th>السعر</th>

                      <th>الكمية</th>

                      <th>الإجمالي</th>

                      <th>الحذف</th>
                    </tr>
                  </thead>

                  <tbody>
                    {issueCart.map((cartItem) => (
                      <tr key={cartItem.variant.id}>
                        <td>
                          {cartItem.variant.product_name}

                          <div className="muted">
                            {cartItem.variant.size_name || '-'}

                            {' / '}

                            {cartItem.variant.color_name || '-'}
                          </div>
                        </td>

                        <td>{cartItem.variant.sku}</td>

                        <td className="money-cell">
                          {formatCurrency(cartItem.variant.selling_price)}
                        </td>

                        <td>
                          <input
                            type="number"
                            min="0.001"
                            step="0.001"
                            value={cartItem.quantity}
                            onChange={(event) =>
                              updateIssueQuantity(
                                cartItem.variant.id,

                                event.target.value,
                              )
                            }
                          />
                        </td>

                        <td className="money-cell">
                          {formatCurrency(
                            Number(cartItem.variant.selling_price) *
                              cartItem.quantity,
                          )}
                        </td>

                        <td>
                          <button
                            type="button"
                            className="table-button danger-button"
                            onClick={() =>
                              removeIssueVariant(cartItem.variant.id)
                            }
                          >
                            حذف
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="mini-cards-grid">
            <article className="mini-card">
              <span>قيمة الأصناف المرتجعة</span>

              <strong>{formatCurrency(returnedTotal)}</strong>
            </article>

            <article className="mini-card">
              <span>قيمة الأصناف البديلة</span>

              <strong>{formatCurrency(issuedTotal)}</strong>
            </article>

            <article className="mini-card">
              <span>فرق الاستبدال</span>

              <strong>{formatCurrency(differenceTotal)}</strong>
            </article>

            <article className="mini-card">
              <span>اتجاه الفرق</span>

              <strong>
                {differenceTotal > 0
                  ? 'يدفع العميل'
                  : differenceTotal < 0
                    ? 'يُرد للعميل'
                    : 'لا يوجد فرق'}
              </strong>
            </article>
          </section>

          <section className="panel">
            <div className="section-header">
              <div>
                <h2>تسوية فرق الاستبدال</h2>

                <p className="muted">يحدد النظام المبلغ المطلوب تلقائيًا.</p>
              </div>
            </div>

            <div className="form-grid">
              {paymentDirection ? (
                <>
                  <label className="form-field">
                    <span>طريقة الدفع</span>

                    <select
                      value={paymentMethod}
                      onChange={(event) => setPaymentMethod(event.target.value)}
                    >
                      <option value="cash">نقدي</option>

                      <option value="card">بطاقة بنكية</option>

                      <option value="wallet">محفظة إلكترونية</option>

                      <option value="bank_transfer">تحويل بنكي</option>

                      <option value="other">أخرى</option>
                    </select>
                  </label>

                  <label className="form-field">
                    <span>المبلغ</span>

                    <input
                      type="text"
                      value={formatCurrency(paymentAmount)}
                      readOnly
                    />
                  </label>

                  <label className="form-field">
                    <span>المرجع — اختياري</span>

                    <input
                      type="text"
                      value={paymentReference}
                      maxLength={200}
                      onChange={(event) =>
                        setPaymentReference(event.target.value)
                      }
                    />
                  </label>
                </>
              ) : (
                <p className="success-message">
                  قيمة الأصناف متساوية، ولا توجد عملية دفع أو رد.
                </p>
              )}

              <label className="form-field">
                <span>سبب الاستبدال</span>

                <textarea
                  value={reason}
                  maxLength={500}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
            </div>

            <button
              type="button"
              className="primary-button"
              disabled={
                !canCreateExchange ||
                savingExchange ||
                selectedReturnItems.length === 0 ||
                issueCart.length === 0
              }
              onClick={() => void saveExchange()}
            >
              {savingExchange ? 'جاري حفظ الاستبدال...' : 'حفظ عملية الاستبدال'}
            </button>
          </section>
        </>
      ) : null}

      {lastSavedExchange ? (
        <section className="panel">
          <div className="section-header">
            <div>
              <h2>تم حفظ الاستبدال</h2>

              <p className="muted">
                {lastSavedExchange.exchange.exchange_number}

                {' • '}

                {formatDate(lastSavedExchange.exchange.created_at)}
              </p>
            </div>

            <span className="status-badge status-badge-success">مكتمل</span>
          </div>

          <section className="mini-cards-grid">
            <article className="mini-card">
              <span>قيمة المرتجع</span>

              <strong>
                {formatCurrency(lastSavedExchange.exchange.returned_total)}
              </strong>
            </article>

            <article className="mini-card">
              <span>قيمة البديل</span>

              <strong>
                {formatCurrency(lastSavedExchange.exchange.issued_total)}
              </strong>
            </article>

            <article className="mini-card">
              <span>الفرق</span>

              <strong>
                {formatCurrency(lastSavedExchange.exchange.difference_total)}
              </strong>
            </article>
          </section>
        </section>
      ) : null}
    </>
  )
}

export default NewExchangePage
