/// <reference types="vite/client" />

type DesktopPosState = {
  appVersion: string
  configured: boolean
  serverUrl: string | null
  deviceId: string | null
  hasDeviceSecret: boolean
  pendingSalesCount: number
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
  }
}
