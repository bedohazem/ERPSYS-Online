import { createContext, useContext, useEffect, useState } from 'react'

import type { ReactNode } from 'react'

import {
  AUTH_UNAUTHORIZED_EVENT,
  ApiError,
  clearStoredAuthToken,
  getStoredAuthToken,
  requestJson,
  setStoredAuthToken,
} from '../lib/http'

// ======================================================
// بيانات المستخدم الموثق
// ======================================================

export type AuthUser = {
  userId: string
  fullName: string
  username: string

  companyId: string
  companyCode: string
  companyName: string | null

  branchId: string | null
  branchName: string | null

  roles: string[]
  permissions: string[]

  expiresAt: string
}

type LoginInput = {
  companyCode: string
  username: string
  password: string
}

type LoginResponse = {
  data: {
    token: string
    tokenType: string
    expiresAt: string

    user: {
      id: string
      fullName: string
      username: string

      companyId: string
      companyCode: string
      companyName: string

      branchId: string | null
      branchName: string | null

      roles: string[]
      permissions: string[]
    }
  }
}

type CurrentUserResponse = {
  data: {
    userId: string
    fullName: string
    username: string

    companyId: string
    companyCode: string

    branchId: string | null
    branchName: string | null

    roles: string[]
    permissions: string[]

    expiresAt: string
  }
}

type AuthContextValue = {
  user: AuthUser | null
  loading: boolean

  login: (input: LoginInput) => Promise<void>

  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

type AuthProviderProps = {
  children: ReactNode
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null)

  const [loading, setLoading] = useState(true)

  // ====================================================
  // استرجاع Session عند فتح البرنامج
  // ====================================================
  useEffect(() => {
    let active = true

    async function restoreSession() {
      const token = getStoredAuthToken()

      if (!token) {
        if (active) {
          setLoading(false)
        }

        return
      }

      try {
        const response = await requestJson<CurrentUserResponse>('/api/auth/me')

        if (!active) {
          return
        }

        setUser({
          ...response.data,

          // /me لا يحتاج حاليًا لإرجاع اسم الشركة.
          // يمكن إضافته لاحقًا من Backend.
          companyName: null,
        })
      } catch {
        // أي Session غير صالحة يتم حذفها.
        clearStoredAuthToken()

        if (active) {
          setUser(null)
        }
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }

    void restoreSession()

    return () => {
      active = false
    }
  }, [])

  // ====================================================
  // استقبال حدث انتهاء Session من HTTP Layer
  // ====================================================
  useEffect(() => {
    function handleUnauthorized() {
      clearStoredAuthToken()
      setUser(null)
      setLoading(false)
    }

    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, handleUnauthorized)

    return () => {
      window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, handleUnauthorized)
    }
  }, [])

  // ====================================================
  // Login
  // ====================================================
  async function login(input: LoginInput) {
    const response = await requestJson<LoginResponse>('/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        companyCode: input.companyCode.trim(),

        username: input.username.trim(),

        password: input.password,

        sessionName: 'Web Admin',
      }),
    })

    const loginUser = response.data.user

    setStoredAuthToken(response.data.token)

    setUser({
      userId: loginUser.id,
      fullName: loginUser.fullName,
      username: loginUser.username,

      companyId: loginUser.companyId,

      companyCode: loginUser.companyCode,

      companyName: loginUser.companyName,

      branchId: loginUser.branchId,

      branchName: loginUser.branchName,

      roles: loginUser.roles,

      permissions: loginUser.permissions,

      expiresAt: response.data.expiresAt,
    })
  }

  // ====================================================
  // Logout
  // ====================================================
  async function logout() {
    try {
      if (getStoredAuthToken()) {
        await requestJson<null>('/api/auth/logout', {
          method: 'POST',
        })
      }
    } catch (error) {
      // حتى لو السيرفر غير متاح نمسح الجلسة المحلية.
      // Session السيرفر ستنتهي تلقائيًا حسب expires_at.
      if (error instanceof ApiError && error.status !== 401) {
        console.error(error)
      }
    } finally {
      clearStoredAuthToken()
      setUser(null)
    }
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

// ======================================================
// useAuth
// ======================================================
export function useAuth() {
  const context = useContext(AuthContext)

  if (!context) {
    throw new Error('useAuth must be used inside AuthProvider')
  }

  return context
}
