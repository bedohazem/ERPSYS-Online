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
})
