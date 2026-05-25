import { FormEvent } from 'react'

type AnswerComposerProps = {
  blocked: boolean
  busy: string | null
  model?: string | null
  prompt: string
  onAsk: (event: FormEvent) => Promise<void>
  onPromptChange: (value: string) => void
}

export function AnswerComposer({
  blocked,
  busy,
  model,
  prompt,
  onAsk,
  onPromptChange
}: AnswerComposerProps): React.JSX.Element {
  return (
    <form className="chat-form" onSubmit={onAsk}>
      <div className="section-heading">
        <h2>Ask</h2>
        <span>{model ?? 'No model'}</span>
      </div>
      <textarea
        value={prompt}
        onChange={(event) => onPromptChange(event.target.value)}
        placeholder="Ask this Hub and the current page"
      />
      <button type="submit" disabled={Boolean(busy) || !prompt.trim() || blocked}>
        Ask ÆTHER
      </button>
    </form>
  )
}
