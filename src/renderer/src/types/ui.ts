import { CollectionSummary } from '../../../shared/aether'

export type QuickAction = {
  id: string
  label: string
  prompt?: string
  capture?: boolean
}

export type CollectionDialogState =
  | { mode: 'create' }
  | { mode: 'edit'; collection: CollectionSummary }
  | { mode: 'delete'; collection: CollectionSummary }
  | null
