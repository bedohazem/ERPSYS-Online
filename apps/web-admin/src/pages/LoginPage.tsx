import { useState } from 'react'

import type { FormEvent } from 'react'

import { useAuth } from '../auth/AuthContext'

function LoginPage() {
  const { login } = useAuth()

  const [companyCode, setCompanyCode] = useState('DEMO')

  const [username, setUsername] = useState('admin')

  const [password, setPassword] = useState('')

  const [submitting, setSubmitting] = useState(false)

  const [error, setError] = useState('')

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    setSubmitting(true)
    setError('')

    try {
      await login({
        companyCode,
        username,
        password,
      })
    } catch (currentError) {
      setError(
        currentError instanceof Error
          ? currentError.message
          : 'تعذر تسجيل الدخول',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="login-page">
      <section className="login-brand-panel">
        <div className="login-brand-content">
          <p className="login-eyebrow">ERPSYS Online</p>

          <h1>إدارة أعمالك من مكان واحد</h1>

          <p>
            نظام احترافي لإدارة الفروع والمخزون والمبيعات والمرتجعات والتقارير.
          </p>

          <div className="login-features">
            <article>
              <strong>PostgreSQL</strong>
              <span>مصدر الحقيقة الوحيد</span>
            </article>

            <article>
              <strong>Multi-Tenant</strong>
              <span>عزل كامل لبيانات الشركات</span>
            </article>

            <article>
              <strong>Secure Sessions</strong>
              <span>جلسات قابلة للإلغاء</span>
            </article>
          </div>
        </div>
      </section>

      <section className="login-form-panel">
        <form className="login-card" onSubmit={handleSubmit}>
          <div className="login-card-header">
            <div className="login-logo">E</div>

            <div>
              <h2>تسجيل الدخول</h2>
              <p>أدخل بيانات حسابك للوصول إلى لوحة الإدارة.</p>
            </div>
          </div>

          {error ? (
            <div className="login-error" role="alert">
              {error}
            </div>
          ) : null}

          <label className="login-field">
            <span>كود الشركة</span>

            <input
              value={companyCode}
              onChange={(event) => setCompanyCode(event.target.value)}
              autoComplete="organization"
              placeholder="مثال: DEMO"
              disabled={submitting}
              required
            />
          </label>

          <label className="login-field">
            <span>اسم المستخدم</span>

            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              placeholder="اسم المستخدم"
              disabled={submitting}
              required
            />
          </label>

          <label className="login-field">
            <span>كلمة المرور</span>

            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              placeholder="••••••••"
              disabled={submitting}
              required
              autoFocus
            />
          </label>

          <button
            type="submit"
            className="login-submit-button"
            disabled={
              submitting || !companyCode.trim() || !username.trim() || !password
            }
          >
            {submitting ? 'جاري تسجيل الدخول...' : 'دخول إلى النظام'}
          </button>

          <p className="login-security-note">
            يتم التحقق من الحساب وإنشاء جلسة آمنة قبل عرض بيانات الشركة.
          </p>
        </form>
      </section>
    </main>
  )
}

export default LoginPage
