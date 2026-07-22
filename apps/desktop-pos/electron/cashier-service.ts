import { safeStorage } from 'electron'
import { deleteSetting, getSetting, setSetting } from './local-store'

export type CashierSessionUser = {
  id: string
  fullName: string
  username: string

  companyId: string
  companyCode: string
  companyName: string

  branchId: string
  branchName: string | null

  roles: string[]
  permissions: string[]
}

export type PublicCashierSession = {
  expiresAt: string
  user: CashierSessionUser
}

export type PosStockLocation = {
  id: string
  code: string
  name: string
  location_type: string
}

export type PosWorkspaceBootstrap = {
  serverTime: string

  device: {
    deviceId: string
    companyId: string
    branchId: string
    deviceCode: string
    deviceName: string
    branchCode: string
    branchName: string
  }

  stockLocations: PosStockLocation[]

  cashier: PublicCashierSession
}

export type PosCatalogItem = {
  variant_id: string
  product_id: string
  product_name: string
  sku: string
  primary_barcode: string | null
  size_name: string | null
  color_name: string | null
  selling_price: string
  available_quantity: string
  stock_location_id: string
  stock_location_name: string
}

type StoredDeviceConfig = {
  serverUrl: string
  deviceId: string
  deviceSecret: string
}

type StoredCashierSession = {
  token: string
  tokenType: string
  expiresAt: string
  user: CashierSessionUser
}

type CashierLoginInput = {
  companyCode: string
  username: string
  password: string
}

type CatalogSearchInput = {
  stockLocationId: string
  query: string
}

const DEVICE_SERVER_URL_KEY = 'pos.device.server-url'

const DEVICE_ID_KEY = 'pos.device.id'

const DEVICE_SECRET_KEY = 'pos.device.encrypted-secret'

const CASHIER_SESSION_KEY = 'pos.cashier.encrypted-session'

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function readErrorMessage(responseBody: unknown, fallback: string) {
  if (
    typeof responseBody === 'object' &&
    responseBody !== null &&
    'error' in responseBody
  ) {
    const errorValue = (
      responseBody as {
        error?: unknown
      }
    ).error

    if (typeof errorValue === 'string' && errorValue.trim()) {
      return errorValue
    }
  }

  return fallback
}

async function requestJson(url: string, options: RequestInit) {
  const controller = new AbortController()

  const timeout = setTimeout(() => controller.abort(), 10_000)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    })

    const responseText = await response.text()

    let responseBody: unknown = null

    if (responseText) {
      try {
        responseBody = JSON.parse(responseText)
      } catch {
        responseBody = {
          error: responseText,
        }
      }
    }

    if (!response.ok) {
      throw new Error(
        readErrorMessage(responseBody, `Server error ${response.status}`),
      )
    }

    return responseBody
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('انتهت مهلة الاتصال بالسيرفر.')
    }

    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function decryptStoredValue(encryptedValue: string) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('التخزين الآمن غير متاح على هذا الجهاز.')
  }

  return safeStorage.decryptString(Buffer.from(encryptedValue, 'base64'))
}

function encryptStoredValue(plainValue: string) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('التخزين الآمن غير متاح على هذا الجهاز.')
  }

  return safeStorage.encryptString(plainValue).toString('base64')
}

function getDeviceConfig(): StoredDeviceConfig | null {
  const serverUrl = getSetting(DEVICE_SERVER_URL_KEY)

  const deviceId = getSetting(DEVICE_ID_KEY)

  const encryptedSecret = getSetting(DEVICE_SECRET_KEY)

  if (!serverUrl || !deviceId || !encryptedSecret) {
    return null
  }

  return {
    serverUrl,
    deviceId,
    deviceSecret: decryptStoredValue(encryptedSecret),
  }
}

function parseCashierSession(value: string): StoredCashierSession | null {
  try {
    const parsed = JSON.parse(value) as Partial<StoredCashierSession>

    if (
      typeof parsed.token !== 'string' ||
      !parsed.token ||
      typeof parsed.expiresAt !== 'string' ||
      typeof parsed.user !== 'object' ||
      parsed.user === null ||
      typeof parsed.user.id !== 'string' ||
      typeof parsed.user.companyId !== 'string' ||
      typeof parsed.user.branchId !== 'string'
    ) {
      return null
    }

    return parsed as StoredCashierSession
  } catch {
    return null
  }
}

function getStoredCashierSession(): StoredCashierSession | null {
  const encryptedSession = getSetting(CASHIER_SESSION_KEY)

  if (!encryptedSession) {
    return null
  }

  try {
    const session = parseCashierSession(decryptStoredValue(encryptedSession))

    if (!session) {
      deleteSetting(CASHIER_SESSION_KEY)
      return null
    }

    const expiresAt = new Date(session.expiresAt)

    if (
      Number.isNaN(expiresAt.getTime()) ||
      expiresAt.getTime() <= Date.now()
    ) {
      deleteSetting(CASHIER_SESSION_KEY)
      return null
    }

    return session
  } catch {
    deleteSetting(CASHIER_SESSION_KEY)
    return null
  }
}

function saveCashierSession(session: StoredCashierSession) {
  const encryptedSession = encryptStoredValue(JSON.stringify(session))

  setSetting(CASHIER_SESSION_KEY, encryptedSession)
}

export function clearCashierSession() {
  deleteSetting(CASHIER_SESSION_KEY)
}

export function getPublicCashierSession(): PublicCashierSession | null {
  const session = getStoredCashierSession()

  if (!session) {
    return null
  }

  return {
    expiresAt: session.expiresAt,
    user: session.user,
  }
}

async function requestDeviceBootstrap() {
  const config = getDeviceConfig()

  if (!config) {
    throw new Error('إعدادات جهاز POS غير مكتملة.')
  }

  return requestJson(`${config.serverUrl}/api/pos-sync/bootstrap`, {
    method: 'GET',

    headers: {
      Accept: 'application/json',

      'X-POS-Device-Id': config.deviceId,

      'X-POS-Device-Secret': config.deviceSecret,
    },
  }) as Promise<{
    data: Omit<PosWorkspaceBootstrap, 'cashier'>
  }>
}

async function requestCashierApi(apiPath: string) {
  const config = getDeviceConfig()

  const session = getStoredCashierSession()

  if (!config) {
    throw new Error('إعدادات جهاز POS غير مكتملة.')
  }

  if (!session) {
    throw new Error('يجب تسجيل دخول الكاشير أولًا.')
  }

  return requestJson(`${config.serverUrl}${apiPath}`, {
    method: 'GET',

    headers: {
      Accept: 'application/json',

      Authorization: `Bearer ${session.token}`,
    },
  })
}

export async function loginCashier(input: CashierLoginInput) {
  const config = getDeviceConfig()

  if (!config) {
    throw new Error('احفظ إعدادات الجهاز أولًا.')
  }

  const companyCode =
    typeof input?.companyCode === 'string' ? input.companyCode.trim() : ''

  const username =
    typeof input?.username === 'string' ? input.username.trim() : ''

  const password = typeof input?.password === 'string' ? input.password : ''

  if (!companyCode || !username || !password) {
    throw new Error('كود الشركة واسم المستخدم وكلمة المرور مطلوبة.')
  }

  const response = (await requestJson(`${config.serverUrl}/api/auth/login`, {
    method: 'POST',

    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },

    body: JSON.stringify({
      companyCode,
      username,
      password,
      sessionName: `Desktop POS ${config.deviceId}`,
    }),
  })) as {
    data?: {
      token?: unknown
      tokenType?: unknown
      expiresAt?: unknown
      user?: Partial<CashierSessionUser>
    }
  }

  const loginData = response.data
  const user = loginData?.user

  if (
    typeof loginData?.token !== 'string' ||
    typeof loginData.expiresAt !== 'string' ||
    !user ||
    typeof user.id !== 'string' ||
    typeof user.companyId !== 'string' ||
    typeof user.branchId !== 'string'
  ) {
    throw new Error('استجابة تسجيل دخول الكاشير غير مكتملة.')
  }

  const roles = Array.isArray(user.roles) ? user.roles : []

  const permissions = Array.isArray(user.permissions) ? user.permissions : []

  const canCreateSales =
    roles.includes('admin') || permissions.includes('sales.create')

  if (!canCreateSales) {
    throw new Error('المستخدم لا يملك صلاحية إنشاء المبيعات.')
  }

  const bootstrap = await requestDeviceBootstrap()

  if (
    bootstrap.data.device.companyId !== user.companyId ||
    bootstrap.data.device.branchId !== user.branchId
  ) {
    throw new Error('الكاشير لا يتبع نفس شركة وفرع جهاز POS.')
  }

  const storedSession: StoredCashierSession = {
    token: loginData.token,

    tokenType:
      typeof loginData.tokenType === 'string' ? loginData.tokenType : 'Bearer',

    expiresAt: loginData.expiresAt,

    user: {
      id: user.id,

      fullName: typeof user.fullName === 'string' ? user.fullName : username,

      username: typeof user.username === 'string' ? user.username : username,

      companyId: user.companyId,

      companyCode:
        typeof user.companyCode === 'string' ? user.companyCode : companyCode,

      companyName: typeof user.companyName === 'string' ? user.companyName : '',

      branchId: user.branchId,

      branchName: typeof user.branchName === 'string' ? user.branchName : null,

      roles,
      permissions,
    },
  }

  saveCashierSession(storedSession)

  return getPublicCashierSession()
}

export async function logoutCashier() {
  const config = getDeviceConfig()

  const session = getStoredCashierSession()

  clearCashierSession()

  if (!config || !session) {
    return null
  }

  try {
    await requestJson(`${config.serverUrl}/api/auth/logout`, {
      method: 'POST',

      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${session.token}`,
      },
    })
  } catch {
    // الخروج المحلي يجب أن ينجح حتى لو السيرفر Offline.
  }

  return null
}

export async function loadPosWorkspace(): Promise<PosWorkspaceBootstrap> {
  const cashier = getPublicCashierSession()

  if (!cashier) {
    throw new Error('يجب تسجيل دخول الكاشير أولًا.')
  }

  const bootstrap = await requestDeviceBootstrap()

  if (
    bootstrap.data.device.companyId !== cashier.user.companyId ||
    bootstrap.data.device.branchId !== cashier.user.branchId
  ) {
    clearCashierSession()

    throw new Error('جلسة الكاشير لا تطابق جهاز POS.')
  }

  return {
    ...bootstrap.data,
    cashier,
  }
}

export async function searchPosCatalog(input: CatalogSearchInput) {
  const session = getStoredCashierSession()

  if (!session) {
    throw new Error('يجب تسجيل دخول الكاشير أولًا.')
  }

  const stockLocationId =
    typeof input?.stockLocationId === 'string'
      ? input.stockLocationId.trim()
      : ''

  const query = typeof input?.query === 'string' ? input.query.trim() : ''

  if (!uuidPattern.test(stockLocationId)) {
    throw new Error('مكان البيع غير صالح.')
  }

  if (!query) {
    throw new Error('اكتب اسم الصنف أو SKU أو الباركود.')
  }

  const searchParams = new URLSearchParams({
    companyId: session.user.companyId,

    branchId: session.user.branchId,

    stockLocationId,
    q: query,
  })

  const response = (await requestCashierApi(
    `/api/pos/search-items?${searchParams.toString()}`,
  )) as {
    data?: PosCatalogItem[]
  }

  return Array.isArray(response.data) ? response.data : []
}

export async function lookupPosCatalogItem(input: CatalogSearchInput) {
  const session = getStoredCashierSession()

  if (!session) {
    throw new Error('يجب تسجيل دخول الكاشير أولًا.')
  }

  const stockLocationId =
    typeof input?.stockLocationId === 'string'
      ? input.stockLocationId.trim()
      : ''

  const query = typeof input?.query === 'string' ? input.query.trim() : ''

  if (!uuidPattern.test(stockLocationId)) {
    throw new Error('مكان البيع غير صالح.')
  }

  if (!query) {
    throw new Error('اكتب الباركود أو SKU.')
  }

  const searchParams = new URLSearchParams({
    companyId: session.user.companyId,

    branchId: session.user.branchId,

    stockLocationId,
    code: query,
  })

  const response = (await requestCashierApi(
    `/api/pos/lookup-item?${searchParams.toString()}`,
  )) as {
    data?: PosCatalogItem
  }

  if (!response.data) {
    throw new Error('لم يتم العثور على الصنف.')
  }

  return response.data
}
