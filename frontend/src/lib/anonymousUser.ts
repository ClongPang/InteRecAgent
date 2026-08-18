const STORAGE_KEY = 'interecagent.anonymousUserId'

export function getAnonymousUserId(): string {
  const existing = localStorage.getItem(STORAGE_KEY)
  if (existing && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)) {
    return existing
  }
  const id = crypto.randomUUID()
  localStorage.setItem(STORAGE_KEY, id)
  return id
}
