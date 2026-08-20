export function merchantHref(url: string | null | undefined): string | null {
  const raw = (url || '').trim()
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    if (parsed.hostname.includes('buywhere.') && parsed.pathname.startsWith('/api/click')) {
      const inner = parsed.searchParams.get('url')
      return inner && inner.startsWith('https://') ? inner : null
    }
    if (parsed.protocol === 'https:' && !parsed.hostname.includes('buywhere.')) {
      return raw
    }
  } catch {
    return null
  }
  return null
}

export function merchantHost(url: string | null | undefined): string | null {
  const href = merchantHref(url)
  if (!href) return null
  try {
    return new URL(href).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}
