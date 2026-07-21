import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { requestJson } from '../lib/http'

type TransferLocation = {
  id: string
  branch_id: string | null
  branch_name: string | null
  code: string
  name: string
  location_type: string
  can_send_from: boolean
}

type TransferLookupItem = {
  variant_id: string
  product_name: string
  sku: string
  primary_barcode: string | null
  size_name: string | null
  color_name: string | null
  available_quantity: string
  from_location_id: string
  from_location_name: string
}

type TransferCartItem = {
  variantId: string
  productName: string
  sku: string
  barcode: string | null
  sizeName: string | null
  colorName: string | null
  availableQuantity: number
  quantity: number
}

type TransferSummary = {
  id: string
  transfer_number: string
  from_branch_id: string | null
  from_branch_name: string | null
  to_branch_id: string | null
  to_branch_name: string | null
  from_location_id: string
  from_location_name: string
  from_location_code: string
  to_location_id: string
  to_location_name: string
  to_location_code: string
  status: string
  requested_at: string
  approved_at: string | null
  received_at: string | null
  note: string | null
  items_count: number
  requested_quantity: string
}

type TransferDetails = {
  transfer: TransferSummary & {
    requested_by_name: string | null
    approved_by_name: string | null
    received_by_name: string | null
  }

  items: Array<{
    id: string
    variant_id: string
    sku: string
    primary_barcode: string | null
    product_name: string
    size_name: string | null
    color_name: string | null
    requested_quantity: string
    approved_quantity: string | null
    received_quantity: string | null
  }>
}

type ApiResponse<T> = {
  data: T
}

type TransfersPageProps = {
  companyId: string
  branchId: string
}

function createTransferNumber() {
  return `TRF-WEB-${Date.now()}`
}

function createTransferIdempotencyKey() {
  return `web-transfer-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const quantityFormatter = new Intl.NumberFormat('ar-EG', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
})

const dateTimeFormatter = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatQuantity(value: number | string) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? quantityFormatter.format(numericValue)
    : '-'
}

function formatDateTime(value: string | null) {
  if (!value) {
    return '-'
  }

  const parsedDate = new Date(value)

  return Number.isNaN(parsedDate.getTime())
    ? '-'
    : dateTimeFormatter.format(parsedDate)
}

function translateTransferStatus(status: string) {
  const labels: Record<string, string> = {
    draft: 'مسودة',
    pending: 'بانتظار الشحن',
    approved: 'معتمد',
    in_transit: 'في الطريق',
    received: 'تم الاستلام',
    cancelled: 'ملغي',
  }

  return labels[status] || status
}

function getTransferStatusClass(status: string) {
  return `transfer-status transfer-status-${status.replace(/_/g, '-')}`
}

function TransfersPage({ companyId, branchId }: TransfersPageProps) {
  const { user } = useAuth()

  const [locations, setLocations] = useState<TransferLocation[]>([])

  const [transfers, setTransfers] = useState<TransferSummary[]>([])

  const [selectedTransfer, setSelectedTransfer] =
    useState<TransferDetails | null>(null)

  const [fromLocationId, setFromLocationId] = useState('')

  const [toLocationId, setToLocationId] = useState('')

  const [code, setCode] = useState('')
  const [quantity, setQuantity] = useState(1)

  const [cartItems, setCartItems] = useState<TransferCartItem[]>([])

  const [transferNumber, setTransferNumber] = useState(createTransferNumber)

  const [transferIdempotencyKey, setTransferIdempotencyKey] = useState(
    createTransferIdempotencyKey,
  )

  const [transferNote, setTransferNote] = useState('')

  const [statusFilter, setStatusFilter] = useState('')

  const [loadingLocations, setLoadingLocations] = useState(false)

  const [loadingTransfers, setLoadingTransfers] = useState(false)

  const [loadingDetails, setLoadingDetails] = useState(false)

  const [loadingLookup, setLoadingLookup] = useState(false)

  const [savingTransfer, setSavingTransfer] = useState(false)

  const [runningAction, setRunningAction] = useState(false)

  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const lookupRequestRef = useRef(false)
  const saveRequestRef = useRef(false)
  const actionRequestRef = useRef(false)
  const codeInputRef = useRef<HTMLInputElement>(null)

  const isAdmin = user?.roles.includes('admin') ?? false

  const hasPermission = (permission: string) =>
    isAdmin || user?.permissions.includes(permission) || false

  const canAccessTransfers =
    hasPermission('inventory.transfer.view') ||
    hasPermission('inventory.transfer.create') ||
    hasPermission('inventory.transfer.approve') ||
    hasPermission('inventory.transfer.receive')

  const canCreateTransfer = hasPermission('inventory.transfer.create')

  const canShipTransfer = hasPermission('inventory.transfer.approve')

  const canReceiveTransfer = hasPermission('inventory.transfer.receive')

  const sourceLocations = useMemo(
    () => locations.filter((location) => location.can_send_from),
    [locations],
  )

  const destinationLocations = useMemo(
    () => locations.filter((location) => location.id !== fromLocationId),
    [locations, fromLocationId],
  )

  const cartQuantityTotal = useMemo(
    () => cartItems.reduce((total, item) => total + item.quantity, 0),
    [cartItems],
  )

  function resetTransferDraft(keepSuccess = false) {
    setCartItems([])
    setCode('')
    setQuantity(1)
    setTransferNote('')
    setTransferNumber(createTransferNumber())
    setTransferIdempotencyKey(createTransferIdempotencyKey())
    setError('')

    if (!keepSuccess) {
      setSuccess('')
    }

    window.setTimeout(() => {
      codeInputRef.current?.focus()
    }, 0)
  }

  async function loadLocations() {
    setLoadingLocations(true)
    setError('')

    try {
      const url =
        `/api/transfers/locations` +
        `?companyId=${encodeURIComponent(companyId.trim())}` +
        (branchId.trim()
          ? `&branchId=${encodeURIComponent(branchId.trim())}`
          : '')

      const response = await requestJson<ApiResponse<TransferLocation[]>>(url)

      setLocations(response.data)

      const currentSourceIsValid = response.data.some(
        (location) => location.id === fromLocationId && location.can_send_from,
      )

      const nextSourceId = currentSourceIsValid
        ? fromLocationId
        : (response.data.find((location) => location.can_send_from)?.id ?? '')

      setFromLocationId(nextSourceId)

      setToLocationId((currentDestination) => {
        const destinationStillValid = response.data.some(
          (location) =>
            location.id === currentDestination && location.id !== nextSourceId,
        )

        if (destinationStillValid) {
          return currentDestination
        }

        return (
          response.data.find((location) => location.id !== nextSourceId)?.id ??
          ''
        )
      })
    } catch (currentError) {
      setLocations([])
      setFromLocationId('')
      setToLocationId('')

      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل أماكن التخزين.',
      )
    } finally {
      setLoadingLocations(false)
    }
  }

  async function loadTransfers() {
    setLoadingTransfers(true)
    setError('')

    try {
      const url =
        `/api/transfers` +
        `?companyId=${encodeURIComponent(companyId.trim())}` +
        (branchId.trim()
          ? `&branchId=${encodeURIComponent(branchId.trim())}`
          : '') +
        (statusFilter ? `&status=${encodeURIComponent(statusFilter)}` : '') +
        '&limit=100'

      const response = await requestJson<ApiResponse<TransferSummary[]>>(url)

      setTransfers(response.data)
    } catch (currentError) {
      setTransfers([])

      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل التحويلات.',
      )
    } finally {
      setLoadingTransfers(false)
    }
  }

  async function loadTransferDetails(transferId: string) {
    setLoadingDetails(true)
    setError('')

    try {
      const url =
        `/api/transfers/${encodeURIComponent(transferId)}` +
        `?companyId=${encodeURIComponent(companyId.trim())}` +
        (branchId.trim()
          ? `&branchId=${encodeURIComponent(branchId.trim())}`
          : '')

      const response = await requestJson<ApiResponse<TransferDetails>>(url)

      setSelectedTransfer(response.data)
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل تفاصيل التحويل.',
      )
    } finally {
      setLoadingDetails(false)
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
      if (!fromLocationId) {
        throw new Error('اختر مكان المصدر أولًا.')
      }

      if (!code.trim()) {
        throw new Error('اكتب باركود أو SKU الصنف.')
      }

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new Error('الكمية يجب أن تكون أكبر من صفر.')
      }

      const url =
        `/api/transfers/lookup-item` +
        `?companyId=${encodeURIComponent(companyId.trim())}` +
        `&fromLocationId=${encodeURIComponent(fromLocationId)}` +
        `&code=${encodeURIComponent(code.trim())}`

      const response = await requestJson<ApiResponse<TransferLookupItem>>(url)

      const lookupItem = response.data
      const availableQuantity = Number(lookupItem.available_quantity)

      if (!Number.isFinite(availableQuantity) || availableQuantity <= 0) {
        throw new Error('لا يوجد رصيد متاح لهذا الصنف في المصدر.')
      }

      const existingItem = cartItems.find(
        (item) => item.variantId === lookupItem.variant_id,
      )

      const requestedTotal = (existingItem?.quantity ?? 0) + quantity

      if (requestedTotal > availableQuantity) {
        throw new Error(
          `الكمية غير كافية. المتاح: ${formatQuantity(availableQuantity)}`,
        )
      }

      if (existingItem) {
        setCartItems((currentItems) =>
          currentItems.map((item) =>
            item.variantId === lookupItem.variant_id
              ? {
                  ...item,
                  quantity: requestedTotal,
                  availableQuantity,
                }
              : item,
          ),
        )
      } else {
        setCartItems((currentItems) => [
          ...currentItems,
          {
            variantId: lookupItem.variant_id,
            productName: lookupItem.product_name,
            sku: lookupItem.sku,
            barcode: lookupItem.primary_barcode,
            sizeName: lookupItem.size_name,
            colorName: lookupItem.color_name,
            availableQuantity,
            quantity,
          },
        ])
      }

      setCode('')
      setQuantity(1)

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

  function updateCartQuantity(variantId: string, nextQuantity: number) {
    const selectedItem = cartItems.find((item) => item.variantId === variantId)

    if (!selectedItem) {
      return
    }

    if (!Number.isFinite(nextQuantity) || nextQuantity <= 0) {
      setError('الكمية يجب أن تكون أكبر من صفر.')
      return
    }

    if (nextQuantity > selectedItem.availableQuantity) {
      setError(
        `الكمية المتاحة: ${formatQuantity(selectedItem.availableQuantity)}`,
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

  function removeCartItem(variantId: string) {
    setCartItems((currentItems) =>
      currentItems.filter((item) => item.variantId !== variantId),
    )
  }

  async function createTransfer() {
    if (saveRequestRef.current) {
      return
    }

    saveRequestRef.current = true
    setSavingTransfer(true)
    setError('')
    setSuccess('')

    try {
      if (!fromLocationId) {
        throw new Error('اختر مكان المصدر.')
      }

      if (!toLocationId) {
        throw new Error('اختر مكان الوجهة.')
      }

      if (fromLocationId === toLocationId) {
        throw new Error('المصدر والوجهة يجب أن يكونا مختلفين.')
      }

      if (cartItems.length === 0) {
        throw new Error('أضف صنفًا واحدًا على الأقل.')
      }

      const response = await requestJson<ApiResponse<TransferDetails>>(
        '/api/transfers',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            companyId: companyId.trim(),
            branchId: branchId.trim() || null,
            transferNumber,
            idempotencyKey: transferIdempotencyKey,
            fromLocationId,
            toLocationId,
            note: transferNote.trim() || null,
            items: cartItems.map((item) => ({
              variantId: item.variantId,
              quantity: item.quantity,
              note: null,
            })),
          }),
        },
      )

      setSelectedTransfer(response.data)

      setSuccess(
        `تم إنشاء التحويل ${response.data.transfer.transfer_number} بنجاح وهو بانتظار الشحن.`,
      )

      resetTransferDraft(true)
      await loadTransfers()
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر إنشاء التحويل.',
      )
    } finally {
      saveRequestRef.current = false
      setSavingTransfer(false)
    }
  }

  async function runTransferAction(action: 'ship' | 'receive') {
    if (actionRequestRef.current || !selectedTransfer) {
      return
    }

    actionRequestRef.current = true
    setRunningAction(true)
    setError('')
    setSuccess('')

    try {
      const response = await requestJson<ApiResponse<TransferDetails>>(
        `/api/transfers/${encodeURIComponent(
          selectedTransfer.transfer.id,
        )}/${action}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        },
      )

      setSelectedTransfer(response.data)

      setSuccess(
        action === 'ship'
          ? 'تم شحن التحويل وخصم الكميات من المصدر.'
          : 'تم استلام التحويل وإضافة الكميات إلى الوجهة.',
      )

      await loadTransfers()
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تنفيذ عملية التحويل.',
      )
    } finally {
      actionRequestRef.current = false
      setRunningAction(false)
    }
  }

  useEffect(() => {
    // موظف العرض أو الشحن أو الاستلام لا يحتاج
    // تحميل قائمة إنشاء التحويل.
    setLocations([])
    setFromLocationId('')
    setToLocationId('')

    if (!canCreateTransfer || !companyId.trim()) {
      return
    }

    void loadLocations()
  }, [canCreateTransfer, companyId, branchId])

  useEffect(() => {
    if (!canAccessTransfers || !companyId.trim()) {
      return
    }

    void loadTransfers()
  }, [canAccessTransfers, companyId, branchId, statusFilter])

  useEffect(() => {
    setCartItems([])
    setCode('')
    setError('')

    if (toLocationId === fromLocationId) {
      setToLocationId(destinationLocations[0]?.id ?? '')
    }
  }, [fromLocationId])

  const selectedSummary = selectedTransfer?.transfer

  const userCanShipSelected =
    Boolean(selectedSummary) &&
    canShipTransfer &&
    (selectedSummary?.status === 'pending' ||
      selectedSummary?.status === 'approved') &&
    (!branchId.trim() || selectedSummary?.from_branch_id === branchId.trim())

  const userCanReceiveSelected =
    Boolean(selectedSummary) &&
    canReceiveTransfer &&
    selectedSummary?.status === 'in_transit' &&
    (!branchId.trim() || selectedSummary?.to_branch_id === branchId.trim())

  return (
    <>
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>تحويلات المخزون</h2>
            <p className="muted">
              إنشاء التحويلات وشحنها واستلامها بين أماكن التخزين.
            </p>
          </div>

          <button
            type="button"
            className="primary-button small-button"
            disabled={loadingTransfers}
            onClick={() => void loadTransfers()}
          >
            {loadingTransfers ? 'جاري التحديث...' : 'تحديث التحويلات'}
          </button>
        </div>

        {error ? <p className="error-message">{error}</p> : null}

        {success ? <p className="success-message">{success}</p> : null}
      </section>

      {canCreateTransfer ? (
        <section className="panel">
          <div className="section-header">
            <div>
              <h2>إنشاء تحويل جديد</h2>
              <p className="muted">لا يتم خصم المخزون إلا عند شحن التحويل.</p>
            </div>

            <button
              type="button"
              className="table-button"
              disabled={savingTransfer}
              onClick={() => resetTransferDraft()}
            >
              مسح المسودة
            </button>
          </div>

          <div className="form-grid transfer-header-grid">
            <label>
              رقم التحويل
              <input value={transferNumber} readOnly aria-readonly="true" />
            </label>

            <label>
              مكان المصدر
              <select
                value={fromLocationId}
                disabled={loadingLocations || savingTransfer}
                onChange={(event) => setFromLocationId(event.target.value)}
              >
                <option value="">اختر المصدر</option>

                {sourceLocations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name} ({location.code})
                  </option>
                ))}
              </select>
            </label>

            <label>
              مكان الوجهة
              <select
                value={toLocationId}
                disabled={loadingLocations || savingTransfer}
                onChange={(event) => setToLocationId(event.target.value)}
              >
                <option value="">اختر الوجهة</option>

                {destinationLocations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name} ({location.code})
                  </option>
                ))}
              </select>
            </label>

            <label>
              ملاحظة التحويل
              <input
                value={transferNote}
                disabled={savingTransfer}
                onChange={(event) => setTransferNote(event.target.value)}
                placeholder="اختياري"
              />
            </label>
          </div>

          <div className="transfer-item-entry">
            <label>
              باركود أو SKU
              <input
                ref={codeInputRef}
                value={code}
                disabled={!fromLocationId || loadingLookup || savingTransfer}
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
                disabled={savingTransfer}
                onChange={(event) => setQuantity(Number(event.target.value))}
              />
            </label>

            <button
              type="button"
              className="table-button"
              disabled={
                !fromLocationId ||
                !code.trim() ||
                loadingLookup ||
                savingTransfer
              }
              onClick={() => void lookupAndAddItem()}
            >
              {loadingLookup ? 'جاري البحث...' : 'إضافة الصنف'}
            </button>
          </div>

          {cartItems.length === 0 ? (
            <p className="muted">لم تتم إضافة أصناف للتحويل.</p>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>الصنف</th>
                    <th>SKU</th>
                    <th>المقاس</th>
                    <th>اللون</th>
                    <th>المتاح</th>
                    <th>كمية التحويل</th>
                    <th>حذف</th>
                  </tr>
                </thead>

                <tbody>
                  {cartItems.map((item) => (
                    <tr key={item.variantId}>
                      <td>
                        <strong>{item.productName}</strong>
                      </td>

                      <td>{item.sku}</td>
                      <td>{item.sizeName || '-'}</td>
                      <td>{item.colorName || '-'}</td>

                      <td>{formatQuantity(item.availableQuantity)}</td>

                      <td>
                        <input
                          className="transfer-quantity-input"
                          type="number"
                          min="0.001"
                          step="0.001"
                          max={item.availableQuantity}
                          value={item.quantity}
                          disabled={savingTransfer}
                          onChange={(event) =>
                            updateCartQuantity(
                              item.variantId,
                              Number(event.target.value),
                            )
                          }
                        />
                      </td>

                      <td>
                        <button
                          type="button"
                          className="table-button danger-button"
                          disabled={savingTransfer}
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

          <div className="transfer-create-footer">
            <div>
              <span>إجمالي الأصناف</span>
              <strong>{cartItems.length}</strong>
            </div>

            <div>
              <span>إجمالي الكمية</span>
              <strong>{formatQuantity(cartQuantityTotal)}</strong>
            </div>

            <button
              type="button"
              className="primary-button"
              disabled={
                cartItems.length === 0 ||
                !fromLocationId ||
                !toLocationId ||
                savingTransfer ||
                loadingLookup
              }
              onClick={() => void createTransfer()}
            >
              {savingTransfer ? 'جاري إنشاء التحويل...' : 'إنشاء طلب التحويل'}
            </button>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="section-header">
          <div>
            <h2>سجل التحويلات</h2>
            <p className="muted">التحويلات المرتبطة بفرع المستخدم.</p>
          </div>

          <label className="transfer-status-filter">
            الحالة
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">كل الحالات</option>
              <option value="pending">بانتظار الشحن</option>
              <option value="in_transit">في الطريق</option>
              <option value="received">تم الاستلام</option>
              <option value="cancelled">ملغي</option>
            </select>
          </label>
        </div>

        {transfers.length === 0 ? (
          <p className="muted">
            {loadingTransfers
              ? 'جاري تحميل التحويلات...'
              : 'لا توجد تحويلات مسجلة.'}
          </p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>رقم التحويل</th>
                  <th>المصدر</th>
                  <th>الوجهة</th>
                  <th>الأصناف</th>
                  <th>الكمية</th>
                  <th>الحالة</th>
                  <th>التاريخ</th>
                  <th>عرض</th>
                </tr>
              </thead>

              <tbody>
                {transfers.map((transfer) => (
                  <tr key={transfer.id}>
                    <td>
                      <strong>{transfer.transfer_number}</strong>
                    </td>

                    <td>{transfer.from_location_name}</td>

                    <td>{transfer.to_location_name}</td>

                    <td>{transfer.items_count}</td>

                    <td>{formatQuantity(transfer.requested_quantity)}</td>

                    <td>
                      <span className={getTransferStatusClass(transfer.status)}>
                        {translateTransferStatus(transfer.status)}
                      </span>
                    </td>

                    <td>{formatDateTime(transfer.requested_at)}</td>

                    <td>
                      <button
                        type="button"
                        className="table-button"
                        disabled={loadingDetails}
                        onClick={() => void loadTransferDetails(transfer.id)}
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

      {selectedTransfer ? (
        <section className="panel">
          <div className="section-header">
            <div>
              <h2>التحويل {selectedTransfer.transfer.transfer_number}</h2>

              <p className="muted">
                {selectedTransfer.transfer.from_location_name} ←{' '}
                {selectedTransfer.transfer.to_location_name}
              </p>
            </div>

            <div className="section-actions">
              <span
                className={getTransferStatusClass(
                  selectedTransfer.transfer.status,
                )}
              >
                {translateTransferStatus(selectedTransfer.transfer.status)}
              </span>

              {userCanShipSelected ? (
                <button
                  type="button"
                  className="primary-button small-button"
                  disabled={runningAction}
                  onClick={() => void runTransferAction('ship')}
                >
                  {runningAction ? 'جاري الشحن...' : 'شحن التحويل'}
                </button>
              ) : null}

              {userCanReceiveSelected ? (
                <button
                  type="button"
                  className="primary-button small-button"
                  disabled={runningAction}
                  onClick={() => void runTransferAction('receive')}
                >
                  {runningAction ? 'جاري الاستلام...' : 'استلام التحويل'}
                </button>
              ) : null}
            </div>
          </div>

          <section className="mini-cards-grid transfer-summary-grid">
            <article className="mini-card">
              <span>المصدر</span>
              <strong>{selectedTransfer.transfer.from_location_name}</strong>
            </article>

            <article className="mini-card">
              <span>الوجهة</span>
              <strong>{selectedTransfer.transfer.to_location_name}</strong>
            </article>

            <article className="mini-card">
              <span>عدد الأصناف</span>
              <strong>{selectedTransfer.items.length}</strong>
            </article>

            <article className="mini-card">
              <span>تاريخ الطلب</span>
              <strong>
                {formatDateTime(selectedTransfer.transfer.requested_at)}
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
                  <th>المطلوب</th>
                  <th>المشحون</th>
                  <th>المستلم</th>
                </tr>
              </thead>

              <tbody>
                {selectedTransfer.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.product_name}</td>
                    <td>{item.sku}</td>
                    <td>{item.size_name || '-'}</td>
                    <td>{item.color_name || '-'}</td>
                    <td>{formatQuantity(item.requested_quantity)}</td>
                    <td>
                      {item.approved_quantity
                        ? formatQuantity(item.approved_quantity)
                        : '-'}
                    </td>
                    <td>
                      {item.received_quantity
                        ? formatQuantity(item.received_quantity)
                        : '-'}
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

export default TransfersPage
