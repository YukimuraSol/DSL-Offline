/** 把一段文本放进剪贴板：优先 async Clipboard，回退 execCommand（file:// 下也能用）。 */
export function copyText(value: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(value).then(() => true).catch(() => Promise.resolve(legacyCopy(value)))
  }
  return Promise.resolve(legacyCopy(value))
}

function legacyCopy(value: string): boolean {
  try {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}
