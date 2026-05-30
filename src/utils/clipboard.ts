/**
 * Copy text to the system clipboard.
 *
 * `navigator.clipboard.writeText` is only defined in **secure contexts**
 * (HTTPS or `localhost`). When the demo is served to a phone over plain
 * HTTP on a LAN IP (`http://192.168.x.x:8080`), the modern API is
 * missing and the call throws — fall back to the legacy
 * `document.execCommand('copy')` + offscreen textarea trick, which is
 * deprecated but supported everywhere and works in non-secure contexts.
 *
 * Returns `true` if the copy succeeded. Callers can branch on this to
 * decide whether to show a confirmation toast.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false

  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // fall through to the legacy path
    }
  }

  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.left = '0'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  ta.setSelectionRange(0, text.length)
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(ta)
  }
}
