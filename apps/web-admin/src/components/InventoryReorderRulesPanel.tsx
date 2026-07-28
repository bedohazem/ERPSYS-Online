import { useEffect, useMemo, useRef, useState } from 'react'

import { useAuth } from '../auth/AuthContext'
import { requestJson } from '../lib/http'

type ApiResponse<T> = {
  data: T
}

type RuleStatus = 'critical' | 'low' | 'healthy' | 'inactive'

type StockLocationOption = {
  id: string
  branchId: string | null
  branchCode: string | null
  branchName: string | null
  code: string
  name: string
  locationType: string
}

type InventoryLookupItem = {
  variant_id: string
  product_id: string
  product_name: string
  sku: string
  primary_barcode: string | null
  size_name: string | null
  color_name: string | null
  current_quantity: string
  stock_location_id: string
  stock_location_name: string
  stock_location_code: string
}

type SelectedRuleItem = {
  variantId: string
  productId: string
  productName: string
  sku: string
  primaryBarcode: string | null
  sizeName: string | null
  colorName: string | null
  currentQuantity: string
}

type InventoryReorderRule = {
  id: string
  companyId: string

  branchId: string | null
  branchCode: string | null
  branchName: string | null

  stockLocationId: string
  stockLocationCode: string
  stockLocationName: string
  stockLocationType: string
  stockLocationIsActive: boolean

  variantId: string
  productId: string
  productName: string
  sku: string
  primaryBarcode: string | null

  sizeName: string | null
  colorName: string | null
  categoryName: string | null
  brandName: string | null

  productStatus: string
  variantStatus: string

  reorderPoint: string
  safetyStock: string
  reorderQuantity: string

  currentQuantity: string
  shortageQuantity: string
  suggestedOrderQuantity: string

  stockStatus: RuleStatus
  isActive: boolean

  createdBy: string | null
  updatedBy: string | null
  createdAt: string
  updatedAt: string
}

type ReorderRulesResponse = {
  data: InventoryReorderRule[]
  meta: {
    limit: number
    branchSelectionLocked: boolean
  }
}

type SavedRuleResponse = ApiResponse<{
  rule: {
    id: string
    companyId: string
    stockLocationId: string
    variantId: string
    reorderPoint: string
    safetyStock: string
    reorderQuantity: string
    isActive: boolean
    createdBy: string | null
    updatedBy: string | null
    createdAt: string
    updatedAt: string
  }

  item: {
    branchId: string | null
    stockLocationId: string
    stockLocationCode: string
    stockLocationName: string
    stockLocationType: string
    variantId: string
    productId: string
    productName: string
    sku: string
    primaryBarcode: string | null
    sizeName: string | null
    colorName: string | null
  }
}>

type InventoryReorderRulesPanelProps = {
  branchId: string
  preferredStockLocationId: string
  stockLocations: StockLocationOption[]
  onSaved: () => Promise<void> | void
}

const ruleQuantityFormatter = new Intl.NumberFormat('ar-EG', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
})

const ruleTimestampFormatter = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatRuleQuantity(value: string | number) {
  const numericValue = Number(value)

  return Number.isFinite(numericValue)
    ? ruleQuantityFormatter.format(numericValue)
    : '-'
}

function formatRuleTimestamp(value: string) {
  const date = new Date(value)

  return Number.isNaN(date.getTime())
    ? '-'
    : ruleTimestampFormatter.format(date)
}

function createItemDescription(item: {
  sizeName: string | null
  colorName: string | null
  sku: string
  primaryBarcode: string | null
}) {
  return [
    item.sizeName ? `المقاس: ${item.sizeName}` : null,
    item.colorName ? `اللون: ${item.colorName}` : null,
    `SKU: ${item.sku}`,
    item.primaryBarcode ? `باركود: ${item.primaryBarcode}` : null,
  ]
    .filter(Boolean)
    .join(' • ')
}

function getRuleStatusLabel(status: RuleStatus) {
  const labels: Record<RuleStatus, string> = {
    critical: 'حرج',
    low: 'منخفض',
    healthy: 'سليم',
    inactive: 'غير مفعّل',
  }

  return labels[status]
}

function getRuleStatusClassName(status: RuleStatus) {
  return ['shortage-status-badge', `shortage-status-${status}`].join(' ')
}

function InventoryReorderRulesPanel({
  branchId,
  preferredStockLocationId,
  stockLocations,
  onSaved,
}: InventoryReorderRulesPanelProps) {
  const { user } = useAuth()

  const isAdmin = user?.roles.includes('admin') ?? false

  const canAdjustInventory =
    isAdmin || user?.permissions.includes('inventory.adjust') || false

  const [rules, setRules] = useState<InventoryReorderRule[]>([])

  const [selectedRuleId, setSelectedRuleId] = useState('')
  const [ruleSearch, setRuleSearch] = useState('')

  const [selectedLocationId, setSelectedLocationId] = useState(
    preferredStockLocationId,
  )

  const [itemCode, setItemCode] = useState('')
  const [selectedItem, setSelectedItem] = useState<SelectedRuleItem | null>(
    null,
  )

  const [reorderPoint, setReorderPoint] = useState('1')
  const [safetyStock, setSafetyStock] = useState('0')
  const [reorderQuantity, setReorderQuantity] = useState('0')
  const [ruleIsActive, setRuleIsActive] = useState(true)

  const [loadingRules, setLoadingRules] = useState(false)
  const [lookingUpItem, setLookingUpItem] = useState(false)
  const [savingRule, setSavingRule] = useState(false)

  const [ruleError, setRuleError] = useState('')
  const [ruleSuccess, setRuleSuccess] = useState('')

  const rulesRequestIdRef = useRef(0)
  const lookupRequestIdRef = useRef(0)
  const saveLockRef = useRef(false)

  const accessibleRules = useMemo(
    () => rules.filter((rule) => !branchId || rule.branchId === branchId),
    [rules, branchId],
  )

  const filteredRules = useMemo(() => {
    const normalizedSearch = ruleSearch.trim().toLowerCase()

    if (!normalizedSearch) {
      return accessibleRules
    }

    return accessibleRules.filter((rule) => {
      if (rule.id === selectedRuleId) {
        return true
      }

      return [
        rule.productName,
        rule.sku,
        rule.primaryBarcode,
        rule.stockLocationName,
        rule.stockLocationCode,
        rule.branchName,
        rule.categoryName,
        rule.brandName,
      ].some((value) =>
        String(value || '')
          .toLowerCase()
          .includes(normalizedSearch),
      )
    })
  }, [accessibleRules, ruleSearch, selectedRuleId])

  const activeRulesCount = useMemo(
    () => accessibleRules.filter((rule) => rule.isActive).length,
    [accessibleRules],
  )

  function selectRule(rule: InventoryReorderRule) {
    lookupRequestIdRef.current += 1

    setSelectedRuleId(rule.id)
    setSelectedLocationId(rule.stockLocationId)

    setItemCode(rule.primaryBarcode || rule.sku)

    setSelectedItem({
      variantId: rule.variantId,
      productId: rule.productId,
      productName: rule.productName,
      sku: rule.sku,
      primaryBarcode: rule.primaryBarcode,
      sizeName: rule.sizeName,
      colorName: rule.colorName,
      currentQuantity: rule.currentQuantity,
    })

    setReorderPoint(rule.reorderPoint)
    setSafetyStock(rule.safetyStock)
    setReorderQuantity(rule.reorderQuantity)
    setRuleIsActive(rule.isActive)

    setRuleError('')
    setRuleSuccess('')
  }

  function resetForm() {
    lookupRequestIdRef.current += 1

    const preferredLocationExists = stockLocations.some(
      (location) => location.id === preferredStockLocationId,
    )

    setSelectedRuleId('')

    setSelectedLocationId(
      preferredLocationExists ? preferredStockLocationId : '',
    )

    setItemCode('')
    setSelectedItem(null)

    setReorderPoint('1')
    setSafetyStock('0')
    setReorderQuantity('0')
    setRuleIsActive(true)

    setRuleError('')
    setRuleSuccess('')
  }

  function handleLocationChange(locationId: string) {
    lookupRequestIdRef.current += 1

    setSelectedLocationId(locationId)
    setSelectedRuleId('')
    setSelectedItem(null)
    setItemCode('')

    setReorderPoint('1')
    setSafetyStock('0')
    setReorderQuantity('0')
    setRuleIsActive(true)

    setRuleError('')
    setRuleSuccess('')
  }

  async function loadRules() {
    const requestId = rulesRequestIdRef.current + 1

    rulesRequestIdRef.current = requestId

    setLoadingRules(true)
    setRuleError('')

    try {
      const response = await requestJson<ReorderRulesResponse>(
        '/api/inventory/reorder-rules?limit=500',
      )

      if (requestId !== rulesRequestIdRef.current) {
        return
      }

      setRules(response.data)
    } catch (currentError) {
      if (requestId !== rulesRequestIdRef.current) {
        return
      }

      setRuleError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل حدود إعادة الطلب.',
      )
    } finally {
      if (requestId === rulesRequestIdRef.current) {
        setLoadingRules(false)
      }
    }
  }

  async function lookupItem() {
    if (!canAdjustInventory || lookingUpItem) {
      return
    }

    if (!selectedLocationId) {
      setRuleError('اختر مكان التخزين أولًا.')
      return
    }

    if (!itemCode.trim()) {
      setRuleError('اكتب SKU أو الباركود.')
      return
    }

    const requestId = lookupRequestIdRef.current + 1

    lookupRequestIdRef.current = requestId

    setLookingUpItem(true)
    setRuleError('')
    setRuleSuccess('')

    try {
      const parameters = new URLSearchParams({
        stockLocationId: selectedLocationId,
        code: itemCode.trim(),
      })

      const response = await requestJson<ApiResponse<InventoryLookupItem>>(
        `/api/inventory/lookup-item?${parameters.toString()}`,
      )

      if (requestId !== lookupRequestIdRef.current) {
        return
      }

      const lookupItemData = response.data

      const existingRule = rules.find(
        (rule) =>
          rule.stockLocationId === selectedLocationId &&
          rule.variantId === lookupItemData.variant_id,
      )

      if (existingRule) {
        setSelectedRuleId(existingRule.id)
        setSelectedLocationId(existingRule.stockLocationId)

        setItemCode(existingRule.primaryBarcode || existingRule.sku)

        setSelectedItem({
          variantId: existingRule.variantId,
          productId: existingRule.productId,
          productName: existingRule.productName,
          sku: existingRule.sku,
          primaryBarcode: existingRule.primaryBarcode,
          sizeName: existingRule.sizeName,
          colorName: existingRule.colorName,
          currentQuantity: existingRule.currentQuantity,
        })

        setReorderPoint(existingRule.reorderPoint)
        setSafetyStock(existingRule.safetyStock)
        setReorderQuantity(existingRule.reorderQuantity)
        setRuleIsActive(existingRule.isActive)

        setRuleError('')

        setRuleSuccess('تم العثور على قاعدة موجودة لهذا الصنف والمخزن.')

        return
      }

      setSelectedRuleId('')

      setSelectedItem({
        variantId: lookupItemData.variant_id,
        productId: lookupItemData.product_id,
        productName: lookupItemData.product_name,
        sku: lookupItemData.sku,
        primaryBarcode: lookupItemData.primary_barcode,
        sizeName: lookupItemData.size_name,
        colorName: lookupItemData.color_name,
        currentQuantity: lookupItemData.current_quantity,
      })

      setReorderPoint('1')
      setSafetyStock('0')
      setReorderQuantity('0')
      setRuleIsActive(true)

      setRuleSuccess('تم العثور على الصنف. أدخل حدود إعادة الطلب ثم احفظ.')
    } catch (currentError) {
      if (requestId !== lookupRequestIdRef.current) {
        return
      }

      setSelectedItem(null)

      setRuleError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر البحث عن الصنف.',
      )
    } finally {
      if (requestId === lookupRequestIdRef.current) {
        setLookingUpItem(false)
      }
    }
  }

  async function saveRule() {
    if (!canAdjustInventory || saveLockRef.current) {
      return
    }

    const itemToSave = selectedItem

    if (!selectedLocationId) {
      setRuleError('اختر مكان التخزين.')
      return
    }

    if (!itemToSave) {
      setRuleError('ابحث عن الصنف أو اختر قاعدة موجودة.')
      return
    }

    if (
      !reorderPoint.trim() ||
      !safetyStock.trim() ||
      !reorderQuantity.trim()
    ) {
      setRuleError('جميع قيم حدود إعادة الطلب مطلوبة.')
      return
    }

    const numericReorderPoint = Number(reorderPoint)
    const numericSafetyStock = Number(safetyStock)
    const numericReorderQuantity = Number(reorderQuantity)

    if (!Number.isFinite(numericReorderPoint) || numericReorderPoint < 0) {
      setRuleError('حد إعادة الطلب يجب أن يكون صفرًا أو أكبر.')
      return
    }

    if (!Number.isFinite(numericSafetyStock) || numericSafetyStock < 0) {
      setRuleError('حد الأمان يجب أن يكون صفرًا أو أكبر.')
      return
    }

    if (
      !Number.isFinite(numericReorderQuantity) ||
      numericReorderQuantity < 0
    ) {
      setRuleError('كمية إعادة الطلب يجب أن تكون صفرًا أو أكبر.')
      return
    }

    if (numericSafetyStock > numericReorderPoint) {
      setRuleError('حد الأمان لا يمكن أن يتجاوز حد إعادة الطلب.')
      return
    }

    if (ruleIsActive && numericReorderPoint <= 0) {
      setRuleError('القاعدة المفعّلة تحتاج حد إعادة طلب أكبر من صفر.')
      return
    }

    saveLockRef.current = true

    setSavingRule(true)
    setRuleError('')
    setRuleSuccess('')

    try {
      const response = await requestJson<SavedRuleResponse>(
        '/api/inventory/reorder-rules',
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            stockLocationId: selectedLocationId,
            variantId: itemToSave.variantId,
            reorderPoint: numericReorderPoint,
            safetyStock: numericSafetyStock,
            reorderQuantity: numericReorderQuantity,
            isActive: ruleIsActive,
          }),
        },
      )

      const savedRule = response.data.rule
      const savedItem = response.data.item

      setSelectedRuleId(savedRule.id)

      setSelectedItem({
        variantId: savedItem.variantId,
        productId: savedItem.productId,
        productName: savedItem.productName,
        sku: savedItem.sku,
        primaryBarcode: savedItem.primaryBarcode,
        sizeName: savedItem.sizeName,
        colorName: savedItem.colorName,
        currentQuantity: itemToSave.currentQuantity,
      })

      setReorderPoint(savedRule.reorderPoint)
      setSafetyStock(savedRule.safetyStock)
      setReorderQuantity(savedRule.reorderQuantity)
      setRuleIsActive(savedRule.isActive)

      setRuleSuccess(
        selectedRuleId
          ? 'تم تحديث قاعدة إعادة الطلب بنجاح.'
          : 'تم إنشاء قاعدة إعادة الطلب بنجاح.',
      )

      await Promise.all([loadRules(), Promise.resolve(onSaved())])
    } catch (currentError) {
      setRuleError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر حفظ قاعدة إعادة الطلب.',
      )
    } finally {
      saveLockRef.current = false
      setSavingRule(false)
    }
  }

  useEffect(() => {
    if (!user) {
      return
    }

    void loadRules()
  }, [user?.companyId, user?.branchId])

  useEffect(() => {
    const currentLocationIsAllowed = stockLocations.some(
      (location) => location.id === selectedLocationId,
    )

    if (currentLocationIsAllowed) {
      return
    }

    lookupRequestIdRef.current += 1

    const preferredLocationIsAllowed = stockLocations.some(
      (location) => location.id === preferredStockLocationId,
    )

    setSelectedLocationId(
      preferredLocationIsAllowed ? preferredStockLocationId : '',
    )

    setSelectedRuleId('')
    setSelectedItem(null)
    setItemCode('')
  }, [branchId, preferredStockLocationId, selectedLocationId, stockLocations])

  return (
    <section className="panel reorder-rule-panel">
      <div className="section-header">
        <div>
          <h2>إدارة حدود إعادة الطلب</h2>

          <p className="muted">
            عرض وتعديل حدود المخزون لكل صنف داخل مكان تخزين محدد.
          </p>
        </div>

        <button
          type="button"
          className="table-button"
          disabled={loadingRules}
          onClick={() => void loadRules()}
        >
          {loadingRules ? 'جاري تحميل القواعد...' : 'تحديث القواعد'}
        </button>
      </div>

      {ruleError ? <p className="error-message">{ruleError}</p> : null}

      {ruleSuccess ? <p className="success-message">{ruleSuccess}</p> : null}

      <section className="mini-cards-grid reorder-rule-summary-grid">
        <article className="mini-card">
          <span>القواعد المتاحة</span>
          <strong>{accessibleRules.length}</strong>
        </article>

        <article className="mini-card">
          <span>القواعد المفعّلة</span>
          <strong>{activeRulesCount}</strong>
        </article>

        <article className="mini-card">
          <span>القواعد المعطّلة</span>
          <strong>{accessibleRules.length - activeRulesCount}</strong>
        </article>
      </section>

      <div className="form-grid reorder-rule-selector-grid">
        <label>
          البحث في القواعد الحالية
          <input
            type="search"
            value={ruleSearch}
            maxLength={100}
            placeholder="اسم الصنف أو SKU أو الباركود أو المخزن"
            onChange={(event) => setRuleSearch(event.target.value)}
          />
        </label>

        <label>
          اختيار قاعدة موجودة
          <select
            value={selectedRuleId}
            disabled={loadingRules}
            onChange={(event) => {
              const ruleId = event.target.value

              if (!ruleId) {
                resetForm()
                return
              }

              const rule = rules.find(
                (currentRule) => currentRule.id === ruleId,
              )

              if (rule) {
                selectRule(rule)
              }
            }}
          >
            <option value="">قاعدة جديدة أو اختر قاعدة للتفاصيل</option>

            {filteredRules.map((rule) => (
              <option key={rule.id} value={rule.id}>
                {rule.productName}
                {' — '}
                {rule.sku}
                {' — '}
                {rule.stockLocationName}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="reorder-rule-search-row">
        <label>
          مكان التخزين
          <select
            value={selectedLocationId}
            disabled={!canAdjustInventory || savingRule}
            onChange={(event) => handleLocationChange(event.target.value)}
          >
            <option value="">اختر مكان التخزين</option>

            {stockLocations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
                {' — '}
                {location.code}
                {location.branchName
                  ? ` — ${location.branchName}`
                  : ' — مخزن مركزي'}
              </option>
            ))}
          </select>
        </label>

        <label>
          البحث عن صنف جديد
          <input
            type="search"
            value={itemCode}
            maxLength={120}
            disabled={
              !canAdjustInventory ||
              savingRule ||
              lookingUpItem ||
              !selectedLocationId
            }
            placeholder="اكتب SKU أو الباركود"
            onChange={(event) => setItemCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void lookupItem()
              }
            }}
          />
        </label>

        {canAdjustInventory ? (
          <button
            type="button"
            className="table-button"
            disabled={
              lookingUpItem ||
              savingRule ||
              !selectedLocationId ||
              !itemCode.trim()
            }
            onClick={() => void lookupItem()}
          >
            {lookingUpItem ? 'جاري البحث...' : 'بحث عن الصنف'}
          </button>
        ) : null}
      </div>

      {selectedItem ? (
        <div className="reorder-rule-selected-item">
          <div>
            <strong>{selectedItem.productName}</strong>

            <small>{createItemDescription(selectedItem)}</small>
          </div>

          <div>
            <span>الرصيد الحالي</span>

            <strong>{formatRuleQuantity(selectedItem.currentQuantity)}</strong>
          </div>
        </div>
      ) : (
        <p className="muted reorder-rule-empty-item">
          اختر قاعدة موجودة، أو اختر المخزن وابحث عن الصنف بالـ SKU أو الباركود.
        </p>
      )}

      <div className="form-grid reorder-rule-values-grid">
        <label>
          حد إعادة الطلب
          <input
            type="number"
            min="0"
            step="0.001"
            value={reorderPoint}
            disabled={!canAdjustInventory || savingRule || !selectedItem}
            onChange={(event) => setReorderPoint(event.target.value)}
          />
        </label>

        <label>
          حد الأمان
          <input
            type="number"
            min="0"
            step="0.001"
            value={safetyStock}
            disabled={!canAdjustInventory || savingRule || !selectedItem}
            onChange={(event) => setSafetyStock(event.target.value)}
          />
        </label>

        <label>
          كمية إعادة الطلب المقترحة
          <input
            type="number"
            min="0"
            step="0.001"
            value={reorderQuantity}
            disabled={!canAdjustInventory || savingRule || !selectedItem}
            onChange={(event) => setReorderQuantity(event.target.value)}
          />
        </label>

        <label>
          <input
            type="checkbox"
            checked={ruleIsActive}
            disabled={!canAdjustInventory || savingRule || !selectedItem}
            onChange={(event) => setRuleIsActive(event.target.checked)}
          />
          تفعيل قاعدة إعادة الطلب
        </label>
      </div>

      {canAdjustInventory ? (
        <div className="reorder-rule-actions">
          <button
            type="button"
            className="primary-button small-button"
            disabled={savingRule || !selectedItem}
            onClick={() => void saveRule()}
          >
            {savingRule
              ? 'جاري الحفظ...'
              : selectedRuleId
                ? 'حفظ التعديلات'
                : 'إنشاء القاعدة'}
          </button>

          <button
            type="button"
            className="table-button"
            disabled={savingRule}
            onClick={resetForm}
          >
            قاعدة جديدة
          </button>
        </div>
      ) : (
        <p className="selected-customer reorder-rule-readonly">
          لديك صلاحية عرض القواعد فقط. التعديل يحتاج inventory.adjust.
        </p>
      )}

      <div className="section-header reorder-rule-table-header">
        <div>
          <h3>القواعد الحالية</h3>

          <p className="muted">
            القواعد المفعّلة والمعطّلة ضمن نطاق الفرع المسموح.
          </p>
        </div>

        <span className="dashboard-record-count">
          {filteredRules.length} قاعدة
        </span>
      </div>

      {filteredRules.length === 0 ? (
        <p className="muted">
          {loadingRules
            ? 'جاري تحميل القواعد...'
            : 'لا توجد قواعد مطابقة للبحث الحالي.'}
        </p>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>الحالة</th>
                <th>الصنف</th>
                <th>المخزن</th>
                <th>الرصيد</th>
                <th>حد الأمان</th>
                <th>حد إعادة الطلب</th>
                <th>كمية الطلب</th>
                <th>مفعّلة</th>
                <th>آخر تحديث</th>

                {canAdjustInventory ? <th>تعديل</th> : null}
              </tr>
            </thead>

            <tbody>
              {filteredRules.map((rule) => (
                <tr key={rule.id}>
                  <td>
                    <span className={getRuleStatusClassName(rule.stockStatus)}>
                      {getRuleStatusLabel(rule.stockStatus)}
                    </span>
                  </td>

                  <td>
                    <div className="shortage-item-name">
                      <strong>{rule.productName}</strong>
                      <small>{createItemDescription(rule)}</small>
                    </div>
                  </td>

                  <td>
                    <div className="shortage-item-name">
                      <strong>{rule.stockLocationName}</strong>

                      <small>
                        {rule.branchName || 'مخزن مركزي'}
                        {' • '}
                        {rule.stockLocationCode}
                      </small>
                    </div>
                  </td>

                  <td>{formatRuleQuantity(rule.currentQuantity)}</td>
                  <td>{formatRuleQuantity(rule.safetyStock)}</td>
                  <td>{formatRuleQuantity(rule.reorderPoint)}</td>
                  <td>{formatRuleQuantity(rule.reorderQuantity)}</td>
                  <td>{rule.isActive ? 'نعم' : 'لا'}</td>
                  <td>{formatRuleTimestamp(rule.updatedAt)}</td>

                  {canAdjustInventory ? (
                    <td>
                      <button
                        type="button"
                        className="table-button"
                        disabled={savingRule}
                        onClick={() => selectRule(rule)}
                      >
                        تعديل
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export default InventoryReorderRulesPanel
