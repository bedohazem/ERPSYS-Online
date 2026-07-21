import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { requestJson } from '../lib/http'

type Supplier = {
  id: string
  company_id: string
  name: string
  code: string
  phone: string | null
  email: string | null
  address: string | null
  tax_number: string | null
  is_active: boolean
}

type StockLocation = {
  id: string
  company_id: string
  branch_id: string | null
  branch_name: string | null
  code: string
  name: string
  location_type: string
}

type PurchaseLookupItem = {
  variant_id: string
  product_id: string
  product_name: string
  sku: string
  primary_barcode: string | null
  size_name: string | null
  color_name: string | null
  cost_price: string
  selling_price: string
}

type PurchaseCartItem = {
  variantId: string
  productName: string
  sku: string
  barcode: string | null
  sizeName: string | null
  colorName: string | null
  quantity: number
  unitCost: number
  discountAmount: number
  taxAmount: number
}

type PurchaseReceiptSummary = {
  id: string
  company_id: string
  branch_id: string | null
  branch_name: string | null
  stock_location_id: string
  stock_location_name: string
  stock_location_code: string
  supplier_id: string
  supplier_name: string
  supplier_code: string
  purchase_order_id: string | null
  receipt_number: string
  status: string
  subtotal: string
  discount_total: string
  tax_total: string
  total: string
  received_at: string
  note: string | null
  created_by: string | null
  created_by_name: string | null
  created_at: string
  items_count: number
  received_quantity: string
}

type PurchaseReceiptDetails = {
  receipt: PurchaseReceiptSummary
  items: Array<{
    id: string
    variant_id: string
    sku: string
    primary_barcode: string | null
    product_name: string
    size_name: string | null
    color_name: string | null
    quantity: string
    unit_cost: string
    discount_amount: string
    tax_amount: string
    line_total: string
    current_average_cost: string
  }>
}

type ApiResponse<T> = {
  data: T
}

type PurchasesPageProps = {
  companyId: string
  branchId: string
}

const purchaseCurrencyFormatter = new Intl.NumberFormat('ar-EG', {
  style: 'currency',
  currency: 'EGP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})

const purchaseQuantityFormatter = new Intl.NumberFormat('ar-EG', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
})

const purchaseDateFormatter = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatPurchaseCurrency(value: number | string) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? purchaseCurrencyFormatter.format(numericValue)
    : '-'
}

function formatPurchaseQuantity(value: number | string) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? purchaseQuantityFormatter.format(numericValue)
    : '-'
}

function formatPurchaseDate(value: string) {
  const parsedDate = new Date(value)

  return Number.isNaN(parsedDate.getTime())
    ? '-'
    : purchaseDateFormatter.format(parsedDate)
}

function roundPurchaseMoney(value: number) {
  return Number(value.toFixed(2))
}

function createReceiptNumber() {
  return `PR-WEB-${Date.now()}`
}

function createReceiptIdempotencyKey() {
  return `web-purchase-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function PurchasesPage({ companyId, branchId }: PurchasesPageProps) {
  const { user } = useAuth()

  const isAdmin = user?.roles.includes('admin') ?? false

  const hasPermission = (permission: string) =>
    isAdmin || user?.permissions.includes(permission) || false

  const canViewPurchaseReceipts =
    hasPermission('purchases.view') || hasPermission('purchases.create')

  const canViewSuppliers =
    canViewPurchaseReceipts ||
    hasPermission('suppliers.view') ||
    hasPermission('suppliers.manage')

  const canAccessPurchasesPage = canViewPurchaseReceipts || canViewSuppliers

  const canCreatePurchase = hasPermission('purchases.create')

  const canManageSuppliers = hasPermission('suppliers.manage')

  const [suppliers, setSuppliers] = useState<Supplier[]>([])

  const [stockLocations, setStockLocations] = useState<StockLocation[]>([])

  const [receipts, setReceipts] = useState<PurchaseReceiptSummary[]>([])

  const [selectedReceipt, setSelectedReceipt] =
    useState<PurchaseReceiptDetails | null>(null)

  const [supplierSearch, setSupplierSearch] = useState('')

  const [receiptSearch, setReceiptSearch] = useState('')

  const [selectedSupplierId, setSelectedSupplierId] = useState('')

  const [stockLocationId, setStockLocationId] = useState('')

  const [receiptNumber, setReceiptNumber] = useState(createReceiptNumber)

  const [receiptIdempotencyKey, setReceiptIdempotencyKey] = useState(
    createReceiptIdempotencyKey,
  )

  const [receiptNote, setReceiptNote] = useState('')

  const [code, setCode] = useState('')
  const [quantity, setQuantity] = useState(1)
  const [unitCost, setUnitCost] = useState<number | ''>('')
  const [discountAmount, setDiscountAmount] = useState(0)
  const [taxAmount, setTaxAmount] = useState(0)

  const [cartItems, setCartItems] = useState<PurchaseCartItem[]>([])

  const [newSupplierName, setNewSupplierName] = useState('')

  const [newSupplierCode, setNewSupplierCode] = useState('')

  const [newSupplierPhone, setNewSupplierPhone] = useState('')

  const [newSupplierEmail, setNewSupplierEmail] = useState('')

  const [newSupplierAddress, setNewSupplierAddress] = useState('')

  const [newSupplierTaxNumber, setNewSupplierTaxNumber] = useState('')

  const [showSupplierForm, setShowSupplierForm] = useState(false)
  const [editingSupplierId, setEditingSupplierId] = useState<string | null>(
    null,
  )

  const [loadingSuppliers, setLoadingSuppliers] = useState(false)

  const [loadingLocations, setLoadingLocations] = useState(false)

  const [loadingReceipts, setLoadingReceipts] = useState(false)

  const [loadingReceiptDetails, setLoadingReceiptDetails] = useState(false)

  const [loadingLookup, setLoadingLookup] = useState(false)

  const [savingSupplier, setSavingSupplier] = useState(false)

  const [savingReceipt, setSavingReceipt] = useState(false)

  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const supplierRequestRef = useRef(false)
  const lookupRequestRef = useRef(false)
  const receiptRequestRef = useRef(false)
  const codeInputRef = useRef<HTMLInputElement>(null)

  const selectedSupplier = suppliers.find(
    (supplier) => supplier.id === selectedSupplierId,
  )

  const purchaseTotals = useMemo(() => {
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

    const total = subtotal - discountTotal + taxTotal

    const quantityTotal = cartItems.reduce(
      (total, item) => total + item.quantity,
      0,
    )

    return {
      subtotal: roundPurchaseMoney(subtotal),
      discountTotal: roundPurchaseMoney(discountTotal),
      taxTotal: roundPurchaseMoney(taxTotal),
      total: roundPurchaseMoney(total),
      quantityTotal,
    }
  }, [cartItems])

  function startEditingSupplier(supplier: Supplier) {
    setEditingSupplierId(supplier.id)
    setNewSupplierName(supplier.name)
    setNewSupplierCode(supplier.code)
    setNewSupplierPhone(supplier.phone || '')
    setNewSupplierEmail(supplier.email || '')
    setNewSupplierAddress(supplier.address || '')
    setNewSupplierTaxNumber(supplier.tax_number || '')
    setShowSupplierForm(true)
  }

  function resetSupplierForm() {
    setNewSupplierName('')
    setNewSupplierCode('')
    setNewSupplierPhone('')
    setNewSupplierEmail('')
    setNewSupplierAddress('')
    setNewSupplierTaxNumber('')
    setEditingSupplierId(null)
  }

  function resetReceiptDraft(keepSuccess = false) {
    setCartItems([])
    setCode('')
    setQuantity(1)
    setUnitCost('')
    setDiscountAmount(0)
    setTaxAmount(0)
    setReceiptNote('')
    setReceiptNumber(createReceiptNumber())
    setReceiptIdempotencyKey(createReceiptIdempotencyKey())
    setError('')

    if (!keepSuccess) {
      setSuccess('')
    }

    window.setTimeout(() => {
      codeInputRef.current?.focus()
    }, 0)
  }

  async function loadSuppliers() {
    setLoadingSuppliers(true)
    setError('')

    try {
      const url =
        `/api/suppliers` +
        `?companyId=${encodeURIComponent(companyId.trim())}` +
        (supplierSearch.trim()
          ? `&q=${encodeURIComponent(supplierSearch.trim())}`
          : '') +
        '&limit=100'

      const response = await requestJson<ApiResponse<Supplier[]>>(url)

      setSuppliers(response.data)

      setSelectedSupplierId((currentSupplierId) => {
        const currentSupplierStillExists = response.data.some(
          (supplier) => supplier.id === currentSupplierId,
        )

        if (currentSupplierStillExists) {
          return currentSupplierId
        }

        return response.data[0]?.id ?? ''
      })
    } catch (currentError) {
      setSuppliers([])
      setSelectedSupplierId('')

      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل الموردين.',
      )
    } finally {
      setLoadingSuppliers(false)
    }
  }

  async function loadStockLocations() {
    setLoadingLocations(true)
    setError('')

    try {
      const url =
        `/api/purchases/stock-locations` +
        `?companyId=${encodeURIComponent(companyId.trim())}` +
        (branchId.trim()
          ? `&branchId=${encodeURIComponent(branchId.trim())}`
          : '')

      const response = await requestJson<ApiResponse<StockLocation[]>>(url)

      setStockLocations(response.data)

      setStockLocationId((currentLocationId) => {
        const currentLocationStillExists = response.data.some(
          (location) => location.id === currentLocationId,
        )

        if (currentLocationStillExists) {
          return currentLocationId
        }

        return response.data[0]?.id ?? ''
      })
    } catch (currentError) {
      setStockLocations([])
      setStockLocationId('')

      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل أماكن التخزين.',
      )
    } finally {
      setLoadingLocations(false)
    }
  }

  async function loadReceipts() {
    setLoadingReceipts(true)
    setError('')

    try {
      const url =
        `/api/purchases/receipts` +
        `?companyId=${encodeURIComponent(companyId.trim())}` +
        (branchId.trim()
          ? `&branchId=${encodeURIComponent(branchId.trim())}`
          : '') +
        (receiptSearch.trim()
          ? `&q=${encodeURIComponent(receiptSearch.trim())}`
          : '') +
        '&limit=100'

      const response =
        await requestJson<ApiResponse<PurchaseReceiptSummary[]>>(url)

      setReceipts(response.data)
    } catch (currentError) {
      setReceipts([])

      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل أذون الاستلام.',
      )
    } finally {
      setLoadingReceipts(false)
    }
  }

  async function loadReceiptDetails(receiptId: string) {
    setLoadingReceiptDetails(true)
    setError('')

    try {
      const url =
        `/api/purchases/receipts/${encodeURIComponent(receiptId)}` +
        `?companyId=${encodeURIComponent(companyId.trim())}` +
        (branchId.trim()
          ? `&branchId=${encodeURIComponent(branchId.trim())}`
          : '')

      const response =
        await requestJson<ApiResponse<PurchaseReceiptDetails>>(url)

      setSelectedReceipt(response.data)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل تفاصيل إذن الاستلام.',
      )
    } finally {
      setLoadingReceiptDetails(false)
    }
  }

  async function createSupplier() {
    if (supplierRequestRef.current) {
      return
    }

    supplierRequestRef.current = true
    setSavingSupplier(true)
    setError('')
    setSuccess('')

    try {
      if (!newSupplierName.trim()) {
        throw new Error('اسم المورد مطلوب.')
      }

      const supplierUrl = editingSupplierId
        ? `/api/suppliers/${encodeURIComponent(editingSupplierId)}`
        : '/api/suppliers'

      const response = await requestJson<ApiResponse<Supplier>>(supplierUrl, {
        method: editingSupplierId ? 'PATCH' : 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          companyId: companyId.trim(),
          name: newSupplierName.trim(),
          code: newSupplierCode.trim() || null,
          phone: newSupplierPhone.trim() || null,
          email: newSupplierEmail.trim() || null,
          address: newSupplierAddress.trim() || null,
          taxNumber: newSupplierTaxNumber.trim() || null,
          isActive: true,
        }),
      })

      setSuccess(
        editingSupplierId
          ? `تم تحديث المورد ${response.data.name} بنجاح.`
          : `تم إنشاء المورد ${response.data.name} بنجاح.`,
      )

      resetSupplierForm()
      setShowSupplierForm(false)

      await loadSuppliers()
      setSelectedSupplierId(response.data.id)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر إنشاء المورد.',
      )
    } finally {
      supplierRequestRef.current = false
      setSavingSupplier(false)
    }
  }

  async function lookupAndAddItem() {
    if (lookupRequestRef.current) {
      return
    }

    lookupRequestRef.current = true
    setLoadingLookup(true)
    setError('')
    setSuccess('')

    try {
      if (!code.trim()) {
        throw new Error('اكتب باركود أو SKU الصنف.')
      }

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new Error('الكمية يجب أن تكون أكبر من صفر.')
      }

      const url =
        `/api/purchases/lookup-item` +
        `?companyId=${encodeURIComponent(companyId.trim())}` +
        `&code=${encodeURIComponent(code.trim())}`

      const response = await requestJson<ApiResponse<PurchaseLookupItem>>(url)

      const item = response.data

      const typedUnitCost = Number(unitCost)

      const selectedUnitCost =
        unitCost !== '' && Number.isFinite(typedUnitCost) && typedUnitCost >= 0
          ? typedUnitCost
          : Number(item.cost_price)

      if (!Number.isFinite(selectedUnitCost) || selectedUnitCost < 0) {
        throw new Error('تكلفة الصنف غير صالحة.')
      }

      const existingItem = cartItems.find(
        (cartItem) => cartItem.variantId === item.variant_id,
      )

      if (existingItem) {
        setCartItems((currentItems) =>
          currentItems.map((cartItem) =>
            cartItem.variantId === item.variant_id
              ? {
                  ...cartItem,
                  quantity: cartItem.quantity + quantity,
                  unitCost: selectedUnitCost,
                }
              : cartItem,
          ),
        )
      } else {
        setCartItems((currentItems) => [
          ...currentItems,
          {
            variantId: item.variant_id,
            productName: item.product_name,
            sku: item.sku,
            barcode: item.primary_barcode,
            sizeName: item.size_name,
            colorName: item.color_name,
            quantity,
            unitCost: selectedUnitCost,
            discountAmount: Math.max(Number(discountAmount), 0),
            taxAmount: Math.max(Number(taxAmount), 0),
          },
        ])
      }

      setCode('')
      setQuantity(1)
      setUnitCost(0)
      setDiscountAmount(0)
      setTaxAmount(0)

      window.setTimeout(() => {
        codeInputRef.current?.focus()
      }, 0)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر إضافة الصنف.',
      )
    } finally {
      lookupRequestRef.current = false
      setLoadingLookup(false)
    }
  }

  function updateCartItem(
    variantId: string,
    changes: Partial<
      Pick<
        PurchaseCartItem,
        'quantity' | 'unitCost' | 'discountAmount' | 'taxAmount'
      >
    >,
  ) {
    const currentItem = cartItems.find((item) => item.variantId === variantId)

    if (!currentItem) {
      return
    }

    const nextItem = {
      ...currentItem,
      ...changes,
    }

    if (!Number.isFinite(nextItem.quantity) || nextItem.quantity <= 0) {
      setError('الكمية يجب أن تكون أكبر من صفر.')
      return
    }

    if (!Number.isFinite(nextItem.unitCost) || nextItem.unitCost < 0) {
      setError('تكلفة الوحدة غير صالحة.')
      return
    }

    if (
      !Number.isFinite(nextItem.discountAmount) ||
      nextItem.discountAmount < 0
    ) {
      setError('قيمة الخصم غير صالحة.')
      return
    }

    if (!Number.isFinite(nextItem.taxAmount) || nextItem.taxAmount < 0) {
      setError('قيمة الضريبة غير صالحة.')
      return
    }

    const lineBase = nextItem.quantity * nextItem.unitCost

    if (nextItem.discountAmount > lineBase + nextItem.taxAmount) {
      setError('الخصم لا يمكن أن يجعل إجمالي الصنف سالبًا.')
      return
    }

    setError('')

    setCartItems((currentItems) =>
      currentItems.map((item) =>
        item.variantId === variantId ? nextItem : item,
      ),
    )
  }

  function removeCartItem(variantId: string) {
    setError('')

    setCartItems((currentItems) =>
      currentItems.filter((item) => item.variantId !== variantId),
    )
  }

  async function saveReceipt() {
    if (receiptRequestRef.current) {
      return
    }

    receiptRequestRef.current = true
    setSavingReceipt(true)
    setError('')
    setSuccess('')

    try {
      if (!selectedSupplierId) {
        throw new Error('اختر المورد أولًا.')
      }

      if (!stockLocationId) {
        throw new Error('اختر مكان استلام البضاعة.')
      }

      if (cartItems.length === 0) {
        throw new Error('أضف صنفًا واحدًا على الأقل.')
      }

      if (purchaseTotals.total < 0) {
        throw new Error('إجمالي إذن الاستلام غير صالح.')
      }

      const response = await requestJson<ApiResponse<PurchaseReceiptDetails>>(
        '/api/purchases/receipts',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            companyId: companyId.trim(),
            branchId: branchId.trim() || null,
            supplierId: selectedSupplierId,
            stockLocationId,
            receiptNumber,
            idempotencyKey: receiptIdempotencyKey,
            note: receiptNote.trim() || null,
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

      setSelectedReceipt(response.data)

      setSuccess(
        `تم حفظ إذن الاستلام ${response.data.receipt.receipt_number} وإضافة الكميات للمخزون.`,
      )

      resetReceiptDraft(true)
      await loadReceipts()
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر حفظ إذن الاستلام.',
      )
    } finally {
      receiptRequestRef.current = false
      setSavingReceipt(false)
    }
  }

  useEffect(() => {
    if (!canAccessPurchasesPage || !companyId.trim()) {
      return
    }

    if (canViewSuppliers) {
      void loadSuppliers()
    }

    if (canViewPurchaseReceipts) {
      void loadReceipts()
    }
  }, [
    canAccessPurchasesPage,
    canViewSuppliers,
    canViewPurchaseReceipts,
    companyId,
    branchId,
  ])

  useEffect(() => {
    setCartItems([])
    setCode('')
    setSuccess('')
    setSelectedReceipt(null)

    if (!canCreatePurchase || !companyId.trim()) {
      setStockLocations([])
      setStockLocationId('')
      return
    }

    void loadStockLocations()
  }, [canCreatePurchase, companyId, branchId])

  return (
    <>
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>المشتريات والموردون</h2>

            <p className="muted">
              تسجيل استلام البضاعة وإضافتها مباشرة إلى مخزون PostgreSQL.
            </p>
          </div>

          <div className="section-actions">
            <button
              type="button"
              className="table-button"
              disabled={loadingSuppliers || loadingReceipts}
              onClick={() => {
                void loadSuppliers()
                void loadReceipts()
              }}
            >
              تحديث البيانات
            </button>

            {canManageSuppliers ? (
              <button
                type="button"
                className="primary-button small-button"
                onClick={() =>
                  setShowSupplierForm((currentValue) => !currentValue)
                }
              >
                {showSupplierForm ? 'إغلاق نموذج المورد' : 'مورد جديد'}
              </button>
            ) : null}
          </div>
        </div>

        {error ? <p className="error-message">{error}</p> : null}

        {success ? <p className="success-message">{success}</p> : null}
      </section>

      {showSupplierForm && canManageSuppliers ? (
        <section className="panel">
          <div className="section-header">
            <div>
              <h2>
                {editingSupplierId ? 'تعديل بيانات المورد' : 'إنشاء مورد جديد'}
              </h2>

              <p className="muted">
                يمكن استخدام المورد مباشرة في إذن الاستلام بعد الحفظ.
              </p>
            </div>
          </div>

          <div className="form-grid supplier-create-grid">
            <label>
              اسم المورد
              <input
                value={newSupplierName}
                disabled={savingSupplier}
                onChange={(event) => setNewSupplierName(event.target.value)}
                placeholder="اسم المورد"
              />
            </label>

            <label>
              كود المورد
              <input
                value={newSupplierCode}
                disabled={savingSupplier}
                onChange={(event) => setNewSupplierCode(event.target.value)}
                placeholder="اختياري"
              />
            </label>

            <label>
              الهاتف
              <input
                value={newSupplierPhone}
                disabled={savingSupplier}
                onChange={(event) => setNewSupplierPhone(event.target.value)}
                placeholder="رقم الهاتف"
              />
            </label>

            <label>
              البريد الإلكتروني
              <input
                type="email"
                value={newSupplierEmail}
                disabled={savingSupplier}
                onChange={(event) => setNewSupplierEmail(event.target.value)}
                placeholder="اختياري"
              />
            </label>

            <label>
              الرقم الضريبي
              <input
                value={newSupplierTaxNumber}
                disabled={savingSupplier}
                onChange={(event) =>
                  setNewSupplierTaxNumber(event.target.value)
                }
                placeholder="اختياري"
              />
            </label>

            <label className="supplier-address-field">
              العنوان
              <input
                value={newSupplierAddress}
                disabled={savingSupplier}
                onChange={(event) => setNewSupplierAddress(event.target.value)}
                placeholder="عنوان المورد"
              />
            </label>
          </div>

          <div className="purchase-form-actions">
            <button
              type="button"
              className="table-button"
              disabled={savingSupplier}
              onClick={resetSupplierForm}
            >
              مسح
            </button>

            <button
              type="button"
              className="primary-button small-button"
              disabled={savingSupplier || !newSupplierName.trim()}
              onClick={() => void createSupplier()}
            >
              {savingSupplier
                ? 'جاري الحفظ...'
                : editingSupplierId
                  ? 'حفظ التعديلات'
                  : 'حفظ المورد'}
            </button>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="section-header">
          <div>
            <h2>الموردون</h2>

            <p className="muted">البحث بالاسم أو الكود أو الهاتف.</p>
          </div>

          <span className="record-count-badge">{suppliers.length} مورد</span>
        </div>

        <div className="purchase-supplier-search">
          <input
            value={supplierSearch}
            disabled={loadingSuppliers}
            onChange={(event) => setSupplierSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void loadSuppliers()
              }
            }}
            placeholder="بحث عن مورد"
          />

          <button
            type="button"
            className="table-button"
            disabled={loadingSuppliers}
            onClick={() => void loadSuppliers()}
          >
            {loadingSuppliers ? 'جاري البحث...' : 'بحث'}
          </button>
        </div>

        {suppliers.length === 0 ? (
          <p className="muted">لا توجد نتائج للموردين.</p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>الاسم</th>
                  <th>الكود</th>
                  <th>الهاتف</th>
                  <th>البريد</th>
                  <th>الرقم الضريبي</th>
                  <th>اختيار</th>
                  <th>تعديل</th>
                </tr>
              </thead>

              <tbody>
                {suppliers.map((supplier) => (
                  <tr key={supplier.id}>
                    <td>
                      <strong>{supplier.name}</strong>
                    </td>

                    <td>{supplier.code}</td>
                    <td>{supplier.phone || '-'}</td>
                    <td>{supplier.email || '-'}</td>
                    <td>{supplier.tax_number || '-'}</td>

                    <td>
                      <button
                        type="button"
                        className={
                          selectedSupplierId === supplier.id
                            ? 'table-button selected-table-button'
                            : 'table-button'
                        }
                        onClick={() => setSelectedSupplierId(supplier.id)}
                      >
                        {selectedSupplierId === supplier.id ? 'محدد' : 'اختيار'}
                      </button>
                    </td>
                    <td>
                      {canManageSuppliers ? (
                        <button
                          type="button"
                          className="table-button"
                          disabled={savingSupplier}
                          onClick={() => startEditingSupplier(supplier)}
                        >
                          تعديل
                        </button>
                      ) : (
                        '-'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canCreatePurchase ? (
        <section className="panel">
          <div className="section-header">
            <div>
              <h2>إذن استلام مشتريات جديد</h2>

              <p className="muted">
                الحفظ النهائي يضيف الكميات إلى المخزون ويسجل حركة شراء.
              </p>
            </div>

            <button
              type="button"
              className="table-button"
              disabled={savingReceipt}
              onClick={() => resetReceiptDraft()}
            >
              مسح الإذن
            </button>
          </div>

          <div className="form-grid purchase-receipt-header-grid">
            <label>
              رقم إذن الاستلام
              <input value={receiptNumber} readOnly aria-readonly="true" />
            </label>

            <label>
              المورد
              <select
                value={selectedSupplierId}
                disabled={savingReceipt || loadingSuppliers}
                onChange={(event) => setSelectedSupplierId(event.target.value)}
              >
                <option value="">اختر المورد</option>

                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name} ({supplier.code})
                  </option>
                ))}
              </select>
            </label>

            <label>
              مكان الاستلام
              <select
                value={stockLocationId}
                disabled={savingReceipt || loadingLocations}
                onChange={(event) => setStockLocationId(event.target.value)}
              >
                <option value="">اختر مكان التخزين</option>

                {stockLocations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name} ({location.code})
                  </option>
                ))}
              </select>
            </label>

            <label>
              ملاحظة
              <input
                value={receiptNote}
                disabled={savingReceipt}
                onChange={(event) => setReceiptNote(event.target.value)}
                placeholder="اختياري"
              />
            </label>
          </div>

          {selectedSupplier ? (
            <article className="purchase-selected-supplier">
              <div>
                <span>المورد المحدد</span>
                <strong>{selectedSupplier.name}</strong>
              </div>

              <div>
                <span>الكود</span>
                <strong>{selectedSupplier.code}</strong>
              </div>

              <div>
                <span>الهاتف</span>
                <strong>{selectedSupplier.phone || '-'}</strong>
              </div>
            </article>
          ) : null}

          <div className="purchase-item-entry">
            <label>
              باركود أو SKU
              <input
                ref={codeInputRef}
                value={code}
                disabled={loadingLookup || savingReceipt}
                onChange={(event) => setCode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void lookupAndAddItem()
                  }
                }}
                placeholder="امسح الباركود"
              />
            </label>

            <label>
              الكمية
              <input
                type="number"
                min="0.001"
                step="0.001"
                value={quantity}
                disabled={savingReceipt}
                onChange={(event) => setQuantity(Number(event.target.value))}
              />
            </label>

            <label>
              تكلفة الوحدة
              <input
                type="number"
                min="0"
                step="0.01"
                value={unitCost}
                disabled={savingReceipt}
                onChange={(event) => {
                  const nextValue = event.target.value

                  setUnitCost(nextValue === '' ? '' : Number(nextValue))
                }}
              />
            </label>

            <label>
              خصم السطر
              <input
                type="number"
                min="0"
                step="0.01"
                value={discountAmount}
                disabled={savingReceipt}
                onChange={(event) =>
                  setDiscountAmount(Number(event.target.value))
                }
              />
            </label>

            <label>
              ضريبة السطر
              <input
                type="number"
                min="0"
                step="0.01"
                value={taxAmount}
                disabled={savingReceipt}
                onChange={(event) => setTaxAmount(Number(event.target.value))}
              />
            </label>

            <button
              type="button"
              className="table-button"
              disabled={!code.trim() || loadingLookup || savingReceipt}
              onClick={() => void lookupAndAddItem()}
            >
              {loadingLookup ? 'جاري البحث...' : 'إضافة الصنف'}
            </button>
          </div>

          {cartItems.length === 0 ? (
            <p className="muted">لم تتم إضافة أصناف إلى إذن الاستلام.</p>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>الصنف</th>
                    <th>SKU</th>
                    <th>المقاس</th>
                    <th>اللون</th>
                    <th>الكمية</th>
                    <th>التكلفة</th>
                    <th>الخصم</th>
                    <th>الضريبة</th>
                    <th>الإجمالي</th>
                    <th>حذف</th>
                  </tr>
                </thead>

                <tbody>
                  {cartItems.map((item) => {
                    const lineTotal =
                      item.quantity * item.unitCost -
                      item.discountAmount +
                      item.taxAmount

                    return (
                      <tr key={item.variantId}>
                        <td>
                          <strong>{item.productName}</strong>
                        </td>

                        <td>{item.sku}</td>
                        <td>{item.sizeName || '-'}</td>
                        <td>{item.colorName || '-'}</td>

                        <td>
                          <input
                            className="purchase-table-number-input"
                            type="number"
                            min="0.001"
                            step="0.001"
                            value={item.quantity}
                            disabled={savingReceipt}
                            onChange={(event) =>
                              updateCartItem(item.variantId, {
                                quantity: Number(event.target.value),
                              })
                            }
                          />
                        </td>

                        <td>
                          <input
                            className="purchase-table-number-input"
                            type="number"
                            min="0"
                            step="0.01"
                            value={item.unitCost}
                            disabled={savingReceipt}
                            onChange={(event) =>
                              updateCartItem(item.variantId, {
                                unitCost: Number(event.target.value),
                              })
                            }
                          />
                        </td>

                        <td>
                          <input
                            className="purchase-table-number-input"
                            type="number"
                            min="0"
                            step="0.01"
                            value={item.discountAmount}
                            disabled={savingReceipt}
                            onChange={(event) =>
                              updateCartItem(item.variantId, {
                                discountAmount: Number(event.target.value),
                              })
                            }
                          />
                        </td>

                        <td>
                          <input
                            className="purchase-table-number-input"
                            type="number"
                            min="0"
                            step="0.01"
                            value={item.taxAmount}
                            disabled={savingReceipt}
                            onChange={(event) =>
                              updateCartItem(item.variantId, {
                                taxAmount: Number(event.target.value),
                              })
                            }
                          />
                        </td>

                        <td>
                          <strong>{formatPurchaseCurrency(lineTotal)}</strong>
                        </td>

                        <td>
                          <button
                            type="button"
                            className="table-button danger-button"
                            disabled={savingReceipt}
                            onClick={() => removeCartItem(item.variantId)}
                          >
                            حذف
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          <section className="mini-cards-grid purchase-summary-grid">
            <article className="mini-card">
              <span>عدد الأصناف</span>
              <strong>{cartItems.length}</strong>
            </article>

            <article className="mini-card">
              <span>إجمالي الكمية</span>
              <strong>
                {formatPurchaseQuantity(purchaseTotals.quantityTotal)}
              </strong>
            </article>

            <article className="mini-card">
              <span>قبل الخصم</span>
              <strong>{formatPurchaseCurrency(purchaseTotals.subtotal)}</strong>
            </article>

            <article className="mini-card">
              <span>إجمالي الخصم</span>
              <strong>
                {formatPurchaseCurrency(purchaseTotals.discountTotal)}
              </strong>
            </article>

            <article className="mini-card">
              <span>إجمالي الضريبة</span>
              <strong>{formatPurchaseCurrency(purchaseTotals.taxTotal)}</strong>
            </article>

            <article className="mini-card purchase-total-card">
              <span>إجمالي الإذن</span>
              <strong>{formatPurchaseCurrency(purchaseTotals.total)}</strong>
            </article>
          </section>

          <div className="purchase-save-footer">
            <p className="muted">
              بعد الحفظ لا يمكن إعادة تسجيل نفس الإذن مرة أخرى.
            </p>

            <button
              type="button"
              className="primary-button"
              disabled={
                savingReceipt ||
                loadingLookup ||
                cartItems.length === 0 ||
                !selectedSupplierId ||
                !stockLocationId
              }
              onClick={() => void saveReceipt()}
            >
              {savingReceipt
                ? 'جاري الاستلام وإضافة المخزون...'
                : 'حفظ واستلام البضاعة'}
            </button>
          </div>
        </section>
      ) : null}

      <div className="purchase-supplier-search">
        <input
          value={receiptSearch}
          disabled={loadingReceipts}
          onChange={(event) => setReceiptSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void loadReceipts()
            }
          }}
          placeholder="رقم الإذن أو المورد أو المخزن"
        />

        <button
          type="button"
          className="table-button"
          disabled={loadingReceipts}
          onClick={() => void loadReceipts()}
        >
          {loadingReceipts ? 'جاري البحث...' : 'بحث'}
        </button>
      </div>

      {canViewPurchaseReceipts ? (
        <section className="panel">
          <div className="section-header">
            <div>
              <h2>سجل أذون الاستلام</h2>

              <p className="muted">
                جميع المشتريات المستلمة المرتبطة بالفرع الحالي.
              </p>
            </div>

            <span className="record-count-badge">{receipts.length} إذن</span>
          </div>

          {receipts.length === 0 ? (
            <p className="muted">
              {loadingReceipts
                ? 'جاري تحميل أذون الاستلام...'
                : 'لا توجد أذون استلام مسجلة.'}
            </p>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>رقم الإذن</th>
                    <th>المورد</th>
                    <th>المخزن</th>
                    <th>الأصناف</th>
                    <th>الكمية</th>
                    <th>الإجمالي</th>
                    <th>التاريخ</th>
                    <th>عرض</th>
                  </tr>
                </thead>

                <tbody>
                  {receipts.map((receipt) => (
                    <tr key={receipt.id}>
                      <td>
                        <strong>{receipt.receipt_number}</strong>
                      </td>

                      <td>{receipt.supplier_name}</td>

                      <td>{receipt.stock_location_name}</td>

                      <td>{receipt.items_count}</td>

                      <td>
                        {formatPurchaseQuantity(receipt.received_quantity)}
                      </td>

                      <td>
                        <strong>{formatPurchaseCurrency(receipt.total)}</strong>
                      </td>

                      <td>{formatPurchaseDate(receipt.received_at)}</td>

                      <td>
                        <button
                          type="button"
                          className="table-button"
                          disabled={loadingReceiptDetails}
                          onClick={() => void loadReceiptDetails(receipt.id)}
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
      ) : null}

      {canViewPurchaseReceipts && selectedReceipt ? (
        <section className="panel">
          <div className="section-header">
            <div>
              <h2>إذن الاستلام {selectedReceipt.receipt.receipt_number}</h2>

              <p className="muted">
                المورد: {selectedReceipt.receipt.supplier_name} — المخزن:{' '}
                {selectedReceipt.receipt.stock_location_name}
              </p>
            </div>

            <strong className="purchase-details-total">
              {formatPurchaseCurrency(selectedReceipt.receipt.total)}
            </strong>
          </div>

          <section className="mini-cards-grid purchase-details-grid">
            <article className="mini-card">
              <span>المورد</span>
              <strong>{selectedReceipt.receipt.supplier_name}</strong>
            </article>

            <article className="mini-card">
              <span>مكان التخزين</span>
              <strong>{selectedReceipt.receipt.stock_location_name}</strong>
            </article>

            <article className="mini-card">
              <span>عدد الأصناف</span>
              <strong>{selectedReceipt.items.length}</strong>
            </article>

            <article className="mini-card">
              <span>تاريخ الاستلام</span>
              <strong>
                {formatPurchaseDate(selectedReceipt.receipt.received_at)}
              </strong>
            </article>
          </section>

          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>الصنف</th>
                  <th>SKU</th>
                  <th>المقاس</th>
                  <th>اللون</th>
                  <th>الكمية</th>
                  <th>تكلفة الوحدة</th>
                  <th>متوسط التكلفة الحالي</th>
                  <th>الخصم</th>
                  <th>الضريبة</th>
                  <th>الإجمالي</th>
                </tr>
              </thead>

              <tbody>
                {selectedReceipt.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.product_name}</strong>
                    </td>

                    <td>{item.sku}</td>
                    <td>{item.size_name || '-'}</td>
                    <td>{item.color_name || '-'}</td>

                    <td>{formatPurchaseQuantity(item.quantity)}</td>

                    <td>{formatPurchaseCurrency(item.unit_cost)}</td>

                    <td>{formatPurchaseCurrency(item.current_average_cost)}</td>

                    <td>{formatPurchaseCurrency(item.discount_amount)}</td>

                    <td>{formatPurchaseCurrency(item.tax_amount)}</td>

                    <td>
                      <strong>{formatPurchaseCurrency(item.line_total)}</strong>
                    </td>
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

export default PurchasesPage
