import path from 'node:path'
import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'
import {
  clearCashierSession,
  getPublicCashierSession,
  loadPosWorkspace,
  loginCashier,
  logoutCashier,
  lookupPosCatalogItem,
  searchPosCatalog,
} from './cashier-service'
import {
  countPendingSales,
  deleteSetting,
  getSetting,
  initializeLocalStore,
  listPendingSales,
  setSetting,
} from './local-store'

type SaveDeviceConfigInput = {
  serverUrl: string
  deviceId: string
  deviceSecret: string
}

type StoredDeviceConfig = {
  serverUrl: string
  deviceId: string
  deviceSecret: string
}

const deviceIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const deviceSecretPattern = /^[0-9a-f]{64}$/i

const DEVICE_SERVER_URL_KEY = 'pos.device.server-url'

const DEVICE_ID_KEY = 'pos.device.id'

const DEVICE_SECRET_KEY = 'pos.device.encrypted-secret'

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

async function requestDeviceApi(apiPath: string, method: 'GET' | 'POST') {
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

function registerIpcHandlers() {
  ipcMain.handle('desktop-pos:get-state', () => getPublicAppState())

  ipcMain.handle(
    'desktop-pos:save-device-config',
    (_event, input: SaveDeviceConfigInput) => {
      const serverUrl = normalizeServerUrl(input?.serverUrl)

      const deviceId = validateDeviceId(input?.deviceId)

      const deviceSecret = validateDeviceSecret(input?.deviceSecret)

      const encryptedSecret = encryptDeviceSecret(deviceSecret)

      setSetting(DEVICE_SERVER_URL_KEY, serverUrl)

      setSetting(DEVICE_ID_KEY, deviceId)

      setSetting(DEVICE_SECRET_KEY, encryptedSecret)

      return getPublicAppState()
    },
  )

  ipcMain.handle('desktop-pos:clear-device-config', () => {
    clearCashierSession()
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

  ipcMain.handle('desktop-pos:cashier-session', () => getPublicCashierSession())

  ipcMain.handle('desktop-pos:cashier-login', (_event, input) =>
    loginCashier(input),
  )

  ipcMain.handle('desktop-pos:cashier-logout', () => logoutCashier())

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
