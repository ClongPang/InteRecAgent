import type { FormEvent } from 'react'

export interface AuthScreenProps {
  tokenDraft: string
  onTokenDraftChange: (value: string) => void
  onConnect: (token: string) => void
  connecting?: boolean
  error?: string | null
}

export function AuthScreen({
  tokenDraft,
  onTokenDraftChange,
  onConnect,
  connecting = false,
  error = null,
}: AuthScreenProps) {
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onConnect(tokenDraft)
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <span className="brand-mark">BQ</span>
        <p className="eyebrow">BUYWHERE QUOTE ASSISTANT</p>
        <h1>{connecting ? '正在连接报价助手' : '连接报价助手'}</h1>
        {connecting ? (
          <p className="auth-status" role="status">正在建立本地开发会话…</p>
        ) : (
          <>
            <p>连接后可查询已知型号的新加坡报价线索。</p>
            {error && <p className="auth-error" role="alert">{error}</p>}
            <form onSubmit={submit}>
              <label htmlFor="access-token">访问令牌</label>
              <textarea
                id="access-token"
                rows={4}
                value={tokenDraft}
                onChange={(event) => onTokenDraftChange(event.target.value)}
                autoComplete="off"
              />
              <button className="primary-button" disabled={!tokenDraft.trim()}>连接</button>
            </form>
          </>
        )}
      </section>
    </main>
  )
}
