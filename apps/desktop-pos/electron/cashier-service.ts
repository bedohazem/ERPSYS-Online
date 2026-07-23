import { safeStorage } from 'electron'
import {
  deleteSetting,
  getCatalogCacheInfo,
  getSetting,
  lookupCatalogCacheItem,
  replaceCatalogCache,
  searchCatalogCache,
  setSetting,
  type CatalogCacheInfo,
  type CatalogCacheItemInput,
  type CatalogCacheItemRecord,
  getWorkspaceCache,
  saveWorkspaceCache,
} from './local-store'

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

  cashierGrantId: string
  cashierGrantExpiresAt: string

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
  catalogCache: CatalogCacheInfo
  workspaceSource: 'server' | 'cache'
  workspaceCachedAt: string
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
  available_quantity: string | null
  stock_location_id: string
  stock_location_name: string
  catalog_source: 'server' | 'cache'
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

  cashierGrantId: string
  cashierGrantExpiresAt: string

  user: CashierSessionUser
}

type StoredCashierGrant = {
  grantId: string
  grantToken: string

  issuedAt: string
  expiresAt: string

  cashierId: string
  deviceId: string
  companyId: string
  branchId: string
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

type CatalogSnapshotItem = {
  variant_id: string
  product_id: string
  product_name: string
  sku: string
  primary_barcode: string | null
  size_name: string | null
  color_name: string | null
  selling_price: string
  barcodes: string[]
}

class PosConnectionError extends Error {}

const DEVICE_SERVER_URL_KEY = 'pos.device.server-url'

const DEVICE_ID_KEY = 'pos.device.id'

const DEVICE_SECRET_KEY = 'pos.device.encrypted-secret'

const CASHIER_SESSION_KEY = 'pos.cashier.encrypted-session'

const CASHIER_GRANTS_KEY = 'pos.cashier.encrypted-grants'

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
      throw new PosConnectionError('انتهت مهلة الاتصال بالسيرفر.')
    }

    if (error instanceof TypeError && error.message === 'fetch failed') {
      throw new PosConnectionError(
        'تعذر الاتصال بالسيرفر. تأكد أن API يعمل وأن عنوان السيرفر صحيح.',
      )
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
      typeof parsed.cashierGrantId !== 'string' ||
      !uuidPattern.test(parsed.cashierGrantId) ||
      typeof parsed.cashierGrantExpiresAt !== 'string' ||
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

    // جلسة الـ Bearer قد تنتهي قبل تصريح Offline.
    // نحتفظ بهوية الكاشير محليًا حتى انتهاء المنحة.
    const grantExpiresAt = new Date(session.cashierGrantExpiresAt)

    if (
      Number.isNaN(grantExpiresAt.getTime()) ||
      grantExpiresAt.getTime() <= Date.now()
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

function parseCashierGrants(value: string): StoredCashierGrant[] {
  try {
    const parsed = JSON.parse(value) as unknown

    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.filter((value): value is StoredCashierGrant => {
      if (typeof value !== 'object' || value === null) {
        return false
      }

      const grant = value as Partial<StoredCashierGrant>

      return (
        typeof grant.grantId === 'string' &&
        uuidPattern.test(grant.grantId) &&
        typeof grant.grantToken === 'string' &&
        /^[0-9a-f]{64}$/i.test(grant.grantToken) &&
        typeof grant.issuedAt === 'string' &&
        typeof grant.expiresAt === 'string' &&
        typeof grant.cashierId === 'string' &&
        typeof grant.deviceId === 'string' &&
        typeof grant.companyId === 'string' &&
        typeof grant.branchId === 'string'
      )
    })
  } catch {
    return []
  }
}

function getStoredCashierGrants(): StoredCashierGrant[] {
  const encryptedGrants = getSetting(CASHIER_GRANTS_KEY)

  if (!encryptedGrants) {
    return []
  }

  try {
    return parseCashierGrants(decryptStoredValue(encryptedGrants))
  } catch {
    deleteSetting(CASHIER_GRANTS_KEY)

    return []
  }
}

function saveCashierGrants(grants: StoredCashierGrant[]) {
  if (grants.length === 0) {
    deleteSetting(CASHIER_GRANTS_KEY)

    return
  }

  setSetting(
    CASHIER_GRANTS_KEY,

    encryptStoredValue(JSON.stringify(grants)),
  )
}

function saveCashierGrant(grant: StoredCashierGrant) {
  const currentGrants = getStoredCashierGrants()

  const nextGrants = [
    ...currentGrants.filter(
      (currentGrant) => currentGrant.grantId !== grant.grantId,
    ),

    grant,
  ]

  saveCashierGrants(nextGrants)
}

export function clearCashierGrants() {
  deleteSetting(CASHIER_GRANTS_KEY)
}

export function getCashierGrantToken(grantId: string) {
  if (!uuidPattern.test(grantId)) {
    return null
  }

  const grant = getStoredCashierGrants().find(
    (currentGrant) => currentGrant.grantId === grantId,
  )

  return grant?.grantToken ?? null
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

    cashierGrantId: session.cashierGrantId,

    cashierGrantExpiresAt: session.cashierGrantExpiresAt,

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
    data: Pick<
      PosWorkspaceBootstrap,
      'serverTime' | 'device' | 'stockLocations'
    >
  }>
}

async function issueCashierGrant(
  config: StoredDeviceConfig,
  bearerToken: string,
) {
  const response = (await requestJson(
    `${config.serverUrl}/api/pos-sync/cashier-grants`,
    {
      method: 'POST',

      headers: {
        Accept: 'application/json',

        'Content-Type': 'application/json',

        Authorization: `Bearer ${bearerToken}`,

        'X-POS-Device-Id': config.deviceId,

        'X-POS-Device-Secret': config.deviceSecret,
      },
    },
  )) as {
    data?: {
      grantId?: unknown
      grantToken?: unknown
      issuedAt?: unknown
      expiresAt?: unknown
      cashierId?: unknown
      deviceId?: unknown
    }
  }

  const grant = response.data

  if (
    !grant ||
    typeof grant.grantId !== 'string' ||
    !uuidPattern.test(grant.grantId) ||
    typeof grant.grantToken !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(grant.grantToken) ||
    typeof grant.issuedAt !== 'string' ||
    typeof grant.expiresAt !== 'string' ||
    typeof grant.cashierId !== 'string' ||
    typeof grant.deviceId !== 'string'
  ) {
    throw new Error('استجابة تصريح الكاشير Offline غير مكتملة.')
  }

  return {
    grantId: grant.grantId,
    grantToken: grant.grantToken,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    cashierId: grant.cashierId,
    deviceId: grant.deviceId,
  }
}

async function refreshCatalogCache() {
  const config = getDeviceConfig()

  if (!config) {
    throw new Error('إعدادات جهاز POS غير مكتملة.')
  }

  const response = (await requestJson(
    `${config.serverUrl}/api/pos-sync/catalog`,
    {
      method: 'GET',

      headers: {
        Accept: 'application/json',

        'X-POS-Device-Id': config.deviceId,

        'X-POS-Device-Secret': config.deviceSecret,
      },
    },
  )) as {
    data?: {
      serverTime?: string
      items?: CatalogSnapshotItem[]
    }
  }

  if (
    typeof response.data?.serverTime !== 'string' ||
    !Array.isArray(response.data.items)
  ) {
    throw new Error('استجابة كتالوج POS غير مكتملة.')
  }

  const items: CatalogCacheItemInput[] = response.data.items.map((item) => ({
    variantId: item.variant_id,

    productId: item.product_id,

    productName: item.product_name,

    sku: item.sku,

    primaryBarcode: item.primary_barcode,

    sizeName: item.size_name,

    colorName: item.color_name,

    sellingPrice: String(item.selling_price),

    barcodes: Array.isArray(item.barcodes) ? item.barcodes : [],
  }))

  return replaceCatalogCache(items, response.data.serverTime)
}

function mapCachedCatalogItem(
  item: CatalogCacheItemRecord,
  stockLocationId: string,
): PosCatalogItem {
  return {
    variant_id: item.variantId,
    product_id: item.productId,

    product_name: item.productName,

    sku: item.sku,

    primary_barcode: item.primaryBarcode,

    size_name: item.sizeName,
    color_name: item.colorName,

    selling_price: item.sellingPrice,

    // الكميات لا تحفظ محليًا.
    available_quantity: null,

    stock_location_id: stockLocationId,

    stock_location_name: '',

    catalog_source: 'cache',
  }
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

  const cashierGrant = await issueCashierGrant(config, loginData.token)

  if (
    cashierGrant.cashierId !== user.id ||
    cashierGrant.deviceId !== config.deviceId
  ) {
    throw new Error('تصريح الكاشير لا يطابق المستخدم أو جهاز POS.')
  }

  saveCashierGrant({
    grantId: cashierGrant.grantId,

    grantToken: cashierGrant.grantToken,

    issuedAt: cashierGrant.issuedAt,

    expiresAt: cashierGrant.expiresAt,

    cashierId: user.id,
    deviceId: config.deviceId,

    companyId: user.companyId,
    branchId: user.branchId,
  })

  const storedSession: StoredCashierSession = {
    token: loginData.token,

    tokenType:
      typeof loginData.tokenType === 'string' ? loginData.tokenType : 'Bearer',

    expiresAt: loginData.expiresAt,

    cashierGrantId: cashierGrant.grantId,

    cashierGrantExpiresAt: cashierGrant.expiresAt,

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

  const cachedWorkspace = getWorkspaceCache()

  let bootstrap: Awaited<ReturnType<typeof requestDeviceBootstrap>>

  try {
    bootstrap = await requestDeviceBootstrap()
  } catch (error) {
    if (!(error instanceof PosConnectionError)) {
      throw error
    }

    if (!cachedWorkspace) {
      throw new Error(
        'تعذر الاتصال بالسيرفر ولا توجد مساحة عمل محلية محفوظة. شغّل السيرفر واضغط تحديث البيانات مرة واحدة.',
      )
    }

    if (
      cachedWorkspace.device.companyId !== cashier.user.companyId ||
      cachedWorkspace.device.branchId !== cashier.user.branchId
    ) {
      clearCashierSession()

      throw new Error('جلسة الكاشير لا تطابق مساحة العمل المحلية المحفوظة.')
    }

    const catalogCache = getCatalogCacheInfo()

    if (catalogCache.itemCount === 0) {
      throw new Error(
        'لا يوجد كتالوج محلي محفوظ. اتصل بالسيرفر واضغط تحديث البيانات أولًا.',
      )
    }

    return {
      serverTime: cachedWorkspace.serverTime,

      device: cachedWorkspace.device,

      stockLocations: cachedWorkspace.stockLocations,

      cashier,
      catalogCache,

      workspaceSource: 'cache',

      workspaceCachedAt: cachedWorkspace.cachedAt,
    }
  }

  if (
    bootstrap.data.device.companyId !== cashier.user.companyId ||
    bootstrap.data.device.branchId !== cashier.user.branchId
  ) {
    clearCashierSession()

    throw new Error('جلسة الكاشير لا تطابق جهاز POS.')
  }

  const savedWorkspace = saveWorkspaceCache({
    serverTime: bootstrap.data.serverTime,

    device: bootstrap.data.device,

    stockLocations: bootstrap.data.stockLocations,
  })

  let catalogCache = getCatalogCacheInfo()

  try {
    catalogCache = await refreshCatalogCache()
  } catch (error) {
    // نسخة الكتالوج السابقة تظل قابلة
    // للاستخدام عند انقطاع الاتصال.
    if (
      !(error instanceof PosConnectionError) &&
      catalogCache.itemCount === 0
    ) {
      throw error
    }
  }

  return {
    ...bootstrap.data,

    cashier,
    catalogCache,

    workspaceSource: 'server',

    workspaceCachedAt: savedWorkspace.cachedAt,
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

  try {
    const response = (await requestCashierApi(
      `/api/pos/search-items?${searchParams.toString()}`,
    )) as {
      data?: Array<Omit<PosCatalogItem, 'catalog_source'>>
    }

    return Array.isArray(response.data)
      ? response.data.map((item) => ({
          ...item,

          catalog_source: 'server' as const,
        }))
      : []
  } catch (error) {
    if (!(error instanceof PosConnectionError)) {
      throw error
    }

    return searchCatalogCache(query, 20).map((item) =>
      mapCachedCatalogItem(item, stockLocationId),
    )
  }
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

  try {
    const response = (await requestCashierApi(
      `/api/pos/lookup-item?${searchParams.toString()}`,
    )) as {
      data?: Omit<PosCatalogItem, 'catalog_source'>
    }

    if (!response.data) {
      throw new Error('لم يتم العثور على الصنف.')
    }

    return {
      ...response.data,

      catalog_source: 'server' as const,
    }
  } catch (error) {
    if (!(error instanceof PosConnectionError)) {
      throw error
    }

    const cachedItem = lookupCatalogCacheItem(query)

    if (!cachedItem) {
      throw new Error('الصنف غير موجود في آخر كتالوج محلي محفوظ.')
    }

    return mapCachedCatalogItem(cachedItem, stockLocationId)
  }
}
