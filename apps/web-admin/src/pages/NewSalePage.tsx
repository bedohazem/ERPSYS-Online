import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
// requestJson مسؤول عن إضافة عنوان السيرفر تلقائيًا.
import { requestJson } from '../lib/http'

type LookupItem = {
  id?: string
  variant_id?: string
  product_name: string
  sku: string
  primary_barcode: string | null
  size_name: string | null
  color_name: string | null
  selling_price: string
  available_quantity: string
}

type CartItem = {
  variantId: string
  productName: string
  sku: string
  barcode: string | null
  sizeName: string | null
  colorName: string | null
  quantity: number
  unitPrice: number
  availableQuantity: number
}

type Customer = {
  id: string
  name: string
  phone: string | null
  email: string | null
  address: string | null
  is_active: boolean
}

type StockLocation = {
  id: string
  branch_id: string | null
  branch_name: string | null
  code: string
  name: string
  location_type: string
}

type SaleResponse = {
  sale: {
    id: string
    sale_number: string
    total: string
    paid_total: string
    status: string
  }
}

type ApiResponse<T> = {
  data: T
}

type SalePaymentMethod = 'cash' | 'card' | 'wallet' | 'bank_transfer'

// ======================================================
// تنسيق الأموال داخل شاشة البيع.
// ======================================================
const saleCurrencyFormatter = new Intl.NumberFormat('ar-EG', {
  style: 'currency',
  currency: 'EGP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})

function formatSaleCurrency(value: number | string) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? saleCurrencyFormatter.format(numericValue)
    : '-'
}

function roundSaleMoney(value: number) {
  return Number(value.toFixed(2))
}

function createSaleNumber() {
  return `WEB-${Date.now()}`
}

function createIdempotencyKey() {
  return `web-admin-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function NewSalePage() {
  const { user } = useAuth()

  // زر الحفظ يظهر فقط لمن يملك صلاحية إنشاء البيع
  const canCreateSale =
    user?.roles.includes('admin') ||
    user?.permissions.includes('sales.create') ||
    false

  const sessionBranchId = user?.branchId || ''

  // مكان البيع يُختار من الداتا الموثقة ولا يُكتب يدويًا.
  const [stockLocations, setStockLocations] = useState<StockLocation[]>([])

  const [stockLocationId, setStockLocationId] = useState('')

  const [saleNumber, setSaleNumber] = useState(createSaleNumber())
  // ======================================================
  // مفتاح ثابت لمسودة الفاتورة الحالية.
  //
  // لا يتغير عند إعادة محاولة الحفظ بعد انقطاع الاتصال.
  // يتم تغييره فقط بعد تأكيد نجاح الفاتورة أو تغير الفرع.
  // ======================================================
  const [saleIdempotencyKey, setSaleIdempotencyKey] = useState(
    createIdempotencyKey(),
  )
  const [customerId, setCustomerId] = useState('')
  const [customerSearchText, setCustomerSearchText] = useState('')
  const [customers, setCustomers] = useState<Customer[]>([])
  const [selectedCustomerName, setSelectedCustomerName] = useState('')
  const [code, setCode] = useState('')
  const [quantity, setQuantity] = useState(1)
  const [paymentMethod, setPaymentMethod] = useState<SalePaymentMethod>('cash')

  const [paidAmount, setPaidAmount] = useState(0)

  // التركيز التلقائي على حقل الكود بعد كل عملية.
  const codeInputRef = useRef<HTMLInputElement>(null)

  const [cartItems, setCartItems] = useState<CartItem[]>([])
  const [lastSavedSale, setLastSavedSale] = useState<SaleResponse | null>(null)

  const [loadingCustomers, setLoadingCustomers] = useState(false)
  // يمنع تنفيذ بحثَي عملاء متزامنين.
  const customerSearchRequestRef = useRef(false)
  const [loadingStockLocations, setLoadingStockLocations] = useState(false)
  const [loadingLookup, setLoadingLookup] = useState(false)
  // يمنع تنفيذ طلبَي بحث متزامنين عند الضغط السريع على Enter.
  const lookupRequestRef = useRef(false)
  const [savingSale, setSavingSale] = useState(false)
  // يمنع إرسال طلبين متزامنين قبل تحديث React للزر.
  const savingSaleRequestRef = useRef(false)
  const [error, setError] = useState('')

  const invoiceTotal = useMemo(() => {
    return roundSaleMoney(
      cartItems.reduce((sum, item) => {
        return sum + item.quantity * item.unitPrice
      }, 0),
    )
  }, [cartItems])

  const invoiceQuantityTotal = useMemo(() => {
    return cartItems.reduce((sum, item) => {
      return sum + item.quantity
    }, 0)
  }, [cartItems])

  const changeTotal = useMemo(() => {
    return roundSaleMoney(Math.max(Number(paidAmount) - invoiceTotal, 0))
  }, [invoiceTotal, paidAmount])

  const paymentIsValid =
    invoiceTotal > 0 &&
    Number.isFinite(Number(paidAmount)) &&
    Number(paidAmount) >= invoiceTotal

  // عند تغير الإجمالي أو طريقة الدفع نبدأ بالمبلغ الكامل.
  useEffect(() => {
    setPaidAmount(invoiceTotal)
  }, [invoiceTotal, paymentMethod])

  // ======================================================
  // بدء مسودة فاتورة جديدة.
  //
  // نحافظ على مكان البيع الحالي لتسريع عمل الكاشير.
  // ======================================================
  function resetSaleDraft() {
    setCartItems([])
    setCode('')
    setQuantity(1)

    setSaleNumber(createSaleNumber())
    setSaleIdempotencyKey(createIdempotencyKey())

    setCustomerId('')
    setSelectedCustomerName('')
    setCustomerSearchText('')
    setCustomers([])

    setPaymentMethod('cash')
    setPaidAmount(0)
    setError('')

    window.setTimeout(() => {
      codeInputRef.current?.focus()
    }, 0)
  }

  function clearSaleDraft() {
    const hasSaleData =
      cartItems.length > 0 ||
      Boolean(customerId) ||
      Boolean(customerSearchText.trim())

    if (
      hasSaleData &&
      !window.confirm(
        'سيتم حذف جميع بيانات الفاتورة الحالية. هل تريد المتابعة؟',
      )
    ) {
      return
    }

    setLastSavedSale(null)
    resetSaleDraft()
  }

  // ======================================================
  // loadStockLocations
  //
  // تحميل أماكن البيع المسموح بها لفرع المستخدم الحالي.
  // ======================================================
  async function loadStockLocations() {
    setLoadingStockLocations(true)
    setError('')

    try {
      if (!sessionBranchId) {
        setStockLocations([])
        setStockLocationId('')
        return
      }

      // الشركة والفرع يحددهما الـBackend من Session.
      const locationsResponse = await requestJson<ApiResponse<StockLocation[]>>(
        '/api/pos/stock-locations',
      )

      const availableLocations = locationsResponse.data

      setStockLocations(availableLocations)

      // الاحتفاظ بالاختيار الحالي إن ظل صالحًا،
      // وإلا اختيار أول مكان متاح تلقائيًا.
      setStockLocationId((currentLocationId) => {
        const currentLocationStillExists = availableLocations.some(
          (location) => location.id === currentLocationId,
        )

        if (currentLocationStillExists) {
          return currentLocationId
        }

        return availableLocations[0]?.id ?? ''
      })

      if (availableLocations.length > 0) {
        window.setTimeout(() => {
          codeInputRef.current?.focus()
        }, 0)
      }

      if (availableLocations.length === 0) {
        setError('لا توجد صالة بيع أو مخزن نشط متاح لهذا الفرع.')
      }
    } catch (currentError) {
      setStockLocations([])
      setStockLocationId('')

      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل أماكن البيع.',
      )
    } finally {
      setLoadingStockLocations(false)
    }
  }

  // إعادة تحميل الأماكن عند تغير شركة أو فرع Session.
  useEffect(() => {
    resetSaleDraft()
    setLastSavedSale(null)

    if (!canCreateSale || !sessionBranchId) {
      setStockLocations([])
      setStockLocationId('')
      return
    }

    void loadStockLocations()
  }, [canCreateSale, sessionBranchId])

  // ======================================================
  // lookupAndAddItem
  // تبحث عن الصنف بالكود أو الباركود
  // وبعدها تضيفه للفاتورة
  // ======================================================
  async function lookupAndAddItem() {
    // منع الضغط المزدوج قبل تحديث حالة الزر في React.
    if (lookupRequestRef.current) {
      return
    }

    lookupRequestRef.current = true
    setLoadingLookup(true)
    setError('')

    try {
      const selectedStockLocationId = stockLocationId.trim()

      const selectedCode = code.trim()

      if (!selectedStockLocationId) {
        throw new Error('stockLocationId is required')
      }

      if (!selectedCode) {
        throw new Error('code is required')
      }

      if (!quantity || quantity <= 0) {
        throw new Error('quantity must be greater than zero')
      }

      const lookupUrl =
        `/api/pos/lookup-item` +
        `?stockLocationId=${encodeURIComponent(selectedStockLocationId)}` +
        `&code=${encodeURIComponent(selectedCode)}`

      const lookupResponse =
        await requestJson<ApiResponse<LookupItem>>(lookupUrl)
      const lookupItem = lookupResponse.data

      const variantId = lookupItem.variant_id || lookupItem.id

      if (!variantId) {
        throw new Error('variantId was not found in lookup response')
      }

      const availableQuantity = Number(lookupItem.available_quantity)

      const unitPrice = Number(lookupItem.selling_price)

      if (!Number.isFinite(availableQuantity) || availableQuantity < 0) {
        throw new Error('الكمية المتاحة للصنف غير صالحة.')
      }

      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new Error('سعر بيع الصنف غير صالح.')
      }

      // ======================================================
      // فحص الصنف قبل تحديث React State.
      //
      // ممنوع رمي Error من داخل setCartItems؛
      // لأن React قد ينفذ دالة التحديث لاحقًا خارج try/catch.
      // ======================================================
      const existingItem = cartItems.find(
        (item) => item.variantId === variantId,
      )

      const requestedTotalQuantity = (existingItem?.quantity ?? 0) + quantity

      if (requestedTotalQuantity > availableQuantity) {
        throw new Error(
          `الكمية غير كافية. المتاح: ${availableQuantity}، المطلوب إجمالًا: ${requestedTotalQuantity}`,
        )
      }

      if (existingItem) {
        setCartItems((currentItems) =>
          currentItems.map((item) =>
            item.variantId === variantId
              ? {
                  ...item,
                  quantity: requestedTotalQuantity,

                  // تحديث السعر والمتاح من أحدث استجابة للسيرفر.
                  unitPrice,
                  availableQuantity,
                }
              : item,
          ),
        )
      } else {
        setCartItems((currentItems) => [
          ...currentItems,
          {
            variantId,
            productName: lookupItem.product_name,
            sku: lookupItem.sku,
            barcode: lookupItem.primary_barcode,
            sizeName: lookupItem.size_name,
            colorName: lookupItem.color_name,
            quantity,
            unitPrice,
            availableQuantity,
          },
        ])
      }

      setCode('')
      setQuantity(1)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر إضافة الصنف إلى الفاتورة.',
      )
    } finally {
      lookupRequestRef.current = false
      setLoadingLookup(false)
    }
  }

  function removeCartItem(variantId: string) {
    setError('')

    setCartItems((currentItems) =>
      currentItems.filter((item) => item.variantId !== variantId),
    )

    window.setTimeout(() => {
      codeInputRef.current?.focus()
    }, 0)
  }

  function updateCartItemQuantity(variantId: string, nextQuantity: number) {
    const selectedItem = cartItems.find((item) => item.variantId === variantId)

    if (!selectedItem) {
      return
    }

    if (!Number.isFinite(nextQuantity) || nextQuantity < 1) {
      setError('الكمية يجب أن تكون واحدًا أو أكثر.')
      return
    }

    if (nextQuantity > selectedItem.availableQuantity) {
      setError(
        `الكمية غير كافية. المتاح للصنف: ${selectedItem.availableQuantity}`,
      )
      return
    }

    setError('')

    setCartItems((currentItems) =>
      currentItems.map((item) =>
        item.variantId === variantId
          ? {
              ...item,
              quantity: nextQuantity,
            }
          : item,
      ),
    )
  }

  // ======================================================
  // loadCustomers
  // تحميل العملاء لاختيار عميل للفاتورة
  //
  // بدل ما نكتب customerId يدوي
  // نبحث بالاسم أو التليفون ثم نختار العميل
  // ======================================================
  async function loadCustomers() {
    if (customerSearchRequestRef.current) {
      return
    }

    customerSearchRequestRef.current = true
    setLoadingCustomers(true)
    setError('')

    try {
      const query = customerSearchText.trim()

      // الشركة مصدرها Session داخل الـBackend.
      const customersUrl =
        `/api/pos/customers` + (query ? `?q=${encodeURIComponent(query)}` : '')

      const customersResponse =
        await requestJson<ApiResponse<Customer[]>>(customersUrl)

      setCustomers(customersResponse.data)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر البحث عن العملاء.',
      )
    } finally {
      customerSearchRequestRef.current = false
      setLoadingCustomers(false)
    }
  }

  function selectCustomer(customer: Customer) {
    setCustomerId(customer.id)
    setSelectedCustomerName(customer.name)
    setCustomerSearchText(customer.name)
    setCustomers([])
  }

  function clearSelectedCustomer() {
    setCustomerId('')
    setSelectedCustomerName('')
    setCustomerSearchText('')
    setCustomers([])
  }

  // ======================================================
  // saveSale
  // تحفظ الفاتورة في Backend API
  //
  // Backend هو اللي:
  // 1. يسجل الفاتورة
  // 2. يسجل الأصناف
  // 3. يسجل الدفع
  // 4. ينقص المخزون
  // 5. يسجل stock_movement
  // ======================================================
  async function saveSale() {
    // منع طلب حفظ ثانٍ متزامن من الضغط السريع.
    if (savingSaleRequestRef.current) {
      return
    }

    savingSaleRequestRef.current = true
    setSavingSale(true)
    setError('')
    setLastSavedSale(null)

    try {
      const selectedStockLocationId = stockLocationId.trim()

      const selectedSaleNumber = saleNumber.trim()

      const selectedCustomerId = customerId.trim()

      const selectedPaidAmount = roundSaleMoney(Number(paidAmount))

      if (!sessionBranchId) {
        throw new Error('المستخدم الحالي غير مرتبط بفرع.')
      }

      if (!selectedStockLocationId) {
        throw new Error('stockLocationId is required')
      }

      if (!selectedSaleNumber) {
        throw new Error('saleNumber is required')
      }

      if (cartItems.length === 0) {
        throw new Error('Add at least one item before saving')
      }

      if (!Number.isFinite(selectedPaidAmount) || selectedPaidAmount <= 0) {
        throw new Error('المبلغ المستلم غير صالح.')
      }

      if (selectedPaidAmount < invoiceTotal) {
        throw new Error(
          `المبلغ المستلم أقل من إجمالي الفاتورة بمقدار ${formatSaleCurrency(
            invoiceTotal - selectedPaidAmount,
          )}`,
        )
      }

      const saleBody = {
        // Tenant والكاشير مصدرهم Session.
        stockLocationId: selectedStockLocationId,
        customerId: selectedCustomerId || null,
        saleNumber: selectedSaleNumber,
        source: 'web_admin',
        // نفس المفتاح يُستخدم في جميع محاولات حفظ هذه الفاتورة.
        idempotencyKey: saleIdempotencyKey,
        items: cartItems.map((item) => ({
          variantId: item.variantId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discountAmount: 0,
          taxAmount: 0,
        })),
        payments: [
          {
            method: paymentMethod,
            amount: selectedPaidAmount,
            reference: null,
          },
        ],
      }

      const saleResponse = await requestJson<ApiResponse<SaleResponse>>(
        `/api/sales`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(saleBody),
        },
      )

      setLastSavedSale(saleResponse.data)

      // نجاح الحفظ يبدأ فاتورة جديدة بنفس مكان البيع.
      resetSaleDraft()
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر حفظ فاتورة البيع.',
      )
    } finally {
      savingSaleRequestRef.current = false
      setSavingSale(false)
    }
  }

  return (
    <>
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>فاتورة بيع جديدة</h2>
            <p className="muted">
              أضف الأصناف بالكود أو الباركود ثم احفظ الفاتورة.
            </p>
          </div>

          {canCreateSale ? (
            <div className="section-actions">
              <button
                type="button"
                className="table-button"
                disabled={savingSale || loadingLookup}
                onClick={clearSaleDraft}
              >
                فاتورة جديدة
              </button>

              <button
                type="button"
                className="primary-button small-button"
                disabled={
                  cartItems.length === 0 ||
                  savingSale ||
                  loadingLookup ||
                  !sessionBranchId ||
                  !stockLocationId.trim() ||
                  !paymentIsValid
                }
                onClick={saveSale}
              >
                {savingSale ? 'جاري إتمام البيع...' : 'حفظ وإتمام البيع'}
              </button>
            </div>
          ) : null}
        </div>

        {error ? <p className="error-message">{error}</p> : null}

        {!sessionBranchId ? (
          <p className="error-message">
            المستخدم الحالي غير مرتبط بفرع، لذلك لا يمكن إنشاء فاتورة بيع قبل
            تحديد فرع له.
          </p>
        ) : null}

        {lastSavedSale ? (
          <p className="success-message">
            تم حفظ الفاتورة <strong>{lastSavedSale.sale.sale_number}</strong>{' '}
            بإجمالي{' '}
            <strong>{formatSaleCurrency(lastSavedSale.sale.total)}</strong>
          </p>
        ) : null}

        <div className="form-grid sale-context-grid">
          <label>
            رقم الفاتورة
            <input value={saleNumber} readOnly aria-readonly="true" />
            <small className="field-note">
              يتم إنشاء الرقم تلقائيًا بواسطة النظام.
            </small>
          </label>

          <label>
            مكان البيع والمخزون
            <select
              value={stockLocationId}
              disabled={
                loadingStockLocations || savingSale || cartItems.length > 0
              }
              onChange={(event) => setStockLocationId(event.target.value)}
            >
              <option value="">
                {loadingStockLocations
                  ? 'جاري تحميل الأماكن...'
                  : 'اختر مكان البيع'}
              </option>

              {stockLocations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name} ({location.code})
                  {location.branch_name
                    ? ` — ${location.branch_name}`
                    : ' — مخزن مركزي'}
                </option>
              ))}
            </select>
            <small className="field-note">
              لا يمكن تغيير المكان بعد إضافة أصناف للفاتورة.
            </small>
          </label>
        </div>

        <div className="customer-picker">
          <div className="customer-search-row">
            <label>
              بحث عن عميل
              <input
                value={customerSearchText}
                disabled={loadingCustomers || savingSale}
                onChange={(event) => setCustomerSearchText(event.target.value)}
                placeholder="اكتب اسم العميل أو التليفون"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void loadCustomers()
                  }
                }}
              />
            </label>

            <button
              type="button"
              className="primary-button small-button"
              disabled={loadingCustomers}
              onClick={() => void loadCustomers()}
            >
              {loadingCustomers ? 'جاري البحث...' : 'بحث العملاء'}
            </button>

            {customerId ? (
              <button
                type="button"
                className="table-button danger-button"
                onClick={clearSelectedCustomer}
              >
                إلغاء العميل
              </button>
            ) : null}
          </div>

          {selectedCustomerName ? (
            <p className="selected-customer">
              العميل المختار: <strong>{selectedCustomerName}</strong>
            </p>
          ) : null}

          {customers.length > 0 ? (
            <div className="customer-results">
              {customers.map((customer) => (
                <button
                  type="button"
                  className="customer-result-button"
                  key={customer.id}
                  onClick={() => selectCustomer(customer)}
                >
                  <strong>{customer.name}</strong>
                  <span>{customer.phone || 'بدون تليفون'}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      <section className="panel">
        <h2>إضافة صنف</h2>

        <div className="form-grid item-form-grid">
          <label>
            كود / باركود الصنف
            <input
              ref={codeInputRef}
              autoFocus
              disabled={!stockLocationId || loadingLookup || savingSale}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="مثال: 100000000001"
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void lookupAndAddItem()
                }
              }}
            />
          </label>

          <label>
            الكمية
            <input
              disabled={!stockLocationId || loadingLookup || savingSale}
              min="1"
              type="number"
              value={quantity}
              onChange={(event) => setQuantity(Number(event.target.value))}
            />
          </label>
        </div>

        <button
          type="button"
          className="primary-button small-button"
          disabled={
            !stockLocationId || !code.trim() || loadingLookup || savingSale
          }
          onClick={lookupAndAddItem}
        >
          {loadingLookup ? 'جاري البحث...' : 'إضافة للفاتورة'}
        </button>
      </section>

      <section className="panel">
        <div className="section-header">
          <div>
            <h2>الأصناف داخل الفاتورة</h2>

            <p className="muted">
              {invoiceQuantityTotal} قطعة داخل {cartItems.length} صنف.
            </p>
          </div>

          <div className="section-actions">
            <span className="record-count-badge">{cartItems.length} صنف</span>

            <strong className="sale-total-value">
              {formatSaleCurrency(invoiceTotal)}
            </strong>
          </div>
        </div>

        {cartItems.length === 0 ? (
          <p className="muted">لم يتم إضافة أصناف حتى الآن.</p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>الصنف</th>
                  <th>SKU</th>
                  <th>Barcode</th>
                  <th>المقاس</th>
                  <th>اللون</th>
                  <th>المتاح</th>
                  <th>الكمية</th>
                  <th>السعر</th>
                  <th>الإجمالي</th>
                  <th>حذف</th>
                </tr>
              </thead>
              <tbody>
                {cartItems.map((item) => (
                  <tr key={item.variantId}>
                    <td>
                      <strong className="sale-product-name">
                        {item.productName}
                      </strong>
                    </td>

                    <td>
                      <span className="sale-code">{item.sku}</span>
                    </td>

                    <td>
                      {item.barcode ? (
                        <span className="sale-code">{item.barcode}</span>
                      ) : (
                        '-'
                      )}
                    </td>

                    <td>{item.sizeName || '-'}</td>
                    <td>{item.colorName || '-'}</td>
                    <td>{item.availableQuantity}</td>

                    <td>
                      <div className="sale-quantity-editor">
                        <button
                          type="button"
                          className="sale-quantity-button"
                          disabled={
                            item.quantity <= 1 || loadingLookup || savingSale
                          }
                          onClick={() =>
                            updateCartItemQuantity(
                              item.variantId,
                              item.quantity - 1,
                            )
                          }
                        >
                          −
                        </button>

                        <input
                          className="sale-quantity-input"
                          type="number"
                          min="1"
                          max={item.availableQuantity}
                          value={item.quantity}
                          disabled={loadingLookup || savingSale}
                          onChange={(event) =>
                            updateCartItemQuantity(
                              item.variantId,
                              Number(event.target.value),
                            )
                          }
                        />

                        <button
                          type="button"
                          className="sale-quantity-button"
                          disabled={
                            item.quantity >= item.availableQuantity ||
                            loadingLookup ||
                            savingSale
                          }
                          onClick={() =>
                            updateCartItemQuantity(
                              item.variantId,
                              item.quantity + 1,
                            )
                          }
                        >
                          +
                        </button>
                      </div>
                    </td>

                    <td className="money-cell">
                      {formatSaleCurrency(item.unitPrice)}
                    </td>

                    <td className="money-cell">
                      <strong>
                        {formatSaleCurrency(item.quantity * item.unitPrice)}
                      </strong>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="table-button danger-button"
                        disabled={loadingLookup || savingSale}
                        onClick={() => removeCartItem(item.variantId)}
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

      <section className="panel">
        <div className="section-header">
          <div>
            <h2>الدفع والإجماليات</h2>

            <p className="muted">اختر طريقة الدفع وسجل المبلغ المستلم.</p>
          </div>
        </div>

        <div className="form-grid sale-payment-grid">
          <label>
            طريقة الدفع
            <select
              value={paymentMethod}
              disabled={savingSale}
              onChange={(event) =>
                setPaymentMethod(event.target.value as SalePaymentMethod)
              }
            >
              <option value="cash">نقدي</option>
              <option value="card">بطاقة بنكية</option>
              <option value="wallet">محفظة إلكترونية</option>
              <option value="bank_transfer">تحويل بنكي</option>
            </select>
          </label>

          <label>
            المبلغ المستلم
            <input
              type="number"
              min={invoiceTotal}
              step="0.01"
              value={paidAmount}
              readOnly={paymentMethod !== 'cash'}
              disabled={savingSale || cartItems.length === 0}
              onChange={(event) => {
                const nextPaidAmount = Number(event.target.value)

                setPaidAmount(
                  Number.isFinite(nextPaidAmount) ? nextPaidAmount : 0,
                )
              }}
            />
            <small className="field-note">
              في الدفع غير النقدي يتم استخدام إجمالي الفاتورة تلقائيًا.
            </small>
          </label>
        </div>

        <section className="mini-cards-grid sale-summary-grid">
          <article className="mini-card">
            <span>عدد الأصناف</span>
            <strong>{cartItems.length}</strong>
          </article>

          <article className="mini-card">
            <span>إجمالي القطع</span>
            <strong>{invoiceQuantityTotal}</strong>
          </article>

          <article className="mini-card">
            <span>إجمالي الفاتورة</span>
            <strong>{formatSaleCurrency(invoiceTotal)}</strong>
          </article>

          <article className="mini-card">
            <span>المبلغ المستلم</span>
            <strong>{formatSaleCurrency(paidAmount)}</strong>
          </article>

          <article className="mini-card">
            <span>الباقي للعميل</span>
            <strong className="sale-change-value">
              {formatSaleCurrency(changeTotal)}
            </strong>
          </article>
        </section>

        {!paymentIsValid && cartItems.length > 0 ? (
          <p className="error-message">
            المبلغ المستلم يجب ألا يقل عن إجمالي الفاتورة.
          </p>
        ) : null}
      </section>
    </>
  )
}

export default NewSalePage
