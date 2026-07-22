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
  catalogCache: {
    itemCount: number
    refreshedAt: string | null
  }
  workspaceSource: 'server' | 'cache'
  workspaceCachedAt: string
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
  available_quantity: string | null
  stock_location_id: string
  stock_location_name: string
  catalog_source: 'server' | 'cache'
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

type DesktopPaymentMethod =
  | 'cash'
  | 'card'
  | 'wallet'
  | 'bank_transfer'
  | 'other'

type DesktopCreatePendingSaleResult = {
  pendingSale: DesktopPendingSale
  saleNumber: string
  saleTotal: number
  paidAmount: number
  changeAmount: number
  state: DesktopPosState
}

type DesktopSyncResult = {
  inProgress: boolean
  batchKey?: string
  selectedItems: number
  processedItems: number
  reviewItems: number
  failedItems: number
  pendingSalesCount: number
  message: string
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

    createPendingSale: (input: {
      stockLocationId: string

      items: Array<{
        variantId: string
        quantity: number
        unitPrice: number
      }>

      paymentMethod: DesktopPaymentMethod

      paidAmount: number
      paymentReference?: string | null
    }) => Promise<DesktopCreatePendingSaleResult>

    syncPendingSales: () => Promise<DesktopSyncResult>

    onSyncCompleted: (
      callback: (result: DesktopSyncResult) => void,
    ) => () => void

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
