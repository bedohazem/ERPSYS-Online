import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { requestJson } from '../lib/http'

type ApiResponse<T> = {
  data: T
}

type Supplier = {
  id: string
  name: string
  code: string
}

type StockLocation = {
  id: string
  name: string
  code: string
}

type LookupItem = {
  variant_id: string
  product_name: string
  sku: string
  primary_barcode: string | null
  size_name: string | null
  color_name: string | null
  cost_price: string
}

type OrderCartItem = {
  variantId: string
  productName: string
  sku: string
  sizeName: string | null
  colorName: string | null
  quantity: number
  unitCost: number
  discountAmount: number
  taxAmount: number
}

type PurchaseOrderSummary = {
  id: string
  purchase_number: string
  supplier_id: string
  supplier_name: string
  supplier_code: string
  status: string
  subtotal: string
  discount_total: string
  tax_total: string
  total: string
  order_date: string
  expected_date: string | null
  note: string | null
  items_count: number
  ordered_quantity: string
  received_quantity: string
  remaining_quantity: string
}

type PurchaseOrderDetails = {
  order: PurchaseOrderSummary
  items: Array<{
    id: string
    variant_id: string
    product_name: string
    sku: string
    size_name: string | null
    color_name: string | null
    quantity: string
    received_quantity: string
    remaining_quantity: string
    unit_cost: string
    discount_amount: string
    tax_amount: string
    line_total: string
  }>
}

type PurchaseOrdersPageProps = {
  companyId: string
  branchId: string
}

const moneyFormatter = new Intl.NumberFormat('ar-EG', {
  style: 'currency',
  currency: 'EGP',
  maximumFractionDigits: 2,
})

const quantityFormatter = new Intl.NumberFormat('ar-EG', {
  maximumFractionDigits: 3,
})

function formatMoney(value: number | string) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? moneyFormatter.format(numericValue)
    : '-'
}

function formatQuantity(value: number | string) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? quantityFormatter.format(numericValue)
    : '-'
}

function createOrderNumber() {
  return `PO-WEB-${Date.now()}`
}

function createReceiptNumber() {
  return `POR-WEB-${Date.now()}`
}

function createKey(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function translateStatus(status: string) {
  const labels: Record<string, string> = {
    draft: 'مسودة',
    ordered: 'تم الطلب',
    partially_received: 'استلام جزئي',
    received: 'مستلم بالكامل',
    cancelled: 'ملغي',
  }

  return labels[status] || status
}

function PurchaseOrdersPage({ companyId, branchId }: PurchaseOrdersPageProps) {
  const { user } = useAuth()

  const isAdmin = user?.roles.includes('admin') ?? false

  const canCreate =
    isAdmin || user?.permissions.includes('purchases.create') || false

  const [suppliers, setSuppliers] = useState<Supplier[]>([])

  const [locations, setLocations] = useState<StockLocation[]>([])

  const [orders, setOrders] = useState<PurchaseOrderSummary[]>([])

  const [selectedOrder, setSelectedOrder] =
    useState<PurchaseOrderDetails | null>(null)

  const [supplierId, setSupplierId] = useState('')

  const [purchaseNumber, setPurchaseNumber] = useState(createOrderNumber)

  const [orderKey, setOrderKey] = useState(() => createKey('purchase-order'))

  const [expectedDate, setExpectedDate] = useState('')

  const [note, setNote] = useState('')

  const [code, setCode] = useState('')
  const [entryQuantity, setEntryQuantity] = useState(1)

  const [entryCost, setEntryCost] = useState<number | ''>('')

  const [cartItems, setCartItems] = useState<OrderCartItem[]>([])

  const [orderSearch, setOrderSearch] = useState('')

  const [statusFilter, setStatusFilter] = useState('')

  const [stockLocationId, setStockLocationId] = useState('')

  const [receiptNumber, setReceiptNumber] = useState(createReceiptNumber)

  const [receiptKey, setReceiptKey] = useState(() =>
    createKey('purchase-order-receipt'),
  )

  const [receiveQuantities, setReceiveQuantities] = useState<
    Record<string, number>
  >({})

  const [loading, setLoading] = useState(false)
  const [loadingLookup, setLoadingLookup] = useState(false)

  const [savingOrder, setSavingOrder] = useState(false)

  const [savingReceipt, setSavingReceipt] = useState(false)

  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const lookupLock = useRef(false)
  const orderLock = useRef(false)
  const receiptLock = useRef(false)

  const totals = useMemo(() => {
    const subtotal = cartItems.reduce(
      (total, item) => total + item.quantity * item.unitCost,
      0,
    )

    const discountTotal = cartItems.reduce(
      (total, item) => total + item.discountAmount,
      0,
    )

    const taxTotal = cartItems.reduce(
      (total, item) => total + item.taxAmount,
      0,
    )

    return {
      subtotal,
      discountTotal,
      taxTotal,
      total: subtotal - discountTotal + taxTotal,
    }
  }, [cartItems])

  async function loadSetupData() {
    const branchQuery = branchId.trim()
      ? `&branchId=${encodeURIComponent(branchId.trim())}`
      : ''

    const [suppliersResponse, locationsResponse] = await Promise.all([
      requestJson<ApiResponse<Supplier[]>>(
        `/api/suppliers?companyId=${encodeURIComponent(companyId)}&limit=100`,
      ),

      requestJson<ApiResponse<StockLocation[]>>(
        `/api/purchases/stock-locations?companyId=${encodeURIComponent(
          companyId,
        )}${branchQuery}`,
      ),
    ])

    setSuppliers(suppliersResponse.data)
    setLocations(locationsResponse.data)

    setSupplierId((current) =>
      suppliersResponse.data.some((supplier) => supplier.id === current)
        ? current
        : (suppliersResponse.data[0]?.id ?? ''),
    )

    setStockLocationId((current) =>
      locationsResponse.data.some((location) => location.id === current)
        ? current
        : (locationsResponse.data[0]?.id ?? ''),
    )
  }

  async function loadOrders() {
    setLoading(true)
    setError('')

    try {
      const branchQuery = branchId.trim()
        ? `&branchId=${encodeURIComponent(branchId.trim())}`
        : ''

      const response = await requestJson<ApiResponse<PurchaseOrderSummary[]>>(
        `/api/purchase-orders?companyId=${encodeURIComponent(
          companyId,
        )}${branchQuery}` +
          (orderSearch.trim()
            ? `&q=${encodeURIComponent(orderSearch.trim())}`
            : '') +
          (statusFilter ? `&status=${encodeURIComponent(statusFilter)}` : '') +
          '&limit=100',
      )

      setOrders(response.data)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل أوامر الشراء.',
      )
    } finally {
      setLoading(false)
    }
  }

  async function loadOrderDetails(orderId: string) {
    setError('')

    try {
      const branchQuery = branchId.trim()
        ? `&branchId=${encodeURIComponent(branchId.trim())}`
        : ''

      const response = await requestJson<ApiResponse<PurchaseOrderDetails>>(
        `/api/purchase-orders/${encodeURIComponent(
          orderId,
        )}?companyId=${encodeURIComponent(companyId)}${branchQuery}`,
      )

      setSelectedOrder(response.data)

      const nextQuantities: Record<string, number> = {}

      response.data.items.forEach((item) => {
        nextQuantities[item.id] = Number(item.remaining_quantity)
      })

      setReceiveQuantities(nextQuantities)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل تفاصيل الأمر.',
      )
    }
  }

  async function addItem() {
    if (lookupLock.current) {
      return
    }

    lookupLock.current = true
    setLoadingLookup(true)
    setError('')

    try {
      if (!code.trim()) {
        throw new Error('اكتب باركود أو SKU.')
      }

      if (!Number.isFinite(entryQuantity) || entryQuantity <= 0) {
        throw new Error('الكمية يجب أن تكون أكبر من صفر.')
      }

      const response = await requestJson<ApiResponse<LookupItem>>(
        `/api/purchases/lookup-item?companyId=${encodeURIComponent(
          companyId,
        )}&code=${encodeURIComponent(code.trim())}`,
      )

      const lookupItem = response.data

      const typedCost = Number(entryCost)

      const selectedCost =
        entryCost === '' ? Number(lookupItem.cost_price) : typedCost

      if (!Number.isFinite(selectedCost) || selectedCost < 0) {
        throw new Error('تكلفة الوحدة غير صالحة.')
      }

      setCartItems((currentItems) => {
        const existing = currentItems.find(
          (item) => item.variantId === lookupItem.variant_id,
        )

        if (existing) {
          return currentItems.map((item) =>
            item.variantId === lookupItem.variant_id
              ? {
                  ...item,
                  quantity: item.quantity + entryQuantity,
                  unitCost: selectedCost,
                }
              : item,
          )
        }

        return [
          ...currentItems,
          {
            variantId: lookupItem.variant_id,
            productName: lookupItem.product_name,
            sku: lookupItem.sku,
            sizeName: lookupItem.size_name,
            colorName: lookupItem.color_name,
            quantity: entryQuantity,
            unitCost: selectedCost,
            discountAmount: 0,
            taxAmount: 0,
          },
        ]
      })

      setCode('')
      setEntryQuantity(1)
      setEntryCost('')
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر إضافة الصنف.',
      )
    } finally {
      lookupLock.current = false
      setLoadingLookup(false)
    }
  }

  async function saveOrder() {
    if (orderLock.current) {
      return
    }

    orderLock.current = true
    setSavingOrder(true)
    setError('')
    setSuccess('')

    try {
      if (!supplierId) {
        throw new Error('اختر المورد.')
      }

      if (cartItems.length === 0) {
        throw new Error('أضف أصناف أمر الشراء.')
      }

      const response = await requestJson<ApiResponse<PurchaseOrderDetails>>(
        '/api/purchase-orders',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            companyId,
            branchId: branchId || null,
            supplierId,
            purchaseNumber,
            idempotencyKey: orderKey,
            expectedDate: expectedDate || null,
            note: note || null,
            items: cartItems.map((item) => ({
              variantId: item.variantId,
              quantity: item.quantity,
              unitCost: item.unitCost,
              discountAmount: item.discountAmount,
              taxAmount: item.taxAmount,
            })),
          }),
        },
      )

      setSelectedOrder(response.data)

      setSuccess(`تم إنشاء أمر الشراء ${response.data.order.purchase_number}.`)

      setCartItems([])
      setPurchaseNumber(createOrderNumber())
      setOrderKey(createKey('purchase-order'))
      setExpectedDate('')
      setNote('')

      await loadOrders()
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر إنشاء أمر الشراء.',
      )
    } finally {
      orderLock.current = false
      setSavingOrder(false)
    }
  }

  async function receiveOrder() {
    if (receiptLock.current || !selectedOrder) {
      return
    }

    receiptLock.current = true
    setSavingReceipt(true)
    setError('')
    setSuccess('')

    try {
      if (!stockLocationId) {
        throw new Error('اختر مكان الاستلام.')
      }

      const selectedItems = selectedOrder.items
        .map((item) => ({
          purchaseOrderItemId: item.id,
          quantity: receiveQuantities[item.id] ?? 0,
        }))
        .filter((item) => Number.isFinite(item.quantity) && item.quantity > 0)

      if (selectedItems.length === 0) {
        throw new Error('حدد كمية استلام لصنف واحد على الأقل.')
      }

      const response = await requestJson<
        ApiResponse<{
          order: PurchaseOrderSummary
          items: PurchaseOrderDetails['items']
        }>
      >(
        `/api/purchase-orders/${encodeURIComponent(
          selectedOrder.order.id,
        )}/receive`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            companyId,
            branchId: branchId || null,
            stockLocationId,
            receiptNumber,
            idempotencyKey: receiptKey,
            items: selectedItems,
          }),
        },
      )

      setSuccess(
        `تم الاستلام من أمر الشراء ${response.data.order.purchase_number}.`,
      )

      setReceiptNumber(createReceiptNumber())
      setReceiptKey(createKey('purchase-order-receipt'))

      await loadOrderDetails(selectedOrder.order.id)

      await loadOrders()
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر استلام أمر الشراء.',
      )
    } finally {
      receiptLock.current = false
      setSavingReceipt(false)
    }
  }

  useEffect(() => {
    if (!companyId.trim()) {
      return
    }

    void loadOrders()

    if (canCreate) {
      void loadSetupData()
    }
  }, [companyId, branchId, canCreate])

  return (
    <>
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>أوامر الشراء</h2>
            <p className="muted">إنشاء ومتابعة واستلام أوامر الشراء.</p>
          </div>

          <button
            type="button"
            className="table-button"
            onClick={() => void loadOrders()}
          >
            تحديث
          </button>
        </div>

        {error ? <p className="error-message">{error}</p> : null}

        {success ? <p className="success-message">{success}</p> : null}
      </section>

      {canCreate ? (
        <section className="panel">
          <h2>أمر شراء جديد</h2>

          <div className="form-grid purchase-order-header-grid">
            <label>
              رقم الأمر
              <input value={purchaseNumber} readOnly />
            </label>

            <label>
              المورد
              <select
                value={supplierId}
                onChange={(event) => setSupplierId(event.target.value)}
              >
                <option value="">اختر المورد</option>

                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              التاريخ المتوقع
              <input
                type="date"
                value={expectedDate}
                onChange={(event) => setExpectedDate(event.target.value)}
              />
            </label>

            <label>
              ملاحظة
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
          </div>

          <div className="purchase-order-item-entry">
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="باركود أو SKU"
            />

            <input
              type="number"
              min="0.001"
              step="0.001"
              value={entryQuantity}
              onChange={(event) => setEntryQuantity(Number(event.target.value))}
              placeholder="الكمية"
            />

            <input
              type="number"
              min="0"
              step="0.01"
              value={entryCost}
              onChange={(event) =>
                setEntryCost(
                  event.target.value === '' ? '' : Number(event.target.value),
                )
              }
              placeholder="التكلفة"
            />

            <button
              type="button"
              className="table-button"
              disabled={loadingLookup || !code.trim()}
              onClick={() => void addItem()}
            >
              إضافة الصنف
            </button>
          </div>

          {cartItems.length > 0 ? (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>الصنف</th>
                    <th>SKU</th>
                    <th>الكمية</th>
                    <th>التكلفة</th>
                    <th>الإجمالي</th>
                    <th>حذف</th>
                  </tr>
                </thead>

                <tbody>
                  {cartItems.map((item) => (
                    <tr key={item.variantId}>
                      <td>{item.productName}</td>
                      <td>{item.sku}</td>

                      <td>
                        <input
                          className="purchase-table-number-input"
                          type="number"
                          min="0.001"
                          step="0.001"
                          value={item.quantity}
                          onChange={(event) =>
                            setCartItems((currentItems) =>
                              currentItems.map((currentItem) =>
                                currentItem.variantId === item.variantId
                                  ? {
                                      ...currentItem,
                                      quantity: Number(event.target.value),
                                    }
                                  : currentItem,
                              ),
                            )
                          }
                        />
                      </td>

                      <td>{formatMoney(item.unitCost)}</td>

                      <td>{formatMoney(item.quantity * item.unitCost)}</td>

                      <td>
                        <button
                          type="button"
                          className="table-button danger-button"
                          onClick={() =>
                            setCartItems((currentItems) =>
                              currentItems.filter(
                                (currentItem) =>
                                  currentItem.variantId !== item.variantId,
                              ),
                            )
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
          ) : null}

          <div className="purchase-order-total">
            <span>
              الإجمالي: <strong>{formatMoney(totals.total)}</strong>
            </span>

            <button
              type="button"
              className="primary-button"
              disabled={savingOrder || !supplierId || cartItems.length === 0}
              onClick={() => void saveOrder()}
            >
              {savingOrder ? 'جاري الحفظ...' : 'إنشاء أمر الشراء'}
            </button>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="purchase-order-filters">
          <input
            value={orderSearch}
            onChange={(event) => setOrderSearch(event.target.value)}
            placeholder="رقم الأمر أو المورد"
          />

          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            <option value="">كل الحالات</option>
            <option value="ordered">تم الطلب</option>
            <option value="partially_received">استلام جزئي</option>
            <option value="received">مستلم بالكامل</option>
          </select>

          <button
            type="button"
            className="table-button"
            onClick={() => void loadOrders()}
          >
            بحث
          </button>
        </div>

        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>رقم الأمر</th>
                <th>المورد</th>
                <th>المطلوب</th>
                <th>المستلم</th>
                <th>المتبقي</th>
                <th>الإجمالي</th>
                <th>الحالة</th>
                <th>عرض</th>
              </tr>
            </thead>

            <tbody>
              {orders.map((order) => (
                <tr key={order.id}>
                  <td>{order.purchase_number}</td>
                  <td>{order.supplier_name}</td>
                  <td>{formatQuantity(order.ordered_quantity)}</td>
                  <td>{formatQuantity(order.received_quantity)}</td>
                  <td>{formatQuantity(order.remaining_quantity)}</td>
                  <td>{formatMoney(order.total)}</td>
                  <td>{translateStatus(order.status)}</td>
                  <td>
                    <button
                      type="button"
                      className="table-button"
                      onClick={() => void loadOrderDetails(order.id)}
                    >
                      عرض
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {selectedOrder ? (
        <section className="panel">
          <div className="section-header">
            <div>
              <h2>{selectedOrder.order.purchase_number}</h2>

              <p className="muted">
                المورد: {selectedOrder.order.supplier_name}
              </p>
            </div>

            <strong>{translateStatus(selectedOrder.order.status)}</strong>
          </div>

          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>الصنف</th>
                  <th>المطلوب</th>
                  <th>المستلم</th>
                  <th>المتبقي</th>
                  {canCreate ? <th>استلام الآن</th> : null}
                </tr>
              </thead>

              <tbody>
                {selectedOrder.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.product_name}</td>

                    <td>{formatQuantity(item.quantity)}</td>

                    <td>{formatQuantity(item.received_quantity)}</td>

                    <td>{formatQuantity(item.remaining_quantity)}</td>

                    {canCreate ? (
                      <td>
                        <input
                          className="purchase-table-number-input"
                          type="number"
                          min="0"
                          step="0.001"
                          max={item.remaining_quantity}
                          disabled={Number(item.remaining_quantity) <= 0}
                          value={receiveQuantities[item.id] ?? 0}
                          onChange={(event) =>
                            setReceiveQuantities((current) => ({
                              ...current,
                              [item.id]: Number(event.target.value),
                            }))
                          }
                        />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {canCreate && selectedOrder.order.status !== 'received' ? (
            <div className="purchase-order-receive-panel">
              <label>
                مكان الاستلام
                <select
                  value={stockLocationId}
                  onChange={(event) => setStockLocationId(event.target.value)}
                >
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                رقم إذن الاستلام
                <input value={receiptNumber} readOnly />
              </label>

              <button
                type="button"
                className="primary-button"
                disabled={savingReceipt || !stockLocationId}
                onClick={() => void receiveOrder()}
              >
                {savingReceipt ? 'جاري الاستلام...' : 'استلام الكميات المحددة'}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  )
}

export default PurchaseOrdersPage
