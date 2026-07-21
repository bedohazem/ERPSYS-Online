import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { requestJson } from '../lib/http'

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
}

type ConflictActionStatus = 'open' | 'reviewed' | 'ignored'

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

  const [activeTab, setActiveTab] = useState<'batches' | 'conflicts'>('batches')

  const [batches, setBatches] = useState<PosSyncBatch[]>([])
  const [conflicts, setConflicts] = useState<PosSyncConflict[]>([])

  const [selectedConflict, setSelectedConflict] =
    useState<PosSyncConflict | null>(null)

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
                          {conflict.server_entity_id ? (
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
                              {conflict.status === 'open' ? (
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

          <h3>بيانات التعارض</h3>

          <pre className="pos-sync-json">
            {JSON.stringify(selectedConflict.details ?? {}, null, 2)}
          </pre>

          {selectedConflict.server_entity_id ? (
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
