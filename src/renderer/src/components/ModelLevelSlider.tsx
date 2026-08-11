import { HardDriveDownload } from 'lucide-react'
import { ModelDownloadChoice } from '../../../shared/aether'
import { ChatModelRung } from '../utils/aether-ui'

interface ModelLevelSliderProps {
  rungs: ChatModelRung[]
  activeModel?: string | null
  disabled: boolean
  // Raw filenames on the rung tooltips, for Developer Mode. The visible labels stay
  // branded either way: a gguf filename does not fit a control this size, and the
  // developer-mode panel already lists the full paths.
  developerMode: boolean
  onSelect: (model: string) => void
  onInstall: (choice: ModelDownloadChoice) => void
}

/**
 * Chat model as a position on a scale, not an item in a list.
 *
 * A dropdown was the wrong control for this: it is either absent (nothing
 * installed) or has two options, and it hid the fact that a second model exists at
 * all. The rungs are ordered by capability, so moving right always means more model
 * and more time, and a model that is *not* installed keeps its position on the
 * scale — greyed, but present, and clicking it opens the installer on that model.
 *
 * `aria-disabled` rather than `disabled` on a gap rung is deliberate: the rung is
 * not a valid *selection*, but it is very much operable, and `disabled` would take
 * it out of the tab order and make the install route unreachable by keyboard.
 */
export function ModelLevelSlider({
  rungs,
  activeModel,
  disabled,
  developerMode,
  onSelect,
  onInstall,
}: ModelLevelSliderProps): React.JSX.Element {
  const activeIndex = rungs.findIndex((rung) => rung.model && rung.model === activeModel)

  return (
    <div className="model-level-slider" role="radiogroup" aria-label="Chat model">
      <div className="model-level-track" aria-hidden="true">
        {/* Positioned from the active index rather than from a CSS class per count,
            so the highlight animates between rungs and the component does not care
            how many there are. Hidden entirely when nothing is selected. */}
        {activeIndex >= 0 && (
          <span
            className="model-level-thumb"
            style={{
              width: `${100 / rungs.length}%`,
              left: `${(activeIndex * 100) / rungs.length}%`,
            }}
          />
        )}
      </div>

      <div className="model-level-rungs">
        {rungs.map((rung) => {
          const installed = Boolean(rung.model)
          const isActive = installed && rung.model === activeModel

          return (
            <button
              aria-checked={isActive}
              aria-disabled={!installed}
              aria-label={
                installed ? rung.name : `${rung.name} — not installed. Opens the installer.`
              }
              className={`model-level-rung${isActive ? ' is-active' : ''}${
                installed ? '' : ' is-missing'
              }`}
              // Only the *app* being busy disables these. A missing model is
              // expressed with aria-disabled so it stays clickable.
              disabled={disabled}
              key={rung.key}
              onClick={() => {
                if (rung.model) {
                  onSelect(rung.model)
                } else if (rung.installChoice) {
                  onInstall(rung.installChoice)
                }
              }}
              role="radio"
              title={
                installed
                  ? developerMode && rung.model
                    ? rung.model
                    : `${rung.name} — ${rung.detail}`
                  : `${rung.name} is not installed. Click to install.`
              }
              type="button"
            >
              <span className="model-level-name">{rung.name}</span>
              {!installed && <HardDriveDownload size={10} aria-hidden="true" />}
            </button>
          )
        })}
      </div>
    </div>
  )
}
