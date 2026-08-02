export async function writeClipboardText(text: string): Promise<void> {
  let clipboardError: unknown
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch (error) {
      clipboardError = error
    }
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) {
    throw clipboardError instanceof Error ? clipboardError : new Error('Clipboard is unavailable.')
  }
}
