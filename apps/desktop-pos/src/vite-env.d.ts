/// <reference types="vite/client" />

type DesktopCashierUser = {
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

type DesktopCashierSession = {
  expiresAt: string
  user: DesktopCashierUser
}

type DesktopStockLocation = {
  id: string
  code: string
  name: string
  location_type: string
}

type DesktopPosWorkspace = {
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

  stockLocations: DesktopStockLocation[]

  cashier: DesktopCashierSession
}

type DesktopCatalogItem = {
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

type DesktopPosState = {
  appVersion: string
  configured: boolean
  serverUrl: string | null
  deviceId: string | null
  hasDeviceSecret: boolean
  pendingSalesCount: number

  cashierSession: DesktopCashierSession | null
}

type DesktopPendingSale = {
  id: string
  localSaleId: string
  idempotencyKey: string

  status: 'pending' | 'syncing' | 'needs_review' | 'failed'

  payload: Record<string, unknown>
  attemptCount: number
  lastError: string | null
  createdAt: string
  updatedAt: string
}

interface Window {
  desktopPos: {
    getState: () => Promise<DesktopPosState>

    saveDeviceConfig: (input: {
      serverUrl: string
      deviceId: string
      deviceSecret: string
    }) => Promise<DesktopPosState>

    clearDeviceConfig: () => Promise<DesktopPosState>

    heartbeat: () => Promise<unknown>

    bootstrap: () => Promise<unknown>

    listPendingSales: () => Promise<DesktopPendingSale[]>

    cashierSession: () => Promise<DesktopCashierSession | null>

    cashierLogin: (input: {
      companyCode: string
      username: string
      password: string
    }) => Promise<DesktopCashierSession>

    cashierLogout: () => Promise<null>

    loadWorkspace: () => Promise<DesktopPosWorkspace>

    searchCatalog: (input: {
      stockLocationId: string
      query: string
    }) => Promise<DesktopCatalogItem[]>

    lookupCatalogItem: (input: {
      stockLocationId: string
      query: string
    }) => Promise<DesktopCatalogItem>
  }
}
