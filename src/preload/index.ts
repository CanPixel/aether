import { contextBridge, ipcRenderer } from 'electron'
import {
  AetherApi,
  AetherShortcutId,
  AetherState,
  CaptureProgress,
  ChatStreamEvent,
  FindResult
} from '../shared/aether'

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
    scrollToText: (tabId, text) => ipcRenderer.invoke('aether:tabs:scroll-to-text', tabId, text),
    find: (tabId, query, action) => ipcRenderer.invoke('aether:tabs:find', tabId, query, action),
    goBack: (tabId) => ipcRenderer.invoke('aether:tabs:go-back', tabId),
    goForward: (tabId) => ipcRenderer.invoke('aether:tabs:go-forward', tabId)
  },
  dashboard: {
    open: () => ipcRenderer.invoke('aether:dashboard:open')
  },
  hub: {
    list: () => ipcRenderer.invoke('aether:hub:list'),
    create: (input) => ipcRenderer.invoke('aether:hub:create', input),
    reorder: (ids) => ipcRenderer.invoke('aether:hub:reorder', ids),
    delete: (id) => ipcRenderer.invoke('aether:hub:delete', id)
  },
  collections: {
    list: () => ipcRenderer.invoke('aether:collections:list'),
    create: (input) => ipcRenderer.invoke('aether:collections:create', input),
    update: (input) => ipcRenderer.invoke('aether:collections:update', input),
    reorder: (ids) => ipcRenderer.invoke('aether:collections:reorder', ids),
    delete: (id) => ipcRenderer.invoke('aether:collections:delete', id),
    captures: (collectionId) => ipcRenderer.invoke('aether:collections:captures', collectionId)
  },
  capture: {
    currentPage: (input) => ipcRenderer.invoke('aether:capture:current-page', input),
    move: (input) => ipcRenderer.invoke('aether:capture:move', input),
    delete: (captureId) => ipcRenderer.invoke('aether:capture:delete', captureId)
  },
  search: {
    collection: (input) => ipcRenderer.invoke('aether:search:collection', input)
  },
  chat: {
    ask: (input) => ipcRenderer.invoke('aether:chat:ask', input),
    cancel: () => ipcRenderer.invoke('aether:chat:cancel')
  },
  crystallizer: {
    generate: (input) => ipcRenderer.invoke('aether:crystallizer:generate', input),
    listSaved: () => ipcRenderer.invoke('aether:crystallizer:list-saved'),
    getSaved: (id) => ipcRenderer.invoke('aether:crystallizer:get-saved', id),
    save: (input) => ipcRenderer.invoke('aether:crystallizer:save', input),
    reorderSaved: (ids) => ipcRenderer.invoke('aether:crystallizer:reorder-saved', ids),
    deleteSaved: (id) => ipcRenderer.invoke('aether:crystallizer:delete-saved', id)
  },
  system: {
    status: () => ipcRenderer.invoke('aether:system:status'),
    settings: () => ipcRenderer.invoke('aether:system:settings'),
    updateSettings: (input) => ipcRenderer.invoke('aether:system:update-settings', input),
    updateModels: (input) => ipcRenderer.invoke('aether:system:update-models', input)
  },
  layout: {
    setIntelligencePanelCollapsed: (collapsed) =>
      ipcRenderer.invoke('aether:layout:set-panel-collapsed', collapsed),
    setModalOverlayOpen: (open) => ipcRenderer.invoke('aether:layout:set-modal-overlay-open', open),
    showStatusToast: (input) => ipcRenderer.invoke('aether:layout:show-status-toast', input)
  },
  events: {
    onState: createEventListener<AetherState>('aether:state'),
    onCaptureProgress: createEventListener<CaptureProgress>('aether:capture-progress'),
    onChatStream: createEventListener<ChatStreamEvent>('aether:chat-stream'),
    onShortcut: createEventListener<AetherShortcutId>('aether:shortcut'),
    onFindRequested: (listener) => {
      const handler = (): void => listener()
      ipcRenderer.on('aether:find-requested', handler)

      return () => ipcRenderer.removeListener('aether:find-requested', handler)
    },
    onFindResult: createEventListener<FindResult>('aether:find-result')
  }
}

function createEventListener<T>(channel: string): (listener: (payload: T) => void) => () => void {
  return (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload)
    ipcRenderer.on(channel, handler)

    return () => ipcRenderer.removeListener(channel, handler)
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
