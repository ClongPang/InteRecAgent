import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  ApiError,
  acceptTurn,
  cancelTurn,
  createConversation,
  loadConversation,
  retryTurn,
  streamConversation,
} from './conversation/client'
import type {
  AssistantEnvelope,
  Candidate,
  Claim,
  ConversationEvent,
  ConversationProjection,
  Message,
  TurnInput,
} from './conversation/types'

const CONVERSATION_KEY = 'interec-conversation-id'
const TOKEN_KEY = 'interec-auth-token'
const TERMINAL_FAILURES = new Set(['FAILED', 'CANCELLED', 'TIMED_OUT', 'DEAD_LETTER'])

const EVENT_LABELS: Record<string, string> = {
  'turn.accepted': '请求已进入队列',
  'turn.claimed': 'Agent 已接手',
  'turn.started': '正在理解并规划',
  'turn.plan_committed': '计划已确认',
  'research.started': '正在检索报价',
  'research.completed': '证据已整理',
  'assistant.message.committed': '回复已发布',
  'turn.completed': '回复已发布',
  'turn.failed': '本轮执行失败',
  'turn.cancelled': '本轮已取消',
  'turn.timed_out': '本轮已超时',
}

function displayError(error: unknown): string {
  const code = error instanceof Error ? error.message : 'UNKNOWN_ERROR'
  const labels: Record<string, string> = {
    AUTHENTICATION_REQUIRED: '身份令牌无效或已过期，请重新连接。',
    CONVERSATION_NOT_FOUND: '这段会话不存在或不属于当前账号。',
    REVISION_CONFLICT: '会话刚刚发生了更新，请刷新后重试。',
    CONVERSATION_TURN_ACTIVE: '上一轮仍在处理，请等待或先取消。',
    TURN_NOT_RETRYABLE: '这一轮当前不能重试。',
  }
  return labels[code] ?? `暂时无法完成：${code}`
}

function formatMoney(amount: string): string {
  const value = Number(amount)
  return Number.isFinite(value)
    ? new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 0 }).format(value)
    : `${amount} CNY`
}

function messageText(message: Message): string {
  if (message.role === 'USER') {
    if (message.payload.type === 'MESSAGE') return String(message.payload.content ?? '')
    if (message.payload.type === 'SET_COMPARISON') return '更新了对比清单'
    if (message.payload.type === 'UNDO') return `恢复到第 ${String(message.payload.revision)} 版目标`
    return '更新了选购条件'
  }
  return String(message.payload.text ?? '')
}

function disclosureText(code: string): string {
  const known: Record<string, string> = {
    PRICE_AND_FX_ESTIMATE: '人民币金额来自有时间戳的汇率快照，税费、运费和支付成本以商家结算页为准。',
    PROVIDER_COVERAGE_LIMITED: '结果只覆盖本轮已检索并通过证据校验的来源，不代表全网最低价。',
    PARTIAL_PROVIDER_COVERAGE: '部分市场暂时无法完成检索，当前结果只覆盖成功返回的市场。',
    PROVIDER_UNAVAILABLE: '本轮没有市场成功返回可验证结果。',
    FX_ESTIMATE: '人民币金额按有时间戳的汇率快照估算。',
    EXCLUDES_TAX_SHIPPING_PAYMENT: '估算金额不包含税费、运费和支付环节可能产生的费用。',
    MERCHANT_CHECKOUT_FINAL: '最终价格与可购买状态以商家结算页为准。',
    STOCK_UNKNOWN: '部分候选的库存状态尚未得到可靠证明。',
    CONDITION_UNKNOWN: '部分候选的成色尚未得到可靠证明。',
    DETERMINISTIC_OFFER_ORDER_NOT_PRODUCT_QUALITY: '候选顺序只按市场证据、库存证据和同层价格确定，不代表产品质量、口碑或综合体验排名。',
    UNVERIFIED_RESULTS_NOT_RECOMMENDED: '检索到了商品，但没有结果通过完整的身份与市场证据校验，因此本轮不做推荐。',
    DISCOVERY_OFFER_IDENTITY_ONLY: '这些结果用于发现和缩小范围；当前只确认了报价，尚未建立可跨商家合并的商品身份。',
    LOCAL_CANDIDATE_CACHE: '本轮优先复用了仍在有效期内的本地候选与原始证据。',
  }
  return known[code] ?? code.split('_').join(' ').toLowerCase()
}

function AssistantContent({ message, onOffer }: { message: Message; onOffer: (offerRef: string) => void }) {
  const envelope = message.payload.envelope as AssistantEnvelope | undefined
  const claims = (message.payload.claimLedger as { claims?: Claim[] } | undefined)?.claims ?? []
  const claimById = new Map(claims.map((claim) => [claim.claimId, claim]))
  const citedRefs = new Set<string>()
  claims.forEach((claim) => claim.offerRefs.forEach((ref) => citedRefs.add(ref)))

  if (!envelope) return <p>{messageText(message)}</p>
  return (
    <>
      <div className="message-blocks">
        {envelope.blocks.map((block, index) => {
          if (block.type === 'TRANSITION') return <p key={index}>{block.text}</p>
          if (block.type === 'QUESTION') return <p className="assistant-question" key={index}>{block.wording}</p>
          if (block.type === 'DISCLOSURE') return <p className="assistant-disclosure" key={index}>{disclosureText(block.disclosureCode)}</p>
          if (block.type === 'CLAIM') return <p key={index}>{claimById.get(block.claimId)?.renderedText}</p>
          return <p key={index}>{block.claimIds.map((id) => claimById.get(id)?.renderedText).filter(Boolean).join('；')}</p>
        })}
      </div>
      {citedRefs.size > 0 && (
        <div className="message-citations" aria-label="这条回复引用的候选">
          {[...citedRefs].map((ref) => <button key={ref} onClick={() => onOffer(ref)}>查看候选证据</button>)}
        </div>
      )}
    </>
  )
}

function GoalBar({ projection, onClearBudget, disabled }: {
  projection: ConversationProjection
  onClearBudget: () => void
  disabled: boolean
}) {
  const goal = projection.state.goalRevision?.goal
  if (!goal) return <div className="goal-empty">还没有选购条件，直接告诉我你想买什么。</div>
  return (
    <div className="goal-bar" aria-label="当前选购条件">
      <span className="goal-label">当前目标</span>
      {goal.target && <span className="condition-chip">{goal.target.canonicalModel ?? goal.target.targetText ?? goal.target.categoryId}</span>}
      {goal.budget && <span className="condition-chip removable">预算 {goal.budget.amount} {goal.budget.currency}<button aria-label="移除预算" disabled={disabled} onClick={onClearBudget}>×</button></span>}
      {goal.retrievalMarkets.map((market) => <span className="condition-chip" key={market}>{market} 市场</span>)}
      {goal.stockPreference === 'KNOWN_IN_STOCK' && <span className="condition-chip">仅看有货</span>}
      {goal.hardConstraints.map((item) => <span className="condition-chip" key={item.key}>{item.key}</span>)}
      {goal.unresolved.length > 0 && <span className="condition-chip pending">还需确认 {goal.unresolved.length} 项</span>}
    </div>
  )
}

function CandidateCard({ candidate, rank, focused, selected, rejected, onFocus, onToggleCompare }: {
  candidate: Candidate
  rank: number | null
  focused: boolean
  selected: boolean
  rejected: boolean
  onFocus: () => void
  onToggleCompare: () => void
}) {
  return (
    <article id={`offer-${candidate.offerRef}`} className={`candidate-card${focused ? ' focused' : ''}${rejected ? ' rejected' : ''}`}>
      <button className="candidate-main" onClick={onFocus} aria-label={`和 Agent 聊聊 ${candidate.title}`}>
        <div className="candidate-kicker"><span>{rank ? `候选 ${rank}` : rejected ? '已排除' : '候选池'}</span><span>{candidate.retrievalMarket}</span><span className={`support-badge ${candidate.discovery?.supportLevel === 'DISCOVERY' ? 'discovery' : candidate.discovery?.supportLevel === 'VERIFIED' ? 'verified' : 'unknown'}`}>{candidate.discovery?.supportLevel === 'DISCOVERY' ? '发现级' : candidate.discovery?.supportLevel === 'VERIFIED' ? '已验证' : '级别未知'}</span></div>
        <h3>{candidate.title}</h3>
        <strong>{formatMoney(candidate.cnyAmount)}</strong>
        <dl>
          <div><dt>商家</dt><dd>{candidate.merchant}</dd></div>
          <div><dt>库存</dt><dd>{candidate.stock === 'IN_STOCK' ? '有货' : candidate.stock === 'OUT_OF_STOCK' ? '缺货' : '待确认'}</dd></div>
          <div><dt>成色</dt><dd>{candidate.condition}</dd></div>
        </dl>
        {candidate.rankingReasonCodes?.includes('LEXICOGRAPHIC_RANK_VECTOR_V1') && (
          <p className="ranking-note">
            排序：市场证据 → 库存证据 → 同层价格；{candidate.marketEvidenceLevel === 'TARGET_DOMAIN_MARKET_CONSISTENT' ? '目标站点域名与市场一致' : '仅有 Provider 市场标注'}
          </p>
        )}
        {candidate.discovery?.identityLevel === 'OFFER_ONLY' && <p className="discovery-note">报价级候选：不会在缺少 GTIN/MPN 等证据时合并为同一商品。</p>}
      </button>
      {!rejected && <button className={`compare-toggle${selected ? ' selected' : ''}`} onClick={onToggleCompare} aria-pressed={selected}>{selected ? '已加入对比' : '加入对比'}</button>}
    </article>
  )
}

function tokenFromEnvironment(): string {
  return (import.meta.env.VITE_AUTH_TOKEN ?? '').trim()
}

export default function App() {
  const [token, setToken] = useState(() => tokenFromEnvironment() || sessionStorage.getItem(TOKEN_KEY) || '')
  const [tokenDraft, setTokenDraft] = useState('')
  const [conversationId, setConversationId] = useState(() => localStorage.getItem(CONVERSATION_KEY))
  const [projection, setProjection] = useState<ConversationProjection | null>(null)
  const [composer, setComposer] = useState('')
  const [focusedRef, setFocusedRef] = useState<string | null>(null)
  const [compareRefs, setCompareRefs] = useState<string[]>([])
  const [events, setEvents] = useState<ConversationEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(Boolean(token && conversationId))
  const [drawerOpen, setDrawerOpen] = useState(false)
  const streamCursor = useRef(0)
  const messageEnd = useRef<HTMLDivElement | null>(null)

  const refresh = useCallback(async (id = conversationId, auth = token) => {
    if (!id || !auth) return null
    const next = await loadConversation(id, auth)
    setProjection(next)
    streamCursor.current = Math.max(streamCursor.current, next.eventCursor)
    setCompareRefs(next.state.workingSet?.comparisonOfferRefs ?? [])
    return next
  }, [conversationId, token])

  useEffect(() => {
    if (!conversationId || !token) { setLoading(false); return }
    let active = true
    setLoading(true)
    refresh(conversationId, token)
      .catch((failure) => {
        if (!active) return
        if (failure instanceof ApiError && failure.status === 404) {
          localStorage.removeItem(CONVERSATION_KEY)
          setConversationId(null)
          setProjection(null)
        } else setError(displayError(failure))
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [conversationId, token, refresh])

  useEffect(() => {
    if (!conversationId || !token) return
    const controller = new AbortController()
    const follow = async () => {
      while (!controller.signal.aborted) {
        try {
          streamCursor.current = await streamConversation(conversationId, token, streamCursor.current, controller.signal, (event) => {
            streamCursor.current = Math.max(streamCursor.current, event.seq)
            setEvents((current) => [...current, event].slice(-6))
            void refresh(conversationId, token).catch((failure) => setError(displayError(failure)))
          })
        } catch (failure) {
          if (controller.signal.aborted) return
          setError(displayError(failure))
          await new Promise((resolve) => window.setTimeout(resolve, 1200))
        }
      }
    }
    void follow()
    return () => controller.abort()
  }, [conversationId, token, refresh])

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [projection?.messages.length])

  const workingSet = projection?.state.workingSet
  const candidateByRef = useMemo(() => new Map(workingSet?.pool.map((candidate) => [candidate.offerRef, candidate]) ?? []), [workingSet])
  const displayCandidates = workingSet?.displayOfferRefs.map((ref) => candidateByRef.get(ref)).filter((item): item is Candidate => Boolean(item)) ?? []
  const rejectedCandidates = workingSet?.rejectedOfferRefs.map((ref) => candidateByRef.get(ref)).filter((item): item is Candidate => Boolean(item)) ?? []
  const focusedCandidate = focusedRef ? candidateByRef.get(focusedRef) ?? null : null
  const running = Boolean(projection?.activeTurn)
  const failedTurn = projection?.latestTurn && TERMINAL_FAILURES.has(projection.latestTurn.status) ? projection.latestTurn : null

  const ensureConversation = async (): Promise<{ id: string; revision: number }> => {
    if (conversationId && projection) return { id: conversationId, revision: projection.conversation.currentRevision }
    const id = await createConversation(token)
    localStorage.setItem(CONVERSATION_KEY, id)
    setConversationId(id)
    setProjection(await loadConversation(id, token))
    return { id, revision: 0 }
  }

  const sendInput = async (input: TurnInput) => {
    if (!token || running) return
    setError(null)
    try {
      const conversation = await ensureConversation()
      await acceptTurn(conversation.id, token, input, conversation.revision)
      await refresh(conversation.id, token)
    } catch (failure) {
      setError(displayError(failure))
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const text = composer.trim()
    if (!text || running) return
    setComposer('')
    await sendInput({ type: 'MESSAGE', content: text, ...(focusedCandidate ? { focusOfferRef: focusedCandidate.offerRef } : {}) })
  }

  const connect = (event: FormEvent) => {
    event.preventDefault()
    const next = tokenDraft.trim()
    if (!next) return
    sessionStorage.setItem(TOKEN_KEY, next)
    setToken(next)
    setTokenDraft('')
    setError(null)
  }

  const startNew = () => {
    localStorage.removeItem(CONVERSATION_KEY)
    setConversationId(null)
    setProjection(null)
    setEvents([])
    setFocusedRef(null)
    setCompareRefs([])
    streamCursor.current = 0
  }

  const focusOffer = (offerRef: string) => {
    setFocusedRef(offerRef)
    setDrawerOpen(true)
    document.getElementById(`offer-${offerRef}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const applyNextMove = (operation: Record<string, unknown>) => {
    const kind = String(operation.kind ?? '')
    if (kind.startsWith('GOAL_')) {
      const { source: _source, ...unbound } = operation
      void sendInput({ type: 'PATCH_GOAL', operations: [unbound] })
    } else if (kind === 'UNDO_REVISION') {
      void sendInput({ type: 'UNDO', revision: Number(operation.revision) })
    } else if (kind === 'SET_COMPARISON' && Array.isArray(operation.referents)) {
      const refs = operation.referents
        .filter((referent): referent is { kind: string; offerRef: string } => Boolean(referent && typeof referent === 'object' && (referent as { kind?: string }).kind === 'OFFER_REF'))
        .map((referent) => referent.offerRef)
      if (refs.length >= 2) void sendInput({ type: 'SET_COMPARISON', offerRefs: refs })
    }
  }

  if (!token) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <span className="brand-mark">IR</span>
          <p className="eyebrow">INTEREC CONVERSATIONAL AGENT</p>
          <h1>连接你的推荐 Agent</h1>
          <p>浏览器只提交已签名的访问令牌，不自行生成租户或用户身份。开发环境可在这里临时连接。</p>
          <form onSubmit={connect}>
            <label htmlFor="access-token">访问令牌</label>
            <textarea id="access-token" rows={4} value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} autoComplete="off" />
            <button className="primary-button" disabled={!tokenDraft.trim()}>连接</button>
          </form>
        </section>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">IR</span><div><b>InteRecAgent</b><small>pi-agent 驱动的跨市场选购助手</small></div></div>
        <div className="top-actions"><span className="connection-dot">已连接</span><button onClick={startNew}>新对话</button></div>
      </header>

      {projection && <GoalBar projection={projection} disabled={running} onClearBudget={() => void sendInput({ type: 'PATCH_GOAL', operations: [{ opId: crypto.randomUUID(), kind: 'GOAL_CLEAR_BUDGET' }] })} />}

      <div className="workspace">
        <section className="conversation-pane" aria-label="与推荐 Agent 的对话">
          <div className="thread-header">
            <div><p className="eyebrow">CONVERSATION</p><h1>{projection ? '继续聊这次选购' : '今天想买什么？'}</h1></div>
            {projection && <span>状态版本 {projection.conversation.currentRevision}</span>}
          </div>

          <div className="message-list" aria-live="polite">
            {!projection?.messages.length && !loading && (
              <div className="welcome-message">
                <span className="agent-avatar">A</span>
                <div><b>我是你的选购 Agent。</b><p>说出商品、预算、在哪些市场购买，以及你最在意的条件。我会在同一段对话里持续维护候选和比较结果。</p></div>
              </div>
            )}
            {projection?.messages.map((message) => (
              <article className={`message ${message.role.toLowerCase()}`} key={message.id}>
                <div className="message-meta"><span>{message.role === 'USER' ? '你' : 'Agent'}</span><time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>
                {message.role === 'ASSISTANT'
                  ? <AssistantContent message={message} onOffer={focusOffer} />
                  : <p>{messageText(message)}</p>}
              </article>
            ))}
            {running && <div className="agent-working"><span /><span /><span /><b>{events.at(-1) ? EVENT_LABELS[events.at(-1)!.eventType] ?? 'Agent 正在处理' : 'Agent 正在接手这一轮'}</b></div>}
            {failedTurn && !running && (
              <div className="turn-failure" role="alert">
                <b>这一轮没有完成</b><span>{failedTurn.errorCode ?? failedTurn.status}</span>
                <button onClick={() => void retryTurn(projection!.conversation.id, failedTurn.id, token, projection!.conversation.currentRevision).then(() => refresh()).catch((failure) => setError(displayError(failure)))}>重试这一轮</button>
              </div>
            )}
            <div ref={messageEnd} />
          </div>

          {projection?.latestAssistantMessage?.payload.envelope?.nextMoves?.length ? (
            <div className="quick-moves" aria-label="Agent 建议的下一步">
              {projection.latestAssistantMessage.payload.envelope.nextMoves.map((move) => <button key={move.id} disabled={running} onClick={() => applyNextMove(move.operation)}>{move.label}</button>)}
            </div>
          ) : null}

          {events.length > 0 && <div className="progress-line" aria-label="本轮进度">{events.map((event) => <span key={event.id}>{EVENT_LABELS[event.eventType] ?? event.eventType}</span>)}</div>}
          {error && <div className="inline-error" role="alert">{error}<button onClick={() => setError(null)}>关闭</button></div>}

          <form className="composer" onSubmit={submit}>
            {focusedCandidate && <div className="focus-context">正在聊：<b>{focusedCandidate.title}</b><button type="button" onClick={() => { setFocusedRef(null); setDrawerOpen(false) }}>取消聚焦</button></div>}
            <label className="sr-only" htmlFor="message-composer">给推荐 Agent 发消息</label>
            <textarea id="message-composer" rows={3} value={composer} disabled={running} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() }
            }} placeholder={focusedCandidate ? '继续问这个候选，例如“它的库存证据可靠吗？”' : '例如：想买降噪耳机，预算 2500 元，对比美国和新加坡'} />
            <div className="composer-actions">
              <span>Enter 发送 · Shift+Enter 换行</span>
              {running && <button type="button" className="secondary-button" onClick={() => void cancelTurn(projection!.conversation.id, projection!.activeTurn!.id, token).then(() => refresh()).catch((failure) => setError(displayError(failure)))}>取消本轮</button>}
              <button className="primary-button" disabled={running || !composer.trim()}>{projection ? '发送' : '开始对话'}</button>
            </div>
          </form>
        </section>

        <aside className="candidate-pane" aria-label="候选工作区">
          <div className="candidate-header"><div><p className="eyebrow">WORKING SET</p><h2>候选工作区</h2></div><span>{displayCandidates.length} 个可比较</span></div>
          {!displayCandidates.length ? (
            <div className="candidate-empty"><div className="empty-orbit">◎</div><b>候选会出现在这里</b><p>Agent 会先理解你的条件，再研究、校验证据并维护一个可继续讨论的候选世界。</p></div>
          ) : (
            <div className="candidate-list">
              {displayCandidates.map((candidate, index) => <CandidateCard key={candidate.offerRef} candidate={candidate} rank={index + 1} focused={focusedRef === candidate.offerRef} selected={compareRefs.includes(candidate.offerRef)} rejected={false} onFocus={() => focusOffer(candidate.offerRef)} onToggleCompare={() => setCompareRefs((current) => current.includes(candidate.offerRef) ? current.filter((ref) => ref !== candidate.offerRef) : current.length < 4 ? [...current, candidate.offerRef] : current)} />)}
              {rejectedCandidates.length > 0 && <details className="rejected-group"><summary>已排除 {rejectedCandidates.length} 个</summary>{rejectedCandidates.map((candidate) => <CandidateCard key={candidate.offerRef} candidate={candidate} rank={null} focused={focusedRef === candidate.offerRef} selected={false} rejected onFocus={() => focusOffer(candidate.offerRef)} onToggleCompare={() => undefined} />)}</details>}
            </div>
          )}
          {compareRefs.length > 0 && <div className="compare-tray"><span>已选 {compareRefs.length}/4</span><button className="primary-button" disabled={running || compareRefs.length < 2} onClick={() => void sendInput({ type: 'SET_COMPARISON', offerRefs: compareRefs })}>比较所选</button></div>}
        </aside>
      </div>

      {drawerOpen && focusedCandidate && (
        <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)}>
          <aside className="candidate-drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" onClick={(event) => event.stopPropagation()}>
            <button className="drawer-close" aria-label="关闭候选详情" onClick={() => setDrawerOpen(false)}>×</button>
            <p className="eyebrow">CANDIDATE DETAIL</p><h2 id="drawer-title">{focusedCandidate.title}</h2>
            <strong className="drawer-price">{formatMoney(focusedCandidate.cnyAmount)}</strong>
            <dl><div><dt>市场</dt><dd>{focusedCandidate.retrievalMarket}</dd></div><div><dt>商家</dt><dd>{focusedCandidate.merchant}</dd></div><div><dt>库存</dt><dd>{focusedCandidate.stock}</dd></div><div><dt>身份</dt><dd>{focusedCandidate.canonicalModel ?? '待确认'}</dd></div><div><dt>证据声明</dt><dd>{focusedCandidate.claimIds.length} 条</dd></div></dl>
            <button className="primary-button" onClick={() => { setComposer('这个候选为什么值得考虑？'); setDrawerOpen(false) }}>问问这个</button>
          </aside>
        </div>
      )}
    </main>
  )
}
