import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { requestJson } from '../lib/http'

type ApiResponse<T> = {
  data: T
}

type BranchOption = {
  id: string
  code: string
  name: string
  is_active: boolean
}

type PosDevice = {
  id: string
  company_id: string
  branch_id: string

  branch_name: string
  branch_code: string

  device_code: string
  device_name: string

  status: 'active' | 'inactive' | 'blocked'

  has_secret: boolean

  last_seen_at: string | null
  registered_at: string
  secret_rotated_at: string | null
  updated_at: string

  created_by_name: string | null
}

type DeviceSecretResponse = {
  device: PosDevice
  deviceSecret: string
}

type PosDevicesPageProps = {
  companyId: string
  branchId: string
}

const deviceDateFormatter = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatDeviceDate(value: string | null) {
  if (!value) {
    return '-'
  }

  const parsedDate = new Date(value)

  return Number.isNaN(parsedDate.getTime())
    ? '-'
    : deviceDateFormatter.format(parsedDate)
}

function translateDeviceStatus(status: string) {
  const labels: Record<string, string> = {
    active: 'نشط',
    inactive: 'غير نشط',
    blocked: 'محظور',
  }

  return labels[status] || status
}

function deviceStatusClass(status: string) {
  return `pos-device-status pos-device-status-${status}`
}

function PosDevicesPage({ companyId, branchId }: PosDevicesPageProps) {
  const { user } = useAuth()

  const isAdmin = user?.roles.includes('admin') ?? false

  const hasPermission = (permission: string) =>
    isAdmin || user?.permissions.includes(permission) || false

  const canViewDevices =
    hasPermission('pos.devices.view') || hasPermission('pos.devices.manage')

  const canManageDevices = hasPermission('pos.devices.manage')

  const [branches, setBranches] = useState<BranchOption[]>([])

  const [devices, setDevices] = useState<PosDevice[]>([])

  const [selectedBranchId, setSelectedBranchId] = useState('')

  const [deviceCode, setDeviceCode] = useState('')

  const [deviceName, setDeviceName] = useState('')

  const [statusFilter, setStatusFilter] = useState('')

  const [newDeviceSecret, setNewDeviceSecret] = useState('')

  const [secretDeviceName, setSecretDeviceName] = useState('')

  const [loading, setLoading] = useState(false)

  const [saving, setSaving] = useState(false)

  const [runningDeviceId, setRunningDeviceId] = useState<string | null>(null)

  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const saveLock = useRef(false)
  const actionLock = useRef(false)

  const activeDevices = useMemo(
    () => devices.filter((device) => device.status === 'active').length,
    [devices],
  )

  const blockedDevices = useMemo(
    () => devices.filter((device) => device.status === 'blocked').length,
    [devices],
  )

  async function loadBranches() {
    if (!canManageDevices) {
      setBranches([])
      return
    }

    const url =
      `/api/pos-devices/branches` +
      `?companyId=${encodeURIComponent(companyId.trim())}` +
      (branchId.trim()
        ? `&branchId=${encodeURIComponent(branchId.trim())}`
        : '')

    const response = await requestJson<ApiResponse<BranchOption[]>>(url)

    setBranches(response.data)

    setSelectedBranchId((current) => {
      const stillExists = response.data.some((branch) => branch.id === current)

      return stillExists ? current : (response.data[0]?.id ?? '')
    })
  }

  async function loadDevices() {
    setLoading(true)
    setError('')

    try {
      const url =
        `/api/pos-devices` +
        `?companyId=${encodeURIComponent(companyId.trim())}` +
        (branchId.trim()
          ? `&branchId=${encodeURIComponent(branchId.trim())}`
          : '') +
        (statusFilter ? `&status=${encodeURIComponent(statusFilter)}` : '')

      const response = await requestJson<ApiResponse<PosDevice[]>>(url)

      setDevices(response.data)
    } catch (currentError) {
      setDevices([])

      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل أجهزة POS.',
      )
    } finally {
      setLoading(false)
    }
  }

  async function loadPageData() {
    setLoading(true)
    setError('')

    try {
      await Promise.all([loadDevices(), loadBranches()])
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل بيانات الأجهزة.',
      )
    } finally {
      setLoading(false)
    }
  }

  async function createDevice() {
    if (saveLock.current) {
      return
    }

    saveLock.current = true
    setSaving(true)
    setError('')
    setSuccess('')

    try {
      if (!selectedBranchId) {
        throw new Error('اختر فرع الجهاز.')
      }

      if (!deviceName.trim()) {
        throw new Error('اسم الجهاز مطلوب.')
      }

      const response = await requestJson<ApiResponse<DeviceSecretResponse>>(
        '/api/pos-devices',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            companyId: companyId.trim(),
            branchId: selectedBranchId,
            deviceCode: deviceCode.trim() || null,
            deviceName: deviceName.trim(),
          }),
        },
      )

      setNewDeviceSecret(response.data.deviceSecret)

      setSecretDeviceName(response.data.device.device_name)

      setDeviceCode('')
      setDeviceName('')

      setSuccess(
        `تم تسجيل الجهاز ${response.data.device.device_name}. احفظ المفتاح السري الآن.`,
      )

      await loadDevices()
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تسجيل جهاز POS.',
      )
    } finally {
      saveLock.current = false
      setSaving(false)
    }
  }

  async function changeDeviceStatus(
    device: PosDevice,
    status: PosDevice['status'],
  ) {
    if (actionLock.current) {
      return
    }

    const actionLabel =
      status === 'blocked' ? 'حظر' : status === 'active' ? 'تفعيل' : 'إيقاف'

    const confirmed = window.confirm(
      `${actionLabel} الجهاز ${device.device_name}؟`,
    )

    if (!confirmed) {
      return
    }

    actionLock.current = true
    setRunningDeviceId(device.id)
    setError('')
    setSuccess('')

    try {
      await requestJson<ApiResponse<PosDevice>>(
        `/api/pos-devices/${encodeURIComponent(device.id)}/status`,
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

      setSuccess(`تم تحديث حالة الجهاز ${device.device_name}.`)

      await loadDevices()
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحديث حالة الجهاز.',
      )
    } finally {
      actionLock.current = false
      setRunningDeviceId(null)
    }
  }

  async function rotateDeviceSecret(device: PosDevice) {
    if (actionLock.current) {
      return
    }

    const confirmed = window.confirm(
      `سيتم إلغاء المفتاح السابق للجهاز ${device.device_name}. متابعة؟`,
    )

    if (!confirmed) {
      return
    }

    actionLock.current = true
    setRunningDeviceId(device.id)
    setError('')
    setSuccess('')

    try {
      const response = await requestJson<ApiResponse<DeviceSecretResponse>>(
        `/api/pos-devices/${encodeURIComponent(device.id)}/rotate-secret`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        },
      )

      setNewDeviceSecret(response.data.deviceSecret)

      setSecretDeviceName(device.device_name)

      setSuccess(`تم إنشاء مفتاح جديد للجهاز ${device.device_name}.`)

      await loadDevices()
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تدوير مفتاح الجهاز.',
      )
    } finally {
      actionLock.current = false
      setRunningDeviceId(null)
    }
  }

  async function copyDeviceSecret() {
    try {
      await navigator.clipboard.writeText(newDeviceSecret)

      setSuccess('تم نسخ مفتاح الجهاز.')
    } catch {
      setError('تعذر النسخ التلقائي. انسخ المفتاح يدويًا.')
    }
  }

  useEffect(() => {
    if (!canViewDevices || !companyId.trim()) {
      return
    }

    void loadPageData()
  }, [canViewDevices, canManageDevices, companyId, branchId])

  useEffect(() => {
    if (!canViewDevices || !companyId.trim()) {
      return
    }

    void loadDevices()
  }, [statusFilter])

  return (
    <>
      <section className="panel">
        <div className="section-header">
          <div>
            <h2>أجهزة نقاط البيع</h2>

            <p className="muted">
              تسجيل الأجهزة والتحكم في صلاحية اتصالها بالنظام.
            </p>
          </div>

          <button
            type="button"
            className="table-button"
            disabled={loading}
            onClick={() => void loadPageData()}
          >
            {loading ? 'جاري التحديث...' : 'تحديث الأجهزة'}
          </button>
        </div>

        {error ? <p className="error-message">{error}</p> : null}

        {success ? <p className="success-message">{success}</p> : null}
      </section>

      <section className="mini-cards-grid pos-device-summary-grid">
        <article className="mini-card">
          <span>إجمالي الأجهزة</span>
          <strong>{devices.length}</strong>
        </article>

        <article className="mini-card">
          <span>الأجهزة النشطة</span>
          <strong>{activeDevices}</strong>
        </article>

        <article className="mini-card">
          <span>الأجهزة المحظورة</span>
          <strong>{blockedDevices}</strong>
        </article>
      </section>

      {newDeviceSecret ? (
        <section className="panel pos-device-secret-panel">
          <div>
            <h2>مفتاح الجهاز السري</h2>

            <p>
              الجهاز: <strong>{secretDeviceName}</strong>
            </p>

            <p className="muted">
              يظهر هذا المفتاح مرة واحدة فقط. احفظه داخل إعدادات برنامج POS ولا
              ترسله عبر رسائل عامة.
            </p>
          </div>

          <code className="pos-device-secret">{newDeviceSecret}</code>

          <div className="section-actions">
            <button
              type="button"
              className="primary-button small-button"
              onClick={() => void copyDeviceSecret()}
            >
              نسخ المفتاح
            </button>

            <button
              type="button"
              className="table-button"
              onClick={() => {
                setNewDeviceSecret('')
                setSecretDeviceName('')
              }}
            >
              إخفاء
            </button>
          </div>
        </section>
      ) : null}

      {canManageDevices ? (
        <section className="panel">
          <div className="section-header">
            <div>
              <h2>تسجيل جهاز جديد</h2>

              <p className="muted">اربط كل جهاز بفرع واحد فقط.</p>
            </div>
          </div>

          <div className="form-grid pos-device-create-grid">
            <label>
              الفرع
              <select
                value={selectedBranchId}
                disabled={saving}
                onChange={(event) => setSelectedBranchId(event.target.value)}
              >
                <option value="">اختر الفرع</option>

                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name} ({branch.code})
                  </option>
                ))}
              </select>
            </label>

            <label>
              اسم الجهاز
              <input
                value={deviceName}
                disabled={saving}
                onChange={(event) => setDeviceName(event.target.value)}
                placeholder="مثال: كاشير الفرع الرئيسي 1"
              />
            </label>

            <label>
              كود الجهاز
              <input
                value={deviceCode}
                disabled={saving}
                onChange={(event) => setDeviceCode(event.target.value)}
                placeholder="اختياري — يولد تلقائيًا"
              />
            </label>
          </div>

          <div className="pos-device-create-footer">
            <button
              type="button"
              className="primary-button"
              disabled={saving || !selectedBranchId || !deviceName.trim()}
              onClick={() => void createDevice()}
            >
              {saving ? 'جاري تسجيل الجهاز...' : 'تسجيل الجهاز وإنشاء المفتاح'}
            </button>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="section-header">
          <div>
            <h2>الأجهزة المسجلة</h2>

            <p className="muted">
              المفتاح السري نفسه لا يتم عرضه أو تخزينه كنص داخل قاعدة البيانات.
            </p>
          </div>

          <label className="pos-device-status-filter">
            الحالة
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">كل الحالات</option>

              <option value="active">نشط</option>

              <option value="inactive">غير نشط</option>

              <option value="blocked">محظور</option>
            </select>
          </label>
        </div>

        {devices.length === 0 ? (
          <p className="muted">
            {loading ? 'جاري تحميل الأجهزة...' : 'لا توجد أجهزة مسجلة.'}
          </p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>الجهاز</th>
                  <th>الكود</th>
                  <th>الفرع</th>
                  <th>الحالة</th>
                  <th>آخر اتصال</th>
                  <th>تاريخ التسجيل</th>
                  <th>المفتاح</th>
                  {canManageDevices ? <th>الإجراءات</th> : null}
                </tr>
              </thead>

              <tbody>
                {devices.map((device) => (
                  <tr key={device.id}>
                    <td>
                      <strong>{device.device_name}</strong>
                    </td>

                    <td>{device.device_code}</td>

                    <td>{device.branch_name}</td>

                    <td>
                      <span className={deviceStatusClass(device.status)}>
                        {translateDeviceStatus(device.status)}
                      </span>
                    </td>

                    <td>{formatDeviceDate(device.last_seen_at)}</td>

                    <td>{formatDeviceDate(device.registered_at)}</td>

                    <td>{device.has_secret ? 'مُعيّن' : 'غير مُعيّن'}</td>

                    {canManageDevices ? (
                      <td>
                        <div className="pos-device-actions">
                          <button
                            type="button"
                            className="table-button"
                            disabled={runningDeviceId === device.id}
                            onClick={() => void rotateDeviceSecret(device)}
                          >
                            تدوير المفتاح
                          </button>

                          {device.status !== 'blocked' ? (
                            <button
                              type="button"
                              className="table-button danger-button"
                              disabled={runningDeviceId === device.id}
                              onClick={() =>
                                void changeDeviceStatus(device, 'blocked')
                              }
                            >
                              حظر
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="table-button"
                              disabled={runningDeviceId === device.id}
                              onClick={() =>
                                void changeDeviceStatus(device, 'active')
                              }
                            >
                              إعادة التفعيل
                            </button>
                          )}
                        </div>
                      </td>
                    ) : null}
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

export default PosDevicesPage
