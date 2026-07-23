import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { ApiError, requestJson } from '../lib/http'

type ApiResponse<T> = {
  data: T
}

type PosSyncBatch = {
  id: string
  company_id: string
  branch_id: string
  device_id: string

  batch_key: string
  status:
    | 'received'
    | 'processing'
    | 'completed'
    | 'completed_with_errors'
    | 'failed'

  total_items: number
  processed_items: number
  review_items: number
  failed_items: number

  received_at: string
  processed_at: string | null

  request_payload: Record<string, unknown> | null
  response_payload: Record<string, unknown> | null

  device_code: string
  device_name: string

  branch_code: string
  branch_name: string
}

type PosSyncItem = {
  id: string
  company_id: string
  batch_id: string

  local_entity_type: 'sale' | 'return' | 'exchange'

  local_entity_id: string
  idempotency_key: string

  status: 'pending' | 'processed' | 'failed' | 'needs_review' | 'duplicate'

  server_entity_type: 'sale' | 'return' | 'exchange' | null

  server_entity_id: string | null

  error_code: string | null
  error_message: string | null

  item_payload: Record<string, unknown> | null

  result_payload: Record<string, unknown> | null

  attempt_count: number
  last_attempt_at: string | null
  created_at: string
  processed_at: string | null

  sale_number: string | null
  sale_status: string | null
  sale_occurred_at: string | null
}

type PosSyncConflict = {
  id: string
  company_id: string
  branch_id: string
  device_id: string | null
  sync_item_id: string | null

  conflict_type: string
  severity: 'info' | 'warning' | 'critical'
  status: 'open' | 'reviewed' | 'resolved' | 'ignored'

  details: Record<string, unknown> | null

  created_at: string
  reviewed_at: string | null
  reviewed_by: string | null
  reviewed_by_name: string | null

  device_code: string | null
  device_name: string | null

  branch_code: string
  branch_name: string

  local_entity_id: string | null
  idempotency_key: string | null
  server_entity_id: string | null

  error_code: string | null
  error_message: string | null
  resolution_action: string | null

  resolution_note: string | null

  resolved_at: string | null

  resolved_by: string | null
}

type PosSyncBatchDetails = {
  batch: PosSyncBatch
  items: PosSyncItem[]
  conflicts: PosSyncConflict[]
}

type ConflictActionStatus = 'open' | 'reviewed' | 'ignored'

type ConflictResolutionAction =
  | 'accept_submitted_price'
  | 'retry_stock_deduction'

type PosSyncPageProps = {
  companyId: string
  branchId: string
  onOpenSale: (saleId: string) => void
}

const syncDateFormatter = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatSyncDate(value: string | null) {
  if (!value) {
    return '-'
  }

  const parsedDate = new Date(value)

  return Number.isNaN(parsedDate.getTime())
    ? '-'
    : syncDateFormatter.format(parsedDate)
}

function translateBatchStatus(status: string) {
  const labels: Record<string, string> = {
    received: 'مستلمة',
    processing: 'جاري المعالجة',
    completed: 'مكتملة',
    completed_with_errors: 'مكتملة بتعارضات',
    failed: 'فشلت',
  }

  return labels[status] || status
}

function translateSyncItemStatus(status: string) {
  const labels: Record<string, string> = {
    pending: 'بانتظار المعالجة',
    processed: 'تمت المعالجة',
    failed: 'فشلت',
    needs_review: 'تحتاج مراجعة',
    duplicate: 'مكررة آمنة',
  }

  return labels[status] || status
}

function translateConflictStatus(status: string) {
  const labels: Record<string, string> = {
    open: 'مفتوح',
    reviewed: 'تمت المراجعة',
    resolved: 'تم الحل',
    ignored: 'تم التجاهل',
  }

  return labels[status] || status
}

function translateConflictSeverity(severity: string) {
  const labels: Record<string, string> = {
    info: 'معلومة',
    warning: 'تحذير',
    critical: 'حرج',
  }

  return labels[severity] || severity
}

function translateConflictType(conflictType: string) {
  const labels: Record<string, string> = {
    negative_stock: 'مخزون غير كافٍ',
    price_changed: 'تغير السعر',
    variant_not_found: 'الصنف غير موجود',
    cashier_not_found: 'الكاشير غير موجود',
    cashier_grant_invalid: 'تصريح الكاشير غير صالح',
    stock_location_not_found: 'مكان التخزين غير موجود',
    customer_not_found: 'العميل غير موجود',
    shift_not_found: 'وردية الكاشير غير صالحة',
    payment_mismatch: 'عدم تطابق المدفوعات',
    invalid_payload: 'بيانات غير صالحة',
    duplicate_suspected: 'اشتباه في التكرار',
    unknown: 'تعارض غير معروف',
  }

  return labels[conflictType] || conflictType
}

function PosSyncPage({ companyId, branchId, onOpenSale }: PosSyncPageProps) {
  const { user } = useAuth()

  const isAdmin = user?.roles.includes('admin') ?? false

  const hasPermission = (permission: string) =>
    isAdmin || user?.permissions.includes(permission) || false

  const canViewSync =
    hasPermission('pos.sync.view') || hasPermission('pos.sync.manage')

  const canManageSync = hasPermission('pos.sync.manage')

  const canOpenLinkedSale = hasPermission('sales.view')

  const [activeTab, setActiveTab] = useState<'batches' | 'conflicts'>('batches')

  const [batches, setBatches] = useState<PosSyncBatch[]>([])
  const [conflicts, setConflicts] = useState<PosSyncConflict[]>([])

  const [selectedConflict, setSelectedConflict] =
    useState<PosSyncConflict | null>(null)

  const [selectedBatchDetails, setSelectedBatchDetails] =
    useState<PosSyncBatchDetails | null>(null)

  const [loadingBatchId, setLoadingBatchId] = useState<string | null>(null)

  const [batchStatusFilter, setBatchStatusFilter] = useState('')
  const [batchSearch, setBatchSearch] = useState('')

  const [conflictStatusFilter, setConflictStatusFilter] = useState('open')
  const [conflictTypeFilter, setConflictTypeFilter] = useState('')
  const [severityFilter, setSeverityFilter] = useState('')
  const [conflictSearch, setConflictSearch] = useState('')

  const [loadingBatches, setLoadingBatches] = useState(false)
  const [loadingConflicts, setLoadingConflicts] = useState(false)

  const [runningConflictId, setRunningConflictId] = useState<string | null>(
    null,
  )

  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const conflictActionLock = useRef(false)

  const filteredBatches = useMemo(() => {
    const normalizedSearch = batchSearch.trim().toLowerCase()

    if (!normalizedSearch) {
      return batches
    }

    return batches.filter((batch) =>
      [
        batch.batch_key,
        batch.device_code,
        batch.device_name,
        batch.branch_code,
        batch.branch_name,
      ].some((value) => value.toLowerCase().includes(normalizedSearch)),
    )
  }, [batches, batchSearch])

  const filteredConflicts = useMemo(() => {
    const normalizedSearch = conflictSearch.trim().toLowerCase()

    return conflicts.filter((conflict) => {
      if (conflictTypeFilter && conflict.conflict_type !== conflictTypeFilter) {
        return false
      }

      if (severityFilter && conflict.severity !== severityFilter) {
        return false
      }

      if (!normalizedSearch) {
        return true
      }

      return [
        conflict.local_entity_id,
        conflict.idempotency_key,
        conflict.server_entity_id,
        conflict.device_code,
        conflict.device_name,
        conflict.error_code,
        conflict.error_message,
      ].some((value) =>
        String(value || '')
          .toLowerCase()
          .includes(normalizedSearch),
      )
    })
  }, [conflicts, conflictSearch, conflictTypeFilter, severityFilter])

  const openConflictsCount = useMemo(
    () => conflicts.filter((conflict) => conflict.status === 'open').length,
    [conflicts],
  )

  const criticalConflictsCount = useMemo(
    () =>
      conflicts.filter(
        (conflict) =>
          conflict.status === 'open' && conflict.severity === 'critical',
      ).length,
    [conflicts],
  )

  const batchesWithErrorsCount = useMemo(
    () =>
      batches.filter(
        (batch) =>
          batch.status === 'completed_with_errors' || batch.status === 'failed',
      ).length,
    [batches],
  )

  async function loadBatches() {
    setLoadingBatches(true)
    setError('')

    try {
      const searchParams = new URLSearchParams({
        companyId: companyId.trim(),
        limit: '100',
      })

      if (branchId.trim()) {
        searchParams.set('branchId', branchId.trim())
      }

      if (batchStatusFilter) {
        searchParams.set('status', batchStatusFilter)
      }

      const response = await requestJson<ApiResponse<PosSyncBatch[]>>(
        `/api/pos-sync-admin/batches?${searchParams.toString()}`,
      )

      setBatches(response.data)
    } catch (currentError) {
      setBatches([])

      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل سجل مزامنة أجهزة POS.',
      )
    } finally {
      setLoadingBatches(false)
    }
  }

  async function loadBatchDetails(batchId: string) {
    setLoadingBatchId(batchId)
    setError('')

    try {
      const searchParams = new URLSearchParams({
        companyId: companyId.trim(),
      })

      if (branchId.trim()) {
        searchParams.set('branchId', branchId.trim())
      }

      const response = await requestJson<ApiResponse<PosSyncBatchDetails>>(
        `/api/pos-sync-admin/batches/${encodeURIComponent(
          batchId,
        )}?${searchParams.toString()}`,
      )

      setSelectedBatchDetails(response.data)
    } catch (currentError) {
      setSelectedBatchDetails(null)

      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل تفاصيل دفعة المزامنة.',
      )
    } finally {
      setLoadingBatchId(null)
    }
  }

  async function loadConflicts() {
    setLoadingConflicts(true)
    setError('')

    try {
      const searchParams = new URLSearchParams({
        companyId: companyId.trim(),
        limit: '100',
      })

      if (branchId.trim()) {
        searchParams.set('branchId', branchId.trim())
      }

      if (conflictStatusFilter) {
        searchParams.set('status', conflictStatusFilter)
      }

      const response = await requestJson<ApiResponse<PosSyncConflict[]>>(
        `/api/pos-sync-admin/conflicts?${searchParams.toString()}`,
      )

      setConflicts(response.data)

      setSelectedConflict((currentConflict) => {
        if (!currentConflict) {
          return null
        }

        return (
          response.data.find(
            (conflict) => conflict.id === currentConflict.id,
          ) ?? null
        )
      })
    } catch (currentError) {
      setConflicts([])
      setSelectedConflict(null)

      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل تعارضات مزامنة POS.',
      )
    } finally {
      setLoadingConflicts(false)
    }
  }

  async function loadPageData() {
    setError('')
    setSuccess('')

    await Promise.all([loadBatches(), loadConflicts()])
  }

  async function updateConflictStatus(
    conflict: PosSyncConflict,
    status: ConflictActionStatus,
  ) {
    if (conflictActionLock.current) {
      return
    }

    const actionLabel =
      status === 'reviewed'
        ? 'تأكيد مراجعة'
        : status === 'ignored'
          ? 'تجاهل'
          : 'إعادة فتح'

    const confirmed = window.confirm(
      `${actionLabel} التعارض الخاص بالعملية ${
        conflict.local_entity_id || conflict.id
      }؟`,
    )

    if (!confirmed) {
      return
    }

    conflictActionLock.current = true
    setRunningConflictId(conflict.id)
    setError('')
    setSuccess('')

    try {
      await requestJson<ApiResponse<PosSyncConflict>>(
        `/api/pos-sync-admin/conflicts/${encodeURIComponent(
          conflict.id,
        )}/status`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            status,
          }),
        },
      )

      setSuccess(`تم ${actionLabel} التعارض بنجاح.`)

      await Promise.all([loadConflicts(), loadBatches()])
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحديث حالة التعارض.',
      )
    } finally {
      conflictActionLock.current = false
      setRunningConflictId(null)
    }
  }

  async function resolveConflict(
    conflict: PosSyncConflict,
    action: ConflictResolutionAction,
  ) {
    if (conflictActionLock.current) {
      return
    }

    const actionLabel =
      action === 'accept_submitted_price'
        ? 'قبول السعر المسجل في الفاتورة'
        : 'إعادة محاولة خصم المخزون'

    const note = window.prompt('ملاحظة الحل — اختيارية:', '')

    if (note === null) {
      return
    }

    const confirmed = window.confirm(
      `${actionLabel} للعملية ${conflict.local_entity_id || conflict.id}؟`,
    )

    if (!confirmed) {
      return
    }

    conflictActionLock.current = true

    setRunningConflictId(conflict.id)

    setError('')
    setSuccess('')

    try {
      await requestJson(
        `/api/pos-sync-admin/conflicts/${encodeURIComponent(
          conflict.id,
        )}/resolve`,

        {
          method: 'POST',

          headers: {
            'Content-Type': 'application/json',
          },

          body: JSON.stringify({
            action,

            note: note.trim() || null,
          }),
        },
      )

      setSuccess(`تم ${actionLabel} بنجاح.`)

      await Promise.all([
        loadConflicts(),
        loadBatches(),

        selectedBatchDetails
          ? loadBatchDetails(selectedBatchDetails.batch.id)
          : Promise.resolve(),
      ])
    } catch (currentError) {
      if (currentError instanceof ApiError) {
        const errorData = currentError.data as {
          details?: {
            shortages?: Array<{
              variantId?: unknown
              availableQuantity?: unknown
              requestedQuantity?: unknown
            }>
          }
        } | null

        const shortages = errorData?.details?.shortages

        if (Array.isArray(shortages) && shortages.length > 0) {
          const shortageText = shortages
            .map(
              (shortage) =>
                `${String(shortage.variantId || '-')}: المتاح ${String(
                  shortage.availableQuantity ?? 0,
                )} والمطلوب ${String(shortage.requestedQuantity ?? 0)}`,
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
            : 'تعذر حل التعارض.',
        )
      }
    } finally {
      conflictActionLock.current = false
      setRunningConflictId(null)
    }
  }

  useEffect(() => {
    if (!canViewSync || !companyId.trim()) {
      return
    }

    void loadBatches()
  }, [canViewSync, companyId, branchId, batchStatusFilter])

  useEffect(() => {
    if (!canViewSync || !companyId.trim()) {
      return
    }

    void loadConflicts()
  }, [canViewSync, companyId, branchId, conflictStatusFilter])

  if (!canViewSync) {
    return (
      <section className="panel">
        <h2>مزامنة نقاط البيع</h2>

        <p className="error-message">
          لا تملك صلاحية عرض سجل مزامنة أجهزة POS.
        </p>
      </section>
    )
  }

  return (
    <>
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>مزامنة نقاط البيع Offline</h2>

            <p className="muted">
              متابعة دفعات المبيعات المؤجلة ومراجعة التعارضات الناتجة عن
              معالجتها في PostgreSQL.
            </p>
          </div>

          <button
            type="button"
            className="primary-button small-button"
            disabled={loadingBatches || loadingConflicts}
            onClick={() => void loadPageData()}
          >
            {loadingBatches || loadingConflicts
              ? 'جاري التحديث...'
              : 'تحديث البيانات'}
          </button>
        </div>

        {error ? <p className="error-message">{error}</p> : null}

        {success ? <p className="success-message">{success}</p> : null}
      </section>

      <section className="mini-cards-grid pos-sync-summary-grid">
        <article className="mini-card">
          <span>دفعات المزامنة</span>
          <strong>{batches.length}</strong>
        </article>

        <article className="mini-card">
          <span>دفعات بها أخطاء</span>
          <strong>{batchesWithErrorsCount}</strong>
        </article>

        <article className="mini-card">
          <span>التعارضات المفتوحة</span>
          <strong>{openConflictsCount}</strong>
        </article>

        <article className="mini-card">
          <span>تعارضات حرجة</span>
          <strong>{criticalConflictsCount}</strong>
        </article>
      </section>

      <div className="tabs pos-sync-tabs">
        <button
          type="button"
          className={`tab ${activeTab === 'batches' ? 'active-tab' : ''}`}
          onClick={() => setActiveTab('batches')}
        >
          سجل المزامنة
        </button>

        <button
          type="button"
          className={`tab ${activeTab === 'conflicts' ? 'active-tab' : ''}`}
          onClick={() => setActiveTab('conflicts')}
        >
          التعارضات
        </button>
      </div>

      {activeTab === 'batches' ? (
        <section className="panel">
          <div className="section-header">
            <div>
              <h2>دفعات المزامنة</h2>

              <p className="muted">
                كل عملية رفع جماعي أرسلها جهاز POS إلى السيرفر.
              </p>
            </div>

            <span className="record-count-badge">
              {filteredBatches.length} دفعة
            </span>
          </div>

          <div className="form-grid pos-sync-filter-grid">
            <label>
              حالة الدفعة
              <select
                value={batchStatusFilter}
                onChange={(event) => setBatchStatusFilter(event.target.value)}
              >
                <option value="">كل الحالات</option>
                <option value="received">مستلمة</option>
                <option value="processing">جاري المعالجة</option>
                <option value="completed">مكتملة</option>
                <option value="completed_with_errors">مكتملة بتعارضات</option>
                <option value="failed">فشلت</option>
              </select>
            </label>

            <label>
              بحث
              <input
                value={batchSearch}
                onChange={(event) => setBatchSearch(event.target.value)}
                placeholder="رقم الدفعة أو الجهاز أو الفرع"
              />
            </label>
          </div>

          {filteredBatches.length === 0 ? (
            <p className="muted">
              {loadingBatches
                ? 'جاري تحميل دفعات المزامنة...'
                : 'لا توجد دفعات مطابقة للفلاتر.'}
            </p>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Batch Key</th>
                    <th>الجهاز</th>
                    <th>الفرع</th>
                    <th>وقت الاستلام</th>
                    <th>وقت الانتهاء</th>
                    <th>الحالة</th>
                    <th>الإجمالي</th>
                    <th>تمت المعالجة</th>
                    <th>تحتاج مراجعة</th>
                    <th>فشلت</th>
                    <th>التفاصيل</th>
                  </tr>
                </thead>

                <tbody>
                  {filteredBatches.map((batch) => (
                    <tr key={batch.id}>
                      <td>
                        <strong className="document-number">
                          {batch.batch_key}
                        </strong>
                      </td>

                      <td>
                        {batch.device_name}
                        <small className="pos-sync-secondary-text">
                          {batch.device_code}
                        </small>
                      </td>

                      <td>
                        {batch.branch_name}
                        <small className="pos-sync-secondary-text">
                          {batch.branch_code}
                        </small>
                      </td>

                      <td>{formatSyncDate(batch.received_at)}</td>
                      <td>{formatSyncDate(batch.processed_at)}</td>

                      <td>
                        <span
                          className={`pos-sync-status pos-sync-status-${batch.status}`}
                        >
                          {translateBatchStatus(batch.status)}
                        </span>
                      </td>

                      <td>{batch.total_items}</td>
                      <td>{batch.processed_items}</td>
                      <td>{batch.review_items}</td>
                      <td>{batch.failed_items}</td>
                      <td>
                        <button
                          type="button"
                          className="table-button"
                          disabled={loadingBatchId === batch.id}
                          onClick={() => void loadBatchDetails(batch.id)}
                        >
                          {loadingBatchId === batch.id
                            ? 'جاري التحميل...'
                            : 'عرض المحاولات'}
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

      {activeTab === 'batches' && selectedBatchDetails ? (
        <section className="panel pos-sync-batch-details-panel">
          <div className="section-header">
            <div>
              <h2>تفاصيل دفعة المزامنة</h2>

              <p className="muted">
                Batch Key:{' '}
                <strong>{selectedBatchDetails.batch.batch_key}</strong>
                {' • '}
                {selectedBatchDetails.batch.device_name}
              </p>
            </div>

            <button
              type="button"
              className="table-button"
              onClick={() => setSelectedBatchDetails(null)}
            >
              إغلاق التفاصيل
            </button>
          </div>

          <section className="mini-cards-grid pos-sync-batch-details-grid">
            <article className="mini-card">
              <span>إجمالي المحاولات</span>
              <strong>{selectedBatchDetails.items.length}</strong>
            </article>

            <article className="mini-card">
              <span>تمت المعالجة</span>
              <strong>{selectedBatchDetails.batch.processed_items}</strong>
            </article>

            <article className="mini-card">
              <span>تحتاج مراجعة</span>
              <strong>{selectedBatchDetails.batch.review_items}</strong>
            </article>

            <article className="mini-card">
              <span>فشلت</span>
              <strong>{selectedBatchDetails.batch.failed_items}</strong>
            </article>
          </section>

          <h3>محاولات الرفع</h3>

          {selectedBatchDetails.items.length === 0 ? (
            <p className="muted">لا توجد محاولات مسجلة داخل هذه الدفعة.</p>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Local Sale ID</th>
                    <th>وقت المحاولة</th>
                    <th>الحالة</th>
                    <th>رقم الفاتورة</th>
                    <th>الخطأ</th>
                    <th>الفاتورة</th>
                    <th>Payload</th>
                    <th>النتيجة</th>
                  </tr>
                </thead>

                <tbody>
                  {selectedBatchDetails.items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <strong>{item.local_entity_id}</strong>

                        <small className="pos-sync-secondary-text">
                          {item.idempotency_key}
                        </small>
                      </td>

                      <td>{formatSyncDate(item.created_at)}</td>

                      <td>
                        <span
                          className={`pos-sync-status pos-sync-item-status-${item.status}`}
                        >
                          {translateSyncItemStatus(item.status)}
                        </span>
                      </td>

                      <td>{item.sale_number || '-'}</td>

                      <td>
                        {item.error_code || '-'}

                        <small className="pos-sync-secondary-text">
                          {item.error_message || ''}
                        </small>
                      </td>

                      <td>
                        {item.server_entity_id && canOpenLinkedSale ? (
                          <button
                            type="button"
                            className="table-button"
                            onClick={() =>
                              onOpenSale(item.server_entity_id as string)
                            }
                          >
                            فتح الفاتورة
                          </button>
                        ) : (
                          '-'
                        )}
                      </td>

                      <td>
                        <details className="pos-sync-payload-details">
                          <summary>عرض البيانات</summary>

                          <pre className="pos-sync-json pos-sync-table-json">
                            {JSON.stringify(item.item_payload ?? {}, null, 2)}
                          </pre>
                        </details>
                      </td>

                      <td>
                        <details className="pos-sync-payload-details">
                          <summary>عرض النتيجة</summary>

                          <pre className="pos-sync-json pos-sync-table-json">
                            {JSON.stringify(item.result_payload ?? {}, null, 2)}
                          </pre>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3>تعارضات الدفعة ({selectedBatchDetails.conflicts.length})</h3>

          {selectedBatchDetails.conflicts.length === 0 ? (
            <p className="muted">لا توجد تعارضات مرتبطة بهذه الدفعة.</p>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>العملية</th>
                    <th>النوع</th>
                    <th>الخطورة</th>
                    <th>الحالة</th>
                    <th>التاريخ</th>
                  </tr>
                </thead>

                <tbody>
                  {selectedBatchDetails.conflicts.map((conflict) => (
                    <tr key={conflict.id}>
                      <td>{conflict.local_entity_id || '-'}</td>

                      <td>{translateConflictType(conflict.conflict_type)}</td>

                      <td>{translateConflictSeverity(conflict.severity)}</td>

                      <td>{translateConflictStatus(conflict.status)}</td>

                      <td>{formatSyncDate(conflict.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {activeTab === 'conflicts' ? (
        <section className="panel">
          <div className="section-header">
            <div>
              <h2>تعارضات المزامنة</h2>

              <p className="muted">
                مراجعة مشاكل المخزون والأسعار والأصناف والمدفوعات.
              </p>
            </div>

            <span className="record-count-badge">
              {filteredConflicts.length} تعارض
            </span>
          </div>

          <div className="form-grid pos-sync-conflict-filter-grid">
            <label>
              حالة التعارض
              <select
                value={conflictStatusFilter}
                onChange={(event) =>
                  setConflictStatusFilter(event.target.value)
                }
              >
                <option value="">كل الحالات</option>
                <option value="open">مفتوح</option>
                <option value="reviewed">تمت المراجعة</option>
                <option value="ignored">تم التجاهل</option>
                <option value="resolved">تم الحل</option>
              </select>
            </label>

            <label>
              نوع التعارض
              <select
                value={conflictTypeFilter}
                onChange={(event) => setConflictTypeFilter(event.target.value)}
              >
                <option value="">كل الأنواع</option>
                <option value="negative_stock">مخزون غير كافٍ</option>
                <option value="price_changed">تغير السعر</option>
                <option value="variant_not_found">الصنف غير موجود</option>
                <option value="cashier_not_found">الكاشير غير موجود</option>
                <option value="cashier_grant_invalid">
                  تصريح الكاشير غير صالح
                </option>
                <option value="stock_location_not_found">
                  مكان التخزين غير موجود
                </option>
                <option value="customer_not_found">العميل غير موجود</option>
                <option value="shift_not_found">وردية غير صالحة</option>
                <option value="payment_mismatch">عدم تطابق المدفوعات</option>
                <option value="invalid_payload">بيانات غير صالحة</option>
                <option value="duplicate_suspected">اشتباه تكرار</option>
                <option value="unknown">غير معروف</option>
              </select>
            </label>

            <label>
              درجة الخطورة
              <select
                value={severityFilter}
                onChange={(event) => setSeverityFilter(event.target.value)}
              >
                <option value="">كل الدرجات</option>
                <option value="critical">حرج</option>
                <option value="warning">تحذير</option>
                <option value="info">معلومة</option>
              </select>
            </label>

            <label>
              بحث
              <input
                value={conflictSearch}
                onChange={(event) => setConflictSearch(event.target.value)}
                placeholder="Local Sale ID أو الجهاز أو الخطأ"
              />
            </label>
          </div>

          {filteredConflicts.length === 0 ? (
            <p className="muted">
              {loadingConflicts
                ? 'جاري تحميل التعارضات...'
                : 'لا توجد تعارضات مطابقة للفلاتر.'}
            </p>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>التاريخ</th>
                    <th>العملية المحلية</th>
                    <th>الجهاز</th>
                    <th>النوع</th>
                    <th>الخطورة</th>
                    <th>الحالة</th>
                    <th>الخطأ</th>
                    <th>الفاتورة</th>
                    <th>التفاصيل</th>
                    <th>الإجراء</th>
                  </tr>
                </thead>

                <tbody>
                  {filteredConflicts.map((conflict) => {
                    const actionRunning = runningConflictId === conflict.id

                    return (
                      <tr key={conflict.id}>
                        <td>{formatSyncDate(conflict.created_at)}</td>

                        <td>
                          <strong>{conflict.local_entity_id || '-'}</strong>
                        </td>

                        <td>
                          {conflict.device_name || '-'}
                          <small className="pos-sync-secondary-text">
                            {conflict.device_code || '-'}
                          </small>
                        </td>

                        <td>{translateConflictType(conflict.conflict_type)}</td>

                        <td>
                          <span
                            className={`pos-sync-severity pos-sync-severity-${conflict.severity}`}
                          >
                            {translateConflictSeverity(conflict.severity)}
                          </span>
                        </td>

                        <td>
                          <span
                            className={`pos-sync-status pos-sync-conflict-status-${conflict.status}`}
                          >
                            {translateConflictStatus(conflict.status)}
                          </span>
                        </td>

                        <td>
                          {conflict.error_code || '-'}
                          <small className="pos-sync-secondary-text">
                            {conflict.error_message || ''}
                          </small>
                        </td>

                        <td>
                          {conflict.server_entity_id && canOpenLinkedSale ? (
                            <button
                              type="button"
                              className="table-button"
                              onClick={() =>
                                onOpenSale(conflict.server_entity_id as string)
                              }
                            >
                              فتح الفاتورة
                            </button>
                          ) : (
                            '-'
                          )}
                        </td>

                        <td>
                          <button
                            type="button"
                            className="table-button"
                            onClick={() => setSelectedConflict(conflict)}
                          >
                            عرض التفاصيل
                          </button>
                        </td>

                        <td>
                          {canManageSync ? (
                            <div className="pos-sync-action-buttons">
                              {conflict.status !== 'resolved' &&
                              conflict.conflict_type === 'price_changed' ? (
                                <button
                                  type="button"
                                  className="table-button primary-button"
                                  disabled={actionRunning}
                                  onClick={() =>
                                    void resolveConflict(
                                      conflict,
                                      'accept_submitted_price',
                                    )
                                  }
                                >
                                  قبول سعر الفاتورة
                                </button>
                              ) : null}

                              {conflict.status !== 'resolved' &&
                              conflict.conflict_type === 'negative_stock' ? (
                                <button
                                  type="button"
                                  className="table-button primary-button"
                                  disabled={actionRunning}
                                  onClick={() =>
                                    void resolveConflict(
                                      conflict,
                                      'retry_stock_deduction',
                                    )
                                  }
                                >
                                  إعادة خصم المخزون
                                </button>
                              ) : null}

                              {conflict.status === 'resolved' ? (
                                <span className="muted">تم الحل نهائيًا</span>
                              ) : conflict.status === 'open' ? (
                                <>
                                  <button
                                    type="button"
                                    className="table-button"
                                    disabled={actionRunning}
                                    onClick={() =>
                                      void updateConflictStatus(
                                        conflict,
                                        'reviewed',
                                      )
                                    }
                                  >
                                    تمت المراجعة
                                  </button>

                                  {conflict.severity !== 'critical' ? (
                                    <button
                                      type="button"
                                      className="table-button danger-button"
                                      disabled={actionRunning}
                                      onClick={() =>
                                        void updateConflictStatus(
                                          conflict,
                                          'ignored',
                                        )
                                      }
                                    >
                                      تجاهل
                                    </button>
                                  ) : null}
                                </>
                              ) : (
                                <button
                                  type="button"
                                  className="table-button"
                                  disabled={actionRunning}
                                  onClick={() =>
                                    void updateConflictStatus(conflict, 'open')
                                  }
                                >
                                  إعادة فتح
                                </button>
                              )}
                            </div>
                          ) : (
                            <span className="muted">عرض فقط</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {selectedConflict ? (
        <section className="panel pos-sync-details-panel">
          <div className="section-header">
            <div>
              <h2>تفاصيل التعارض</h2>

              <p className="muted">
                {translateConflictType(selectedConflict.conflict_type)}
                {' • '}
                {selectedConflict.local_entity_id || selectedConflict.id}
              </p>
            </div>

            <button
              type="button"
              className="table-button"
              onClick={() => setSelectedConflict(null)}
            >
              إغلاق التفاصيل
            </button>
          </div>

          <section className="mini-cards-grid pos-sync-details-grid">
            <article className="mini-card">
              <span>الجهاز</span>
              <strong>{selectedConflict.device_name || '-'}</strong>
            </article>

            <article className="mini-card">
              <span>الفرع</span>
              <strong>{selectedConflict.branch_name}</strong>
            </article>

            <article className="mini-card">
              <span>الحالة</span>
              <strong>
                {translateConflictStatus(selectedConflict.status)}
              </strong>
            </article>

            <article className="mini-card">
              <span>وقت المراجعة</span>
              <strong>{formatSyncDate(selectedConflict.reviewed_at)}</strong>
            </article>
          </section>

          {selectedConflict.resolution_action ? (
            <p className="success-message">
              تم حل التعارض باستخدام:{' '}
              <strong>
                {selectedConflict.resolution_action === 'accept_submitted_price'
                  ? 'قبول السعر المسجل في الفاتورة'
                  : selectedConflict.resolution_action ===
                      'retry_stock_deduction'
                    ? 'إعادة خصم المخزون'
                    : selectedConflict.resolution_action}
              </strong>
              {' • '}
              {formatSyncDate(selectedConflict.resolved_at)}
              {selectedConflict.resolution_note
                ? ` • ${selectedConflict.resolution_note}`
                : ''}
            </p>
          ) : null}

          <h3>بيانات التعارض</h3>

          <pre className="pos-sync-json">
            {JSON.stringify(selectedConflict.details ?? {}, null, 2)}
          </pre>

          {selectedConflict.server_entity_id && canOpenLinkedSale ? (
            <button
              type="button"
              className="primary-button"
              onClick={() =>
                onOpenSale(selectedConflict.server_entity_id as string)
              }
            >
              فتح الفاتورة المرتبطة
            </button>
          ) : null}
        </section>
      ) : null}
    </>
  )
}

export default PosSyncPage
