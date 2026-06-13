import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  AetherApi,
  AetherState,
  AppSettings,
  AppSummary,
  BrowserTabSummary,
  CaptureProgress,
  CaptureResult,
  CaptureSummary,
  ChatResult,
  ChatStreamEvent,
  CollectionSummary,
  HubShortcutSummary,
  IcebergResult,
  SaveIcebergInput,
  SavedIceberg,
  SavedIcebergSummary,
  SearchResult,
  StatusToastInput,
  SystemStatus
} from '../../shared/aether'

const isTauri = typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__)

function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args)
}

if (isTauri) {
  const api: AetherApi = {
    apps: {
      list: () => call<AppSummary[]>('aether_apps_list'),
      activate: (appId) => call<void>('aether_apps_activate', { appId }),
      navigate: (appId, url) => call<void>('aether_apps_navigate', { appId, url }),
      goBack: (appId) => call<void>('aether_apps_go_back', { appId }),
      goForward: (appId) => call<void>('aether_apps_go_forward', { appId })
    },
    tabs: {
      list: () => call<BrowserTabSummary[]>('aether_tabs_list'),
      create: (input) => call<BrowserTabSummary>('aether_tabs_create', { input }),
      activate: (tabId) => call<void>('aether_tabs_activate', { tabId }),
      close: (tabId) => call<void>('aether_tabs_close', { tabId }),
      navigate: (tabId, url) => call<void>('aether_tabs_navigate', { tabId, url }),
      scrollToText: (tabId, text) => call<void>('aether_tabs_scroll_to_text', { tabId, text }),
      find: (tabId, query) => call<void>('aether_tabs_find', { tabId, query }),
      goBack: (tabId) => call<void>('aether_tabs_go_back', { tabId }),
      goForward: (tabId) => call<void>('aether_tabs_go_forward', { tabId })
    },
    dashboard: {
      open: () => call<void>('aether_dashboard_open')
    },
    hub: {
      list: () => call<HubShortcutSummary[]>('aether_hub_list'),
      create: (input) => call<HubShortcutSummary>('aether_hub_create', { input }),
      reorder: (ids) => call<HubShortcutSummary[]>('aether_hub_reorder', { ids }),
      delete: (id) => call<void>('aether_hub_delete', { id })
    },
    collections: {
      list: () => call<CollectionSummary[]>('aether_collections_list'),
      create: (input) => call<CollectionSummary>('aether_collections_create', { input }),
      update: (input) => call<CollectionSummary>('aether_collections_update', { input }),
      reorder: (ids) => call<CollectionSummary[]>('aether_collections_reorder', { ids }),
      delete: (id) => call<void>('aether_collections_delete', { id }),
      captures: (collectionId) =>
        call<CaptureSummary[]>('aether_collections_captures', { collectionId })
    },
    capture: {
      currentPage: (input) => call<CaptureResult>('aether_capture_current_page', { input }),
      move: (input) => call<CaptureSummary>('aether_capture_move', { input }),
      delete: (captureId) => call<void>('aether_capture_delete', { captureId })
    },
    search: {
      collection: (input) => call<SearchResult[]>('aether_search_collection', { input })
    },
    chat: {
      ask: (input) => call<ChatResult>('aether_chat_ask', { input }),
      cancel: () => call<void>('aether_chat_cancel')
    },
    crystallizer: {
      generate: (input) => call<IcebergResult>('aether_crystallizer_generate', { input }),
      listSaved: () => call<SavedIcebergSummary[]>('aether_crystallizer_list_saved'),
      getSaved: (id) => call<SavedIceberg>('aether_crystallizer_get_saved', { id }),
      save: (input: SaveIcebergInput) => call<SavedIceberg>('aether_crystallizer_save', { input }),
      reorderSaved: (ids) =>
        call<SavedIcebergSummary[]>('aether_crystallizer_reorder_saved', { ids }),
      deleteSaved: (id) => call<void>('aether_crystallizer_delete_saved', { id })
    },
    system: {
      status: () => call<SystemStatus>('aether_system_status'),
      settings: () => call<AppSettings>('aether_system_settings'),
      updateSettings: (input) => call<AppSettings>('aether_system_update_settings', { input }),
      updateModels: (input) => call<SystemStatus>('aether_system_update_models', { input })
    },
    layout: {
      setIntelligencePanelCollapsed: (collapsed) =>
        call<void>('aether_layout_set_panel_collapsed', { collapsed }),
      setModalOverlayOpen: (open) => call<void>('aether_layout_set_modal_overlay_open', { open }),
      showStatusToast: (input: StatusToastInput) =>
        call<void>('aether_layout_show_status_toast', { input })
    },
    events: {
      onState: (listener: (state: AetherState) => void) => {
        const unlisten = listen<AetherState>('aether:state', (event) => listener(event.payload))
        call<AetherState>('aether_state')
          .then(listener)
          .catch(() => undefined)

        return () => {
          void unlisten.then((dispose) => dispose())
        }
      },
      onCaptureProgress: (listener: (progress: CaptureProgress) => void) => {
        const unlisten = listen<CaptureProgress>('aether:capture-progress', (event) =>
          listener(event.payload)
        )

        return () => {
          void unlisten.then((dispose) => dispose())
        }
      },
      onChatStream: (listener: (event: ChatStreamEvent) => void) => {
        const unlisten = listen<ChatStreamEvent>('aether:chat-stream', (event) =>
          listener(event.payload)
        )

        return () => {
          void unlisten.then((dispose) => dispose())
        }
      },
      onFindRequested: (listener: () => void) => {
        const unlisten = listen<void>('aether:find-requested', () => listener())

        return () => {
          void unlisten.then((dispose) => dispose())
        }
      }
    }
  }

  window.aether = api
}
