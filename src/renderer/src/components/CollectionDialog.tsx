import { FormEvent, useState } from 'react'
import { CollectionSummary } from '../../../shared/aether'
import { CloseIcon } from './icons'

export type CollectionDialogState =
  | { mode: 'create' }
  | { mode: 'edit'; collection: CollectionSummary }
  | { mode: 'delete'; collection: CollectionSummary }
  | null

type CollectionDialogProps = {
  busy: string | null
  state: CollectionDialogState
  onClose: () => void
  onDelete: () => Promise<void>
  onSave: (input: { name: string; description: string }) => Promise<void>
}

export function CollectionDialog({
  busy,
  state,
  onClose,
  onDelete,
  onSave
}: CollectionDialogProps): React.JSX.Element | null {
  const collection = state && 'collection' in state ? state.collection : null
  const [name, setName] = useState(collection?.name ?? '')
  const [description, setDescription] = useState(collection?.description ?? '')

  if (!state) return null

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (state?.mode === 'delete') {
      await onDelete()
      return
    }
    await onSave({ name, description })
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <form className="collection-dialog" onSubmit={submit}>
        <header>
          <div>
            <p>Collection</p>
            <h2>
              {state.mode === 'create'
                ? 'New knowledge hub'
                : state.mode === 'edit'
                  ? 'Edit knowledge hub'
                  : 'Delete knowledge hub'}
            </h2>
          </div>
          <button aria-label="Close dialog" onClick={onClose} type="button">
            <CloseIcon />
          </button>
        </header>

        {state.mode === 'delete' ? (
          <p className="delete-copy">
            Delete <strong>{collection?.name}</strong> and all indexed captures in it?
          </p>
        ) : (
          <div className="dialog-fields">
            <label>
              Name
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Electronic parts"
              />
            </label>
            <label>
              Description
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Research notes, references, and captured pages"
              />
            </label>
          </div>
        )}

        <footer>
          <button onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className={state.mode === 'delete' ? 'danger-primary' : 'primary-button'}
            disabled={Boolean(busy) || (state.mode !== 'delete' && !name.trim())}
            type="submit"
          >
            {state.mode === 'delete' ? 'Delete' : 'Save'}
          </button>
        </footer>
      </form>
    </div>
  )
}
