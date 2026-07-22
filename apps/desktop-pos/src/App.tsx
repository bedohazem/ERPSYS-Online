import { useEffect, useState } from 'react'

function formatDate(value: string) {
  const parsedDate = new Date(value)

  if (Number.isNaN(parsedDate.getTime())) {
    return '-'
  }

  return new Intl.DateTimeFormat('ar-EG', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsedDate)
}

function App() {
  const [appState, setAppState] = useState<DesktopPosState | null>(null)

  const [pendingSales, setPendingSales] = useState<DesktopPendingSale[]>([])

  const [serverUrl, setServerUrl] = useState('http://localhost:3000')

  const [deviceId, setDeviceId] = useState('')

  const [deviceSecret, setDeviceSecret] = useState('')

  const [connectionStatus, setConnectionStatus] = useState<
    'unknown' | 'online' | 'offline'
  >('unknown')

  const [bootstrapResult, setBootstrapResult] = useState<unknown>(null)

  const [loading, setLoading] = useState(false)

  const [error, setError] = useState('')

  const [success, setSuccess] = useState('')

  async function loadLocalState() {
    const [state, localPendingSales] = await Promise.all([
      window.desktopPos.getState(),
      window.desktopPos.listPendingSales(),
    ])

    setAppState(state)

    setServerUrl(state.serverUrl || 'http://localhost:3000')

    setDeviceId(state.deviceId || '')

    setPendingSales(localPendingSales)
  }

  async function saveConfiguration() {
    setLoading(true)
    setError('')
    setSuccess('')

    try {
      const nextState = await window.desktopPos.saveDeviceConfig({
        serverUrl,
        deviceId,
        deviceSecret,
      })

      setAppState(nextState)
      setDeviceSecret('')

      setSuccess('تم حفظ إعدادات الجهاز بشكل آمن.')
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر حفظ إعدادات الجهاز.',
      )
    } finally {
      setLoading(false)
    }
  }

  async function clearConfiguration() {
    const confirmed = window.confirm('حذف إعدادات اتصال جهاز POS؟')

    if (!confirmed) {
      return
    }

    setLoading(true)
    setError('')
    setSuccess('')

    try {
      const nextState = await window.desktopPos.clearDeviceConfig()

      setAppState(nextState)

      setServerUrl('http://localhost:3000')

      setDeviceId('')
      setDeviceSecret('')

      setConnectionStatus('unknown')

      setBootstrapResult(null)

      setSuccess('تم حذف إعدادات الجهاز.')
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر حذف إعدادات الجهاز.',
      )
    } finally {
      setLoading(false)
    }
  }

  async function testConnection() {
    setLoading(true)
    setError('')
    setSuccess('')

    try {
      await window.desktopPos.heartbeat()

      setConnectionStatus('online')

      setSuccess('تم الاتصال بالسيرفر بنجاح.')
    } catch (currentError) {
      setConnectionStatus('offline')

      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر الاتصال بالسيرفر.',
      )
    } finally {
      setLoading(false)
    }
  }

  async function loadBootstrap() {
    setLoading(true)
    setError('')
    setSuccess('')

    try {
      const result = await window.desktopPos.bootstrap()

      setBootstrapResult(result)
      setConnectionStatus('online')

      setSuccess('تم تحميل بيانات الجهاز والفرع.')
    } catch (currentError) {
      setConnectionStatus('offline')

      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تحميل بيانات الجهاز.',
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadLocalState().catch((currentError) => {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر فتح قاعدة البيانات المحلية.',
      )
    })
  }, [])

  return (
    <main className="desktop-pos-app">
      <header className="desktop-pos-header">
        <div>
          <span className="desktop-pos-eyebrow">ERPSYS Online</span>

          <h1>Desktop POS</h1>

          <p>جهاز بيع يعمل Online وOffline ويحفظ المبيعات المؤجلة فقط.</p>
        </div>

        <div className={`connection-indicator connection-${connectionStatus}`}>
          <span />

          {connectionStatus === 'online'
            ? 'متصل'
            : connectionStatus === 'offline'
              ? 'غير متصل'
              : 'لم يتم الفحص'}
        </div>
      </header>

      {error ? <p className="desktop-message desktop-error">{error}</p> : null}

      {success ? (
        <p className="desktop-message desktop-success">{success}</p>
      ) : null}

      <section className="desktop-summary-grid">
        <article className="desktop-card">
          <span>إعداد الجهاز</span>

          <strong>{appState?.configured ? 'مكتمل' : 'غير مكتمل'}</strong>
        </article>

        <article className="desktop-card">
          <span>المبيعات المؤجلة</span>

          <strong>{appState?.pendingSalesCount ?? 0}</strong>
        </article>

        <article className="desktop-card">
          <span>إصدار التطبيق</span>

          <strong>{appState?.appVersion || '-'}</strong>
        </article>
      </section>

      <section className="desktop-panel">
        <div className="desktop-section-header">
          <div>
            <h2>إعداد اتصال الجهاز</h2>

            <p>استخدم Device ID والمفتاح اللذين تم إنشاؤهما من Web Admin.</p>
          </div>
        </div>

        <div className="desktop-form-grid">
          <label>
            عنوان السيرفر
            <input
              value={serverUrl}
              disabled={loading}
              onChange={(event) => setServerUrl(event.target.value)}
              placeholder="http://localhost:3000"
              dir="ltr"
            />
          </label>

          <label>
            Device ID
            <input
              value={deviceId}
              disabled={loading}
              onChange={(event) => setDeviceId(event.target.value)}
              placeholder="UUID"
              dir="ltr"
            />
          </label>

          <label>
            مفتاح الجهاز السري
            <input
              type="password"
              value={deviceSecret}
              disabled={loading}
              onChange={(event) => setDeviceSecret(event.target.value)}
              placeholder={
                appState?.hasDeviceSecret
                  ? 'أدخل المفتاح فقط عند تغييره'
                  : '64 Hex Characters'
              }
              dir="ltr"
            />
          </label>
        </div>

        <div className="desktop-actions">
          <button
            type="button"
            className="desktop-primary-button"
            disabled={
              loading ||
              !serverUrl.trim() ||
              !deviceId.trim() ||
              !deviceSecret.trim()
            }
            onClick={() => void saveConfiguration()}
          >
            حفظ إعدادات الجهاز
          </button>

          <button
            type="button"
            disabled={loading || !appState?.configured}
            onClick={() => void testConnection()}
          >
            اختبار الاتصال
          </button>

          <button
            type="button"
            disabled={loading || !appState?.configured}
            onClick={() => void loadBootstrap()}
          >
            تحميل Bootstrap
          </button>

          <button
            type="button"
            className="desktop-danger-button"
            disabled={loading || !appState?.configured}
            onClick={() => void clearConfiguration()}
          >
            حذف الإعدادات
          </button>
        </div>
      </section>

      <section className="desktop-panel">
        <div className="desktop-section-header">
          <div>
            <h2>المبيعات المحلية المؤجلة</h2>

            <p>لا يتم خصم أي مخزون داخل SQLite.</p>
          </div>

          <span className="desktop-count-badge">
            {pendingSales.length} عملية
          </span>
        </div>

        {pendingSales.length === 0 ? (
          <p className="desktop-empty-state">لا توجد مبيعات مؤجلة حاليًا.</p>
        ) : (
          <div className="desktop-table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Local Sale ID</th>
                  <th>الحالة</th>
                  <th>المحاولات</th>
                  <th>آخر خطأ</th>
                  <th>تاريخ الإنشاء</th>
                </tr>
              </thead>

              <tbody>
                {pendingSales.map((sale) => (
                  <tr key={sale.id}>
                    <td>{sale.localSaleId}</td>

                    <td>{sale.status}</td>

                    <td>{sale.attemptCount}</td>

                    <td>{sale.lastError || '-'}</td>

                    <td>{formatDate(sale.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {bootstrapResult ? (
        <section className="desktop-panel">
          <div className="desktop-section-header">
            <div>
              <h2>Bootstrap Result</h2>

              <p>بيانات الجهاز والفرع وأماكن البيع المسموحة.</p>
            </div>
          </div>

          <pre className="desktop-json">
            {JSON.stringify(bootstrapResult, null, 2)}
          </pre>
        </section>
      ) : null}
    </main>
  )
}

export default App
