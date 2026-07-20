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

type NewSalePageProps = {
  companyId: string
  branchId: string
}

function createSaleNumber() {
  return `WEB-${Date.now()}`
}

function createIdempotencyKey() {
  return `web-admin-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function NewSalePage({ companyId, branchId }: NewSalePageProps) {
  const { user } = useAuth()

  // زر الحفظ يظهر فقط لمن يملك صلاحية إنشاء البيع
  const canCreateSale =
    user?.roles.includes('admin') ||
    user?.permissions.includes('sales.create') ||
    false

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

  const [cartItems, setCartItems] = useState<CartItem[]>([])
  const [lastSavedSale, setLastSavedSale] = useState<SaleResponse | null>(null)

  const [loadingCustomers, setLoadingCustomers] = useState(false)
  const [loadingStockLocations, setLoadingStockLocations] = useState(false)
  const [loadingLookup, setLoadingLookup] = useState(false)
  // يمنع تنفيذ طلبَي بحث متزامنين عند الضغط السريع على Enter.
  const lookupRequestRef = useRef(false)
  const [savingSale, setSavingSale] = useState(false)
  // يمنع إرسال طلبين متزامنين قبل تحديث React للزر.
  const savingSaleRequestRef = useRef(false)
  const [error, setError] = useState('')

  const invoiceTotal = useMemo(() => {
    return cartItems.reduce((sum, item) => {
      return sum + item.quantity * item.unitPrice
    }, 0)
  }, [cartItems])

  // ======================================================
  // loadStockLocations
  //
  // تحميل أماكن البيع المسموح بها لفرع المستخدم الحالي.
  // ======================================================
  async function loadStockLocations() {
    setLoadingStockLocations(true)
    setError('')

    try {
      const selectedCompanyId = companyId.trim()
      const selectedBranchId = branchId.trim()

      if (!selectedCompanyId || !selectedBranchId) {
        setStockLocations([])
        setStockLocationId('')
        return
      }

      const locationsUrl =
        `/api/pos/stock-locations` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}` +
        `&branchId=${encodeURIComponent(selectedBranchId)}`

      const locationsResponse =
        await requestJson<ApiResponse<StockLocation[]>>(locationsUrl)

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
    // تغير الشركة أو الفرع يعني بدء فاتورة جديدة بالكامل.
    setCartItems([])
    setCode('')
    setQuantity(1)

    setSaleNumber(createSaleNumber())
    setSaleIdempotencyKey(createIdempotencyKey())
    setLastSavedSale(null)

    setCustomerId('')
    setSelectedCustomerName('')
    setCustomerSearchText('')
    setCustomers([])

    if (!companyId.trim() || !branchId.trim()) {
      setStockLocations([])
      setStockLocationId('')
      return
    }

    void loadStockLocations()
  }, [companyId, branchId])

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
      const selectedCompanyId = companyId.trim()
      const selectedStockLocationId = stockLocationId.trim()
      const selectedCode = code.trim()

      if (!selectedCompanyId) {
        throw new Error('companyId is required')
      }

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
        `?companyId=${encodeURIComponent(selectedCompanyId)}` +
        `&stockLocationId=${encodeURIComponent(selectedStockLocationId)}` +
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
    setCartItems((currentItems) =>
      currentItems.filter((item) => item.variantId !== variantId),
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
    setLoadingCustomers(true)
    setError('')

    try {
      const selectedCompanyId = companyId.trim()
      const query = customerSearchText.trim()

      if (!selectedCompanyId) {
        throw new Error('companyId is required')
      }

      // بحث العملاء الخاص بإنشاء البيع.
      // المسار يحتاج sales.create ولا يحتاج customers.view.
      const customersUrl =
        `/api/pos/customers` +
        `?companyId=${encodeURIComponent(selectedCompanyId)}` +
        (query ? `&q=${encodeURIComponent(query)}` : '')

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
      const selectedCompanyId = companyId.trim()
      const selectedBranchId = branchId.trim()
      const selectedStockLocationId = stockLocationId.trim()
      const selectedSaleNumber = saleNumber.trim()
      const selectedCustomerId = customerId.trim()

      if (!selectedCompanyId) {
        throw new Error('companyId is required')
      }

      if (!selectedBranchId) {
        throw new Error('branchId is required')
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

      const saleBody = {
        companyId: selectedCompanyId,
        branchId: selectedBranchId,
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
            method: 'cash',
            amount: invoiceTotal,
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
      setCartItems([])
      setSaleNumber(createSaleNumber())
      // النجاح المؤكد يبدأ هوية مستقلة للفاتورة التالية.
      setSaleIdempotencyKey(createIdempotencyKey())
      setCustomerId('')
      setSelectedCustomerName('')
      setCustomerSearchText('')
      setCustomers([])
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'Unknown save sale error',
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
            <button
              type="button"
              className="primary-button small-button"
              disabled={
                cartItems.length === 0 ||
                savingSale ||
                !branchId.trim() ||
                !stockLocationId.trim()
              }
              onClick={saveSale}
            >
              {savingSale ? 'جاري الحفظ...' : 'حفظ الفاتورة'}
            </button>
          ) : null}
        </div>

        {error ? <p className="error-message">{error}</p> : null}

        {!branchId.trim() ? (
          <p className="error-message">
            المستخدم الحالي غير مرتبط بفرع، لذلك لا يمكن إنشاء فاتورة بيع قبل
            تحديد فرع له.
          </p>
        ) : null}

        {lastSavedSale ? (
          <p className="success-message">
            تم حفظ الفاتورة {lastSavedSale.sale.sale_number} بإجمالي{' '}
            {lastSavedSale.sale.total}
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
                onChange={(event) => setCustomerSearchText(event.target.value)}
                placeholder="اكتب اسم العميل أو التليفون"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    loadCustomers()
                  }
                }}
              />
            </label>

            <button
              type="button"
              className="primary-button small-button"
              disabled={!companyId.trim() || loadingCustomers}
              onClick={loadCustomers}
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
            <p className="muted">الإجمالي الحالي: {invoiceTotal}</p>
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
                    <td>{item.productName}</td>
                    <td>{item.sku}</td>
                    <td>{item.barcode || '-'}</td>
                    <td>{item.sizeName || '-'}</td>
                    <td>{item.colorName || '-'}</td>
                    <td>{item.availableQuantity}</td>
                    <td>{item.quantity}</td>
                    <td>{item.unitPrice}</td>
                    <td>{item.quantity * item.unitPrice}</td>
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
    </>
  )
}

export default NewSalePage
