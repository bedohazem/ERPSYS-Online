import path from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'
import {
  clearCashierSession,
  getPublicCashierSession,
  loadPosWorkspace,
  loginCashier,
  logoutCashier,
  lookupPosCatalogItem,
  searchPosCatalog,
  clearCashierGrants,
  getCashierGrantToken,
  openCashierShift,
  closeCashierShift,
} from './cashier-service'
import {
  applyPendingSaleSyncResults,
  countPendingSales,
  createPendingSaleRecord,
  markPendingSalesFailed,
  takePendingSalesForSync,
  deleteSetting,
  getSetting,
  initializeLocalStore,
  listPendingSales,
  setSetting,
  clearCatalogCache,
  clearWorkspaceCache,
  countBlockingPendingSalesForShift,
} from './local-store'

type SaveDeviceConfigInput = {
  serverUrl: string
  deviceId: string
  deviceSecret: string
}

type SavePendingSaleInput = {
  stockLocationId: string

  items: Array<{
    variantId: string
    quantity: number
    unitPrice: number
  }>

  paymentMethod: 'cash' | 'card' | 'wallet' | 'bank_transfer' | 'other'

  paidAmount: number
  paymentReference?: string | null
}

type StoredDeviceConfig = {
  serverUrl: string
  deviceId: string
  deviceSecret: string
}

const deviceIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const deviceSecretPattern = /^[0-9a-f]{64}$/i

const allowedOfflinePaymentMethods = new Set([
  'cash',
  'card',
  'wallet',
  'bank_transfer',
  'other',
])

function roundMoney(value: number) {
  return Number(value.toFixed(2))
}

const DEVICE_SERVER_URL_KEY = 'pos.device.server-url'

const DEVICE_ID_KEY = 'pos.device.id'

const DEVICE_SECRET_KEY = 'pos.device.encrypted-secret'

let syncInProgress = false

let automaticSyncTimer: NodeJS.Timeout | null = null

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }

  return value as Record<string, unknown>
}

function broadcastSyncCompleted(result: Record<string, unknown>) {
  for (const currentWindow of BrowserWindow.getAllWindows()) {
    currentWindow.webContents.send('desktop-pos:sync-completed', result)
  }
}

function normalizeServerUrl(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('عنوان السيرفر مطلوب.')
  }

  let parsedUrl: URL

  try {
    parsedUrl = new URL(value.trim())
  } catch {
    throw new Error('عنوان السيرفر غير صالح.')
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('عنوان السيرفر يجب أن يبدأ بـ http أو https.')
  }

  return parsedUrl.toString().replace(/\/+$/, '')
}

function validateDeviceId(value: unknown) {
  if (typeof value !== 'string' || !deviceIdPattern.test(value.trim())) {
    throw new Error(
      'Device ID غير صالح. استخدم UUID من عمود Device ID وليس كود الجهاز.',
    )
  }

  return value.trim()
}

function validateDeviceSecret(value: unknown) {
  if (typeof value !== 'string' || !deviceSecretPattern.test(value.trim())) {
    throw new Error('مفتاح الجهاز يجب أن يكون 64 حرف Hex.')
  }

  return value.trim()
}

function encryptDeviceSecret(secret: string) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('التخزين الآمن غير متاح على هذا الجهاز.')
  }

  return safeStorage.encryptString(secret).toString('base64')
}

function decryptDeviceSecret(encryptedSecret: string) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('التخزين الآمن غير متاح على هذا الجهاز.')
  }

  return safeStorage.decryptString(Buffer.from(encryptedSecret, 'base64'))
}

function getStoredDeviceConfig(): StoredDeviceConfig | null {
  const serverUrl = getSetting(DEVICE_SERVER_URL_KEY)

  const deviceId = getSetting(DEVICE_ID_KEY)

  const encryptedSecret = getSetting(DEVICE_SECRET_KEY)

  if (!serverUrl || !deviceId || !encryptedSecret) {
    return null
  }

  return {
    serverUrl,
    deviceId,
    deviceSecret: decryptDeviceSecret(encryptedSecret),
  }
}

function getPublicAppState() {
  const serverUrl = getSetting(DEVICE_SERVER_URL_KEY)

  const deviceId = getSetting(DEVICE_ID_KEY)

  const encryptedSecret = getSetting(DEVICE_SECRET_KEY)

  return {
    appVersion: app.getVersion(),

    configured: Boolean(serverUrl && deviceId && encryptedSecret),

    serverUrl,
    deviceId,

    hasDeviceSecret: Boolean(encryptedSecret),

    pendingSalesCount: countPendingSales(),

    cashierSession: getPublicCashierSession(),
  }
}

function createLocalPendingSale(input: SavePendingSaleInput) {
  const cashierSession = getPublicCashierSession()

  if (!cashierSession) {
    throw new Error('يجب تسجيل دخول الكاشير أولًا.')
  }

  if (!deviceIdPattern.test(cashierSession.cashierGrantId)) {
    throw new Error('تصريح الكاشير Offline غير صالح. سجل الدخول مرة أخرى.')
  }

  const currentShift = cashierSession.currentShift

  if (
    !currentShift ||
    currentShift.status !== 'open' ||
    !deviceIdPattern.test(currentShift.id)
  ) {
    throw new Error('يجب فتح وردية الكاشير قبل إنشاء الفاتورة.')
  }

  const deviceConfig = getStoredDeviceConfig()

  if (!deviceConfig || currentShift.deviceId !== deviceConfig.deviceId) {
    throw new Error('الوردية المفتوحة لا تخص جهاز POS الحالي.')
  }

  const stockLocationId =
    typeof input?.stockLocationId === 'string'
      ? input.stockLocationId.trim()
      : ''

  if (!deviceIdPattern.test(stockLocationId)) {
    throw new Error('مكان البيع غير صالح.')
  }

  if (
    !Array.isArray(input.items) ||
    input.items.length === 0 ||
    input.items.length > 200
  ) {
    throw new Error('يجب أن تحتوي الفاتورة على صنف واحد على الأقل.')
  }

  const usedVariantIds = new Set<string>()

  const items = input.items.map((rawItem) => {
    const variantId =
      typeof rawItem?.variantId === 'string' ? rawItem.variantId.trim() : ''

    const quantity = Number(rawItem?.quantity)

    const unitPrice = roundMoney(Number(rawItem?.unitPrice))

    if (!deviceIdPattern.test(variantId)) {
      throw new Error('أحد أصناف الفاتورة غير صالح.')
    }

    if (usedVariantIds.has(variantId)) {
      throw new Error('لا يمكن تكرار نفس الصنف داخل الفاتورة.')
    }

    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 9999) {
      throw new Error('كمية أحد الأصناف غير صالحة.')
    }

    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new Error('سعر أحد الأصناف غير صالح.')
    }

    usedVariantIds.add(variantId)

    return {
      variantId,
      quantity,
      unitPrice,
    }
  })

  const saleTotal = roundMoney(
    items.reduce((total, item) => total + item.quantity * item.unitPrice, 0),
  )

  const paymentMethod =
    typeof input.paymentMethod === 'string' ? input.paymentMethod : ''

  if (!allowedOfflinePaymentMethods.has(paymentMethod)) {
    throw new Error('طريقة الدفع غير مدعومة.')
  }

  const paidAmount = roundMoney(Number(input.paidAmount))

  if (!Number.isFinite(paidAmount) || paidAmount < saleTotal) {
    throw new Error('المبلغ المدفوع أقل من إجمالي الفاتورة.')
  }

  const now = new Date()
  const localSaleId = randomUUID()
  const idempotencyKey = randomUUID()

  const datePart = now.toISOString().slice(0, 10).replaceAll('-', '')

  const saleNumber =
    `OFF-${datePart}-` +
    `${Date.now().toString(36).toUpperCase()}-` +
    randomBytes(2).toString('hex').toUpperCase()

  const payload = {
    localSaleId,
    idempotencyKey,
    saleNumber,

    stockLocationId,

    cashierId: cashierSession.user.id,

    // نخزن معرف المنحة فقط.
    // المفتاح الخام لا يدخل SQLite.
    cashierGrantId: cashierSession.cashierGrantId,

    shiftId: currentShift.id,
    customerId: null,

    occurredAt: now.toISOString(),

    items,

    payments: [
      {
        method: paymentMethod,
        amount: paidAmount,

        reference:
          typeof input.paymentReference === 'string' &&
          input.paymentReference.trim()
            ? input.paymentReference.trim()
            : null,
      },
    ],
  }

  const pendingSale = createPendingSaleRecord({
    id: randomUUID(),
    localSaleId,
    idempotencyKey,
    payload,
  })

  return {
    pendingSale,
    saleNumber,
    saleTotal,
    paidAmount,

    changeAmount: roundMoney(paidAmount - saleTotal),

    state: getPublicAppState(),
  }
}

async function requestDeviceApi(
  apiPath: string,
  method: 'GET' | 'POST',
  body?: unknown,
) {
  const config = getStoredDeviceConfig()

  if (!config) {
    throw new Error('إعدادات جهاز POS غير مكتملة.')
  }

  const controller = new AbortController()

  const timeout = setTimeout(() => controller.abort(), 10_000)

  try {
    const response = await fetch(`${config.serverUrl}${apiPath}`, {
      method,

      headers: {
        Accept: 'application/json',

        'Content-Type': 'application/json',

        'X-POS-Device-Id': config.deviceId,

        'X-POS-Device-Secret': config.deviceSecret,
      },

      body: body === undefined ? undefined : JSON.stringify(body),

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
      const errorMessage =
        typeof responseBody === 'object' &&
        responseBody !== null &&
        'error' in responseBody &&
        typeof (
          responseBody as {
            error?: unknown
          }
        ).error === 'string'
          ? (
              responseBody as {
                error: string
              }
            ).error
          : `Server error ${response.status}`

      throw new Error(errorMessage)
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

async function syncPendingSales(manual: boolean) {
  if (syncInProgress) {
    return {
      inProgress: true,
      selectedItems: 0,
      processedItems: 0,
      reviewItems: 0,
      failedItems: 0,
      pendingSalesCount: countPendingSales(),
      message: 'توجد مزامنة قيد التنفيذ بالفعل.',
    }
  }

  const config = getStoredDeviceConfig()

  if (!config) {
    if (manual) {
      throw new Error('إعدادات جهاز POS غير مكتملة.')
    }

    return null
  }

  syncInProgress = true

  let selectedSales: ReturnType<typeof takePendingSalesForSync>

  try {
    selectedSales = takePendingSalesForSync(50, manual)
  } catch (error) {
    syncInProgress = false
    throw error
  }

  if (selectedSales.length === 0) {
    syncInProgress = false

    const emptyResult = {
      inProgress: false,
      selectedItems: 0,
      processedItems: 0,
      reviewItems: 0,
      failedItems: 0,
      pendingSalesCount: countPendingSales(),
      message: 'لا توجد مبيعات مؤجلة قابلة للمزامنة.',
    }

    if (manual) {
      broadcastSyncCompleted(emptyResult)
    }

    return emptyResult
  }

  const syncableSales: typeof selectedSales = []

  const syncPayloads: Record<string, unknown>[] = []

  const missingGrantResults: Array<{
    localSaleId: string
    status: 'failed'
    errorMessage: string
  }> = []

  for (const sale of selectedSales) {
    const payload = asRecord(sale.payload)

    const cashierGrantId =
      typeof payload.cashierGrantId === 'string'
        ? payload.cashierGrantId.trim()
        : ''

    const cashierGrantToken = getCashierGrantToken(cashierGrantId)

    if (!deviceIdPattern.test(cashierGrantId) || !cashierGrantToken) {
      missingGrantResults.push({
        localSaleId: sale.localSaleId,

        status: 'failed',

        errorMessage:
          'الفاتورة لا تحتوي على تصريح كاشير Offline صالح. قد تكون فاتورة قديمة قبل تفعيل Cashier Grants.',
      })

      continue
    }

    syncableSales.push(sale)

    // المفتاح يضاف في الذاكرة فقط
    // ولا يتم تحديث payload_json داخل SQLite.
    syncPayloads.push({
      ...payload,
      cashierGrantToken,
    })
  }

  if (missingGrantResults.length > 0) {
    applyPendingSaleSyncResults(
      missingGrantResults.map((result) => result.localSaleId),

      missingGrantResults,
    )
  }

  if (syncableSales.length === 0) {
    syncInProgress = false

    const reviewOnlyResult = {
      inProgress: false,

      selectedItems: selectedSales.length,

      processedItems: 0,

      reviewItems: 0,

      failedItems: missingGrantResults.length,

      pendingSalesCount: countPendingSales(),

      message: `فشلت ${missingGrantResults.length} فاتورة محليًا لأنها لا تملك تصريح كاشير صالح ولم يتم إرسالها للسيرفر.`,
    }

    broadcastSyncCompleted(reviewOnlyResult)

    return reviewOnlyResult
  }

  const localSaleIds = syncableSales.map((sale) => sale.localSaleId)

  try {
    // المفتاح حتمي لنفس مجموعة الفواتير.
    // لو وصلت الدفعة للسيرفر وفُقد الرد،
    // المحاولة التالية تحصل على نفس Batch بدل إنشاء دفعة مكررة.
    const batchIdentity = syncableSales
      .map((sale) => sale.idempotencyKey)
      .sort()
      .join('|')

    const batchHash = createHash('sha256').update(batchIdentity).digest('hex')

    const batchKey = `desktop-${batchHash}`

    const response = await requestDeviceApi('/api/pos-sync/batches', 'POST', {
      batchKey,

      sales: syncPayloads,
    })

    const responseRecord = asRecord(response)

    const dataRecord = asRecord(responseRecord.data)

    if (!Array.isArray(dataRecord.items)) {
      throw new Error('استجابة دفعة المزامنة غير مكتملة.')
    }

    const allowedStatuses = new Set([
      'processed',
      'duplicate',
      'needs_review',
      'failed',
    ])

    const results = dataRecord.items
      .map((rawItem) => {
        const item = asRecord(rawItem)

        const localSaleId =
          typeof item.local_entity_id === 'string' ? item.local_entity_id : ''

        const rawStatus =
          typeof item.status === 'string' ? item.status : 'failed'

        const status = allowedStatuses.has(rawStatus)
          ? (rawStatus as 'processed' | 'duplicate' | 'needs_review' | 'failed')
          : 'failed'

        const errorCode =
          typeof item.error_code === 'string' ? item.error_code : ''

        const errorMessage =
          typeof item.error_message === 'string' ? item.error_message : ''

        return {
          localSaleId,
          status,

          errorMessage:
            [errorCode, errorMessage].filter(Boolean).join(': ') || null,
        }
      })
      .filter((result) => localSaleIds.includes(result.localSaleId))

    applyPendingSaleSyncResults(localSaleIds, results)

    const processedItems = results.filter(
      (result) =>
        result.status === 'processed' || result.status === 'duplicate',
    ).length

    const serverReviewItems = results.filter(
      (result) => result.status === 'needs_review',
    ).length

    const reviewItems = serverReviewItems

    const failedItems =
      missingGrantResults.length +
      syncableSales.length -
      processedItems -
      serverReviewItems

    const completedResult = {
      inProgress: false,
      batchKey,
      selectedItems: selectedSales.length,
      processedItems,
      reviewItems,
      failedItems,

      pendingSalesCount: countPendingSales(),

      message:
        `تمت مزامنة ${processedItems}، ` +
        `${reviewItems} تحتاج مراجعة، ` +
        `${failedItems} فشلت.`,
    }

    broadcastSyncCompleted(completedResult)

    return completedResult
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'تعذر مزامنة المبيعات المؤجلة.'

    markPendingSalesFailed(localSaleIds, errorMessage)

    const failedResult = {
      inProgress: false,
      selectedItems: selectedSales.length,
      processedItems: 0,
      reviewItems: 0,

      failedItems: missingGrantResults.length + syncableSales.length,

      pendingSalesCount: countPendingSales(),

      message: errorMessage,
    }

    broadcastSyncCompleted(failedResult)

    if (manual) {
      throw new Error(errorMessage)
    }

    return failedResult
  } finally {
    syncInProgress = false
  }
}

function startAutomaticSync() {
  setTimeout(() => {
    void syncPendingSales(false)
  }, 3_000)

  automaticSyncTimer = setInterval(() => {
    void syncPendingSales(false)
  }, 30_000)
}

function registerIpcHandlers() {
  ipcMain.handle('desktop-pos:get-state', () => getPublicAppState())

  ipcMain.handle(
    'desktop-pos:save-device-config',
    (_event, input: SaveDeviceConfigInput) => {
      const previousServerUrl = getSetting(DEVICE_SERVER_URL_KEY)

      const previousDeviceId = getSetting(DEVICE_ID_KEY)
      const serverUrl = normalizeServerUrl(input?.serverUrl)

      const deviceId = validateDeviceId(input?.deviceId)

      const deviceSecret = validateDeviceSecret(input?.deviceSecret)

      const encryptedSecret = encryptDeviceSecret(deviceSecret)

      const deviceIdentityChanged =
        previousServerUrl !== serverUrl || previousDeviceId !== deviceId

      if (deviceIdentityChanged) {
        clearCashierSession()
        clearCashierGrants()

        clearWorkspaceCache()
        clearCatalogCache()
      }

      setSetting(DEVICE_SERVER_URL_KEY, serverUrl)

      setSetting(DEVICE_ID_KEY, deviceId)

      setSetting(DEVICE_SECRET_KEY, encryptedSecret)

      return getPublicAppState()
    },
  )

  ipcMain.handle('desktop-pos:clear-device-config', () => {
    clearCashierSession()
    clearCashierGrants()

    clearWorkspaceCache()
    clearCatalogCache()
    deleteSetting(DEVICE_SERVER_URL_KEY)

    deleteSetting(DEVICE_ID_KEY)

    deleteSetting(DEVICE_SECRET_KEY)

    return getPublicAppState()
  })

  ipcMain.handle('desktop-pos:heartbeat', () =>
    requestDeviceApi('/api/pos-sync/heartbeat', 'POST'),
  )

  ipcMain.handle('desktop-pos:bootstrap', () =>
    requestDeviceApi('/api/pos-sync/bootstrap', 'GET'),
  )

  ipcMain.handle('desktop-pos:list-pending-sales', () => listPendingSales(100))

  ipcMain.handle(
    'desktop-pos:create-pending-sale',
    (_event, input: SavePendingSaleInput) => createLocalPendingSale(input),
  )

  ipcMain.handle('desktop-pos:sync-pending-sales', () => syncPendingSales(true))

  ipcMain.handle('desktop-pos:cashier-session', () => getPublicCashierSession())

  ipcMain.handle('desktop-pos:cashier-login', (_event, input) =>
    loginCashier(input),
  )

  ipcMain.handle('desktop-pos:cashier-logout', () => logoutCashier())

  ipcMain.handle(
    'desktop-pos:open-cashier-shift',

    (_event, input) => openCashierShift(input),
  )

  ipcMain.handle(
    'desktop-pos:close-cashier-shift',

    (_event, input) => {
      const shiftId =
        typeof input?.shiftId === 'string' ? input.shiftId.trim() : ''

      // يجب رفع كل فواتير الوردية
      // قبل حساب النقدية وإغلاقها.
      const unsyncedSalesCount = countBlockingPendingSalesForShift(shiftId)

      if (unsyncedSalesCount > 0) {
        throw new Error(
          `لا يمكن إغلاق الوردية قبل مزامنة ${unsyncedSalesCount} فاتورة مؤجلة.`,
        )
      }

      return closeCashierShift(input)
    },
  )

  ipcMain.handle('desktop-pos:load-workspace', () => loadPosWorkspace())

  ipcMain.handle('desktop-pos:search-catalog', (_event, input) =>
    searchPosCatalog(input),
  )

  ipcMain.handle('desktop-pos:lookup-catalog-item', (_event, input) =>
    lookupPosCatalogItem(input),
  )
}

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#f4f7fb',
    title: 'ERPSYS Desktop POS',

    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),

      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.setMenuBarVisibility(false)

  if (app.isPackaged) {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))

    return
  }

  void mainWindow.loadURL('http://127.0.0.1:5174')
}

void app.whenReady().then(() => {
  initializeLocalStore(path.join(app.getPath('userData'), 'desktop-pos.sqlite'))

  registerIpcHandlers()
  createMainWindow()
  startAutomaticSync()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('will-quit', () => {
  if (automaticSyncTimer) {
    clearInterval(automaticSyncTimer)

    automaticSyncTimer = null
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
