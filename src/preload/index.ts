import { contextBridge, ipcRenderer } from 'electron'
import { AetherApi, AetherState } from '../shared/aether'

const api: AetherApi = {
  apps: {
    list: () => ipcRenderer.invoke('aether:apps:list'),
    activate: (appId) => ipcRenderer.invoke('aether:apps:activate', appId),
    navigate: (appId, url) => ipcRenderer.invoke('aether:apps:navigate', appId, url),
    goBack: (appId) => ipcRenderer.invoke('aether:apps:go-back', appId),
    goForward: (appId) => ipcRenderer.invoke('aether:apps:go-forward', appId)
  },
  tabs: {
    list: () => ipcRenderer.invoke('aether:tabs:list'),
    create: (input) => ipcRenderer.invoke('aether:tabs:create', input),
    activate: (tabId) => ipcRenderer.invoke('aether:tabs:activate', tabId),
    close: (tabId) => ipcRenderer.invoke('aether:tabs:close', tabId),
    navigate: (tabId, url) => ipcRenderer.invoke('aether:tabs:navigate', tabId, url),
    goBack: (tabId) => ipcRenderer.invoke('aether:tabs:go-back', tabId),
    goForward: (tabId) => ipcRenderer.invoke('aether:tabs:go-forward', tabId)
  },
  dashboard: {
    open: () => ipcRenderer.invoke('aether:dashboard:open')
  },
  hub: {
    list: () => ipcRenderer.invoke('aether:hub:list'),
    create: (input) => ipcRenderer.invoke('aether:hub:create', input),
    delete: (id) => ipcRenderer.invoke('aether:hub:delete', id)
  },
  collections: {
    list: () => ipcRenderer.invoke('aether:collections:list'),
    create: (input) => ipcRenderer.invoke('aether:collections:create', input),
    update: (input) => ipcRenderer.invoke('aether:collections:update', input),
    delete: (id) => ipcRenderer.invoke('aether:collections:delete', id),
    captures: (collectionId) => ipcRenderer.invoke('aether:collections:captures', collectionId)
  },
  capture: {
    currentPage: (input) => ipcRenderer.invoke('aether:capture:current-page', input),
    delete: (captureId) => ipcRenderer.invoke('aether:capture:delete', captureId)
  },
  search: {
    collection: (input) => ipcRenderer.invoke('aether:search:collection', input)
  },
  chat: {
    ask: (input) => ipcRenderer.invoke('aether:chat:ask', input)
  },
  system: {
    status: () => ipcRenderer.invoke('aether:system:status'),
    updateModels: (input) => ipcRenderer.invoke('aether:system:update-models', input)
  },
  layout: {
    setIntelligencePanelCollapsed: (collapsed) =>
      ipcRenderer.invoke('aether:layout:set-panel-collapsed', collapsed)
  },
  events: {
    onState: (listener: (state: AetherState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: AetherState): void =>
        listener(state)
      ipcRenderer.on('aether:state', handler)

      return () => ipcRenderer.removeListener('aether:state', handler)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('aether', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.aether = api
}
