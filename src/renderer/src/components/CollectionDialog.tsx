import { FormEvent, useState } from 'react'
import { CollectionSummary } from '../../../shared/aether'
import { COLLECTION_ICON_OPTIONS, normalizeCollectionIcon } from '../utils/collection-icon-data'
import { CollectionIcon } from '../utils/collection-icons'
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
  onSave: (input: { name: string; description: string; icon: string }) => Promise<void>
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
  const [icon, setIcon] = useState(normalizeCollectionIcon(collection?.icon))
  const [iconQuery, setIconQuery] = useState('')

  const filteredIcons = COLLECTION_ICON_OPTIONS.filter((option) => {
    const query = iconQuery.trim().toLowerCase()
    return !query || `${option.label} ${option.keywords}`.toLowerCase().includes(query)
  })

  if (!state) return null

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (state?.mode === 'delete') {
      await onDelete()
      return
    }
    await onSave({ name, description, icon })
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
            <label>
              Icon
              <input
                value={iconQuery}
                onChange={(event) => setIconQuery(event.target.value)}
                placeholder="Search icons"
              />
            </label>
            <div className="icon-picker" role="listbox" aria-label="Knowledge hub icon">
              {filteredIcons.map((option) => (
                <button
                  aria-label={option.label}
                  aria-selected={icon === option.id}
                  className={icon === option.id ? 'active' : ''}
                  key={option.id}
                  onClick={() => setIcon(option.id)}
                  role="option"
                  title={option.label}
                  type="button"
                >
                  <CollectionIcon icon={option.id} />
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
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
