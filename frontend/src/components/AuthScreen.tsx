import type { FormEvent } from 'react'

export interface AuthScreenProps {
  tokenDraft: string
  onTokenDraftChange: (value: string) => void
  onConnect: (token: string) => void
}

export function AuthScreen({
  tokenDraft,
  onTokenDraftChange,
  onConnect,
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
        <h1>连接报价助手</h1>
        <p>浏览器仅提交已签名的访问令牌。连接后可查询已知型号的新加坡报价线索。</p>
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
      </section>
    </main>
  )
}
