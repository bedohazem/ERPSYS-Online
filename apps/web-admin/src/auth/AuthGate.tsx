import type { ReactNode } from 'react'

import LoginPage from '../pages/LoginPage'
import { useAuth } from './AuthContext'

type AuthGateProps = {
  children: ReactNode
}

function AuthGate({ children }: AuthGateProps) {
  const { user, loading } = useAuth()

  // أثناء فحص Session القديمة لا نظهر Login للحظة قصيرة.
  if (loading) {
    return (
      <main className="auth-loading-page">
        <div className="auth-loading-card">
          <div className="auth-loading-logo">E</div>

          <strong>جاري التحقق من الجلسة</strong>

          <span>برجاء الانتظار...</span>
        </div>
      </main>
    )
  }

  if (!user) {
    return <LoginPage />
  }

  return <>{children}</>
}

export default AuthGate
