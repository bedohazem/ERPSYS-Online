import { useEffect, useRef, useState } from 'react'

import { requestJson } from '../lib/http'

type StockLocationOption = {
  id: string
  code: string
  name: string
}

type LookupItem = {
  variant_id: string
  product_name: string
  sku: string
  primary_barcode: string | null
  size_name: string | null
  color_name: string | null
  current_quantity: string
  stock_location_id: string
  stock_location_name: string
}

type AdjustmentResponse = {
  adjustment: {
    counted_quantity: string
    adjustment_quantity: string
  }
  item: {
    product_name: string
    sku: string
  }
}

type ApiResponse<T> = {
  data: T
  meta?: {
    duplicate: boolean
  }
}

type InventoryAdjustmentPanelProps = {
  companyId: string
  stockLocations: StockLocationOption[]
  loadingLocations: boolean
  onSaved: () => Promise<void> | void
}

function InventoryAdjustmentPanel({
  companyId,
  stockLocations,
  loadingLocations,
  onSaved,
}: InventoryAdjustmentPanelProps) {
  const [stockLocationId, setStockLocationId] = useState('')
  const [code, setCode] = useState('')
  const [item, setItem] = useState<LookupItem | null>(null)

  // نحفظ الكمية كنص حتى يظل الحقل الفارغ فارغًا.
  const [countedQuantity, setCountedQuantity] = useState('')
  const [reason, setReason] = useState('')

  const [loadingLookup, setLoadingLookup] = useState(false)
  const [saving, setSaving] = useState(false)

  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const lookupRunningRef = useRef(false)
  const saveRunningRef = useRef(false)

  // نحتفظ بنفس المفتاح لو انقطع الاتصال أثناء الحفظ.
  // بذلك لا تتكرر التسوية عند إعادة المحاولة.
  const idempotencyKeyRef = useRef<string | null>(null)

  useEffect(() => {
    setStockLocationId((currentId) => {
      const locationStillExists = stockLocations.some(
        (location) => location.id === currentId,
      )

      return locationStillExists ? currentId : (stockLocations[0]?.id ?? '')
    })
  }, [stockLocations])

  function resetPendingRequest() {
    idempotencyKeyRef.current = null
    setSuccess('')
  }

  function changeLocation(nextLocationId: string) {
    setStockLocationId(nextLocationId)
    setCode('')
    setItem(null)
    setCountedQuantity('')
    resetPendingRequest()
  }

  async function lookupItem() {
    if (lookupRunningRef.current) {
      return
    }

    lookupRunningRef.current = true
    setLoadingLookup(true)
    setError('')
    setSuccess('')
    setItem(null)

    try {
      if (!stockLocationId) {
        throw new Error('اختر مكان التخزين أولًا.')
      }

      if (!code.trim()) {
        throw new Error('اكتب الباركود أو SKU.')
      }

      const lookupUrl =
        `/api/inventory/lookup-item` +
        `?companyId=${encodeURIComponent(companyId.trim())}` +
        `&stockLocationId=${encodeURIComponent(stockLocationId)}` +
        `&code=${encodeURIComponent(code.trim())}`

      const response = await requestJson<ApiResponse<LookupItem>>(lookupUrl)

      setItem(response.data)
      setCountedQuantity(response.data.current_quantity)
      idempotencyKeyRef.current = null
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر العثور على الصنف.',
      )
    } finally {
      lookupRunningRef.current = false
      setLoadingLookup(false)
    }
  }

  async function saveAdjustment() {
    if (saveRunningRef.current) {
      return
    }

    saveRunningRef.current = true
    setSaving(true)
    setError('')
    setSuccess('')

    try {
      if (!item) {
        throw new Error('ابحث عن الصنف أولًا.')
      }

      if (!countedQuantity.trim()) {
        throw new Error('اكتب الكمية الفعلية.')
      }

      const numericQuantity = Number(countedQuantity)

      if (!Number.isFinite(numericQuantity) || numericQuantity < 0) {
        throw new Error('الكمية الفعلية غير صالحة.')
      }

      const currentQuantity = Number(item.current_quantity)

      if (numericQuantity === currentQuantity) {
        throw new Error('الكمية الفعلية مساوية للرصيد الحالي.')
      }

      const normalizedReason = reason.trim()

      if (normalizedReason.length < 3 || normalizedReason.length > 500) {
        throw new Error('سبب التسوية يجب أن يكون بين 3 و500 حرف.')
      }

      // لا ننشئ مفتاحًا جديدًا عند Retry لنفس العملية.
      const idempotencyKey = idempotencyKeyRef.current ?? crypto.randomUUID()

      idempotencyKeyRef.current = idempotencyKey

      const response = await requestJson<ApiResponse<AdjustmentResponse>>(
        '/api/inventory/adjustments',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            stockLocationId,
            variantId: item.variant_id,
            countedQuantity: numericQuantity,
            reason: normalizedReason,
            idempotencyKey,
          }),
        },
      )

      const difference = Number(response.data.adjustment.adjustment_quantity)

      setSuccess(
        response.meta?.duplicate
          ? 'تم تأكيد التسوية السابقة بدون تكرار حركة المخزون.'
          : `تمت تسوية ${response.data.item.product_name} بفارق ${
              difference > 0 ? '+' : ''
            }${difference}.`,
      )

      setCode('')
      setItem(null)
      setCountedQuantity('')
      setReason('')
      idempotencyKeyRef.current = null

      await onSaved()
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر حفظ تسوية المخزون.',
      )
    } finally {
      saveRunningRef.current = false
      setSaving(false)
    }
  }

  const currentQuantity = Number(item?.current_quantity ?? 0)
  const enteredQuantity = Number(countedQuantity)

  const difference =
    item && countedQuantity.trim() && Number.isFinite(enteredQuantity)
      ? enteredQuantity - currentQuantity
      : null

  return (
    <section className="panel">
      <div className="section-header">
        <div>
          <h2>تسوية رصيد المخزون</h2>
          <p className="muted">
            استخدمها عند وجود فرق بين الرصيد المسجل والكمية الفعلية.
          </p>
        </div>
      </div>

      {error ? <p className="error-message">{error}</p> : null}
      {success ? <p className="success-message">{success}</p> : null}

      <div className="form-grid opening-balance-grid">
        <label>
          مكان التخزين
          <select
            value={stockLocationId}
            disabled={loadingLocations || saving}
            onChange={(event) => changeLocation(event.target.value)}
          >
            <option value="">
              {loadingLocations ? 'جاري تحميل الأماكن...' : 'اختر مكان التخزين'}
            </option>

            {stockLocations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name} ({location.code})
              </option>
            ))}
          </select>
        </label>

        <label>
          باركود أو SKU
          <input
            value={code}
            disabled={loadingLookup || saving}
            placeholder="امسح الباركود أو اكتب SKU"
            onChange={(event) => {
              setCode(event.target.value)
              setItem(null)
              resetPendingRequest()
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void lookupItem()
              }
            }}
          />
        </label>

        <label>
          الكمية الفعلية
          <input
            type="number"
            min="0"
            step="0.001"
            value={countedQuantity}
            disabled={!item || saving}
            onChange={(event) => {
              setCountedQuantity(event.target.value)
              resetPendingRequest()
            }}
          />
        </label>

        <label>
          سبب التسوية
          <input
            value={reason}
            maxLength={500}
            disabled={!item || saving}
            placeholder="مثال: فرق ظهر أثناء الجرد اليدوي"
            onChange={(event) => {
              setReason(event.target.value)
              resetPendingRequest()
            }}
          />
        </label>
      </div>

      <div className="inventory-opening-actions">
        <button
          type="button"
          className="table-button"
          disabled={!stockLocationId || !code.trim() || loadingLookup || saving}
          onClick={() => void lookupItem()}
        >
          {loadingLookup ? 'جاري البحث...' : 'بحث عن الصنف'}
        </button>

        <button
          type="button"
          className="primary-button small-button"
          disabled={
            !item ||
            !countedQuantity.trim() ||
            reason.trim().length < 3 ||
            saving
          }
          onClick={() => void saveAdjustment()}
        >
          {saving ? 'جاري الحفظ...' : 'حفظ التسوية'}
        </button>
      </div>

      {item ? (
        <article className="inventory-selected-item">
          <div>
            <span>الصنف</span>
            <strong>{item.product_name}</strong>
          </div>

          <div>
            <span>SKU</span>
            <strong>{item.sku}</strong>
          </div>

          <div>
            <span>الرصيد الحالي</span>
            <strong>{item.current_quantity}</strong>
          </div>

          <div>
            <span>فرق التسوية</span>
            <strong>
              {difference === null
                ? '-'
                : `${difference > 0 ? '+' : ''}${difference}`}
            </strong>
          </div>
        </article>
      ) : null}
    </section>
  )
}

export default InventoryAdjustmentPanel
