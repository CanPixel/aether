import { CollectionSummary } from '../../../shared/aether'

export type PanelMode = 'search' | 'ask'

export type QuickAction = {
  id: string
  label: string
  prompt?: string
  mode?: PanelMode
  capture?: boolean
}

export type CollectionDialogState =
  | { mode: 'create' }
  | { mode: 'edit'; collection: CollectionSummary }
  | { mode: 'delete'; collection: CollectionSummary }
  | null
