import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('desktopPos', {
  getState: () => ipcRenderer.invoke('desktop-pos:get-state'),

  saveDeviceConfig: (input: {
    serverUrl: string
    deviceId: string
    deviceSecret: string
  }) => ipcRenderer.invoke('desktop-pos:save-device-config', input),

  clearDeviceConfig: () =>
    ipcRenderer.invoke('desktop-pos:clear-device-config'),

  heartbeat: () => ipcRenderer.invoke('desktop-pos:heartbeat'),

  bootstrap: () => ipcRenderer.invoke('desktop-pos:bootstrap'),

  listPendingSales: () => ipcRenderer.invoke('desktop-pos:list-pending-sales'),

  createPendingSale: (input: {
    stockLocationId: string

    items: Array<{
      variantId: string
      quantity: number
      unitPrice: number
    }>

    paymentMethod: 'cash' | 'card' | 'wallet' | 'bank_transfer' | 'other'

    paidAmount: number
    paymentReference?: string | null
  }) => ipcRenderer.invoke('desktop-pos:create-pending-sale', input),

  syncPendingSales: () => ipcRenderer.invoke('desktop-pos:sync-pending-sales'),

  onSyncCompleted: (callback: (result: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: unknown) => {
      callback(result)
    }

    ipcRenderer.on('desktop-pos:sync-completed', listener)

    return () => {
      ipcRenderer.removeListener('desktop-pos:sync-completed', listener)
    }
  },

  cashierSession: () => ipcRenderer.invoke('desktop-pos:cashier-session'),

  cashierLogin: (input: {
    companyCode: string
    username: string
    password: string
  }) => ipcRenderer.invoke('desktop-pos:cashier-login', input),

  cashierLogout: () => ipcRenderer.invoke('desktop-pos:cashier-logout'),

  openCashierShift: (input: { openingCash: number }) =>
    ipcRenderer.invoke('desktop-pos:open-cashier-shift', input),

  closeCashierShift: (input: {
    shiftId: string
    closingCash: number

    closingNote?: string | null
  }) => ipcRenderer.invoke('desktop-pos:close-cashier-shift', input),

  loadWorkspace: () => ipcRenderer.invoke('desktop-pos:load-workspace'),

  searchCatalog: (input: { stockLocationId: string; query: string }) =>
    ipcRenderer.invoke('desktop-pos:search-catalog', input),

  lookupCatalogItem: (input: { stockLocationId: string; query: string }) =>
    ipcRenderer.invoke('desktop-pos:lookup-catalog-item', input),
})
