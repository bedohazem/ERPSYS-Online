// ======================================================
// إعدادات Backend API
//
// يمكن لاحقًا وضع VITE_API_BASE_URL داخل ملف .env
// عند رفع النظام على سيرفر حقيقي.
// ======================================================

export const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000'
).replace(/\/+$/, '')

const AUTH_TOKEN_STORAGE_KEY = 'erpsys.web-admin.auth-token'

export const AUTH_UNAUTHORIZED_EVENT = 'erpsys:auth-unauthorized'

// ======================================================
// ApiError
//
// يحتفظ برسالة الخطأ وHTTP Status لتمييز:
// 401 Unauthorized
// 400 Validation Error
// 500 Server Error
// ======================================================
export class ApiError extends Error {
  status: number
  data: unknown

  constructor(status: number, message: string, data: unknown) {
    super(message)

    this.status = status
    this.data = data
  }
}

// ======================================================
// Token Storage
// ======================================================

export function getStoredAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)
}

export function setStoredAuthToken(token: string) {
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token)
}

export function clearStoredAuthToken() {
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY)
}

// ======================================================
// Global Fetch Installation
//
// المشروع الحالي يحتوي fetch داخل أكثر من صفحة.
// الطبقة التالية تضيف Authorization لكل طلب API
// بدون تعديل كل صفحة بشكل منفصل.
//
// لاحقًا يمكن نقل كل الطلبات إلى API Client موحد.
// ======================================================

type ErpsysWindow = Window & {
  __ERPSYS_NATIVE_FETCH__?: typeof window.fetch
  __ERPSYS_AUTH_FETCH_INSTALLED__?: boolean
}

export function installAuthenticatedFetch() {
  const erpsysWindow = window as ErpsysWindow

  // الاحتفاظ بالنسخة الأصلية من fetch مرة واحدة فقط.
  if (!erpsysWindow.__ERPSYS_NATIVE_FETCH__) {
    erpsysWindow.__ERPSYS_NATIVE_FETCH__ = window.fetch.bind(window)
  }

  // منع تركيب الـ Wrapper أكثر من مرة أثناء Vite HMR.
  if (erpsysWindow.__ERPSYS_AUTH_FETCH_INSTALLED__) {
    return
  }

  erpsysWindow.__ERPSYS_AUTH_FETCH_INSTALLED__ = true

  const nativeFetch = erpsysWindow.__ERPSYS_NATIVE_FETCH__

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl =
      typeof input === 'string' || input instanceof URL
        ? input.toString()
        : input.url

    const requestUrl = new URL(rawUrl, window.location.origin)

    const configuredApiUrl = new URL(API_BASE_URL, window.location.origin)

    const isApiRequest =
      requestUrl.origin === configuredApiUrl.origin &&
      requestUrl.pathname.startsWith('/api/')

    if (!isApiRequest) {
      return nativeFetch(input, init)
    }

    const existingHeaders = input instanceof Request ? input.headers : undefined

    const headers = new Headers(init?.headers || existingHeaders)

    const token = getStoredAuthToken()

    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`)
    }

    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/json')
    }

    const response = await nativeFetch(input, {
      ...init,
      headers,
    })

    const isLoginRequest = requestUrl.pathname === '/api/auth/login'

    // عند انتهاء Session نمسح التوكن ونفتح Login.
    // لا ننفذ ذلك عند فشل محاولة تسجيل الدخول نفسها.
    if (response.status === 401 && token && !isLoginRequest) {
      clearStoredAuthToken()

      window.dispatchEvent(new CustomEvent(AUTH_UNAUTHORIZED_EVENT))
    }

    return response
  }
}

// ======================================================
// requestJson
//
// دالة موحدة للطلبات الجديدة مثل Login وLogout و/me.
// ======================================================
export async function requestJson<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  // ======================================================
  // دعم المسار النسبي والرابط الكامل
  //
  // أمثلة صالحة:
  // /api/products
  // http://localhost:3000/api/products
  //
  // هذا يمنع تكرار API_BASE_URL لو الصفحة أرسلت
  // رابطًا كاملًا أثناء مرحلة نقل الكود للـ Shared Client.
  // ======================================================
  const requestUrl = /^https?:\/\//i.test(path)
    ? path
    : `${API_BASE_URL}${path}`

  const response = await window.fetch(requestUrl, options)

  const responseText = await response.text()

  let responseData: unknown = null

  if (responseText) {
    try {
      responseData = JSON.parse(responseText)
    } catch {
      responseData = {
        error: responseText,
      }
    }
  }

  if (!response.ok) {
    const errorData = responseData as { error?: string } | null

    throw new ApiError(
      response.status,
      errorData?.error || 'Request failed',
      responseData,
    )
  }

  return responseData as T
}
