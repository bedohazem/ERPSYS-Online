import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import './index.css'

import { AuthProvider } from './auth/AuthContext'

import AuthGate from './auth/AuthGate'

import { installAuthenticatedFetch } from './lib/http'

// ======================================================
// تركيب HTTP Layer قبل تشغيل React.
//
// بهذا الشكل كل fetch موجود حاليًا داخل الصفحات
// يحصل تلقائيًا على Bearer Token.
// ======================================================
installAuthenticatedFetch()

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Root element was not found')
}

createRoot(rootElement).render(
  <StrictMode>
    <AuthProvider>
      <AuthGate>
        <App />
      </AuthGate>
    </AuthProvider>
  </StrictMode>,
)
