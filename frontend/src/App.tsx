import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { renderDisclosureCode } from '@interec/domain/assistant-envelope'

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
import { renderGoalAttribute } from './goal-presentation'

const CONVERSATION_KEY = 'interec-conversation-id'
const TOKEN_KEY = 'interec-auth-token'
const TERMINAL_FAILURES = new Set(['FAILED', 'CANCELLED', 'TIMED_OUT', 'DEAD_LETTER'])

const EVENT_LABELS: Record<string, string> = {
  'turn.accepted': '请求已进入队列',
  'turn.claimed': 'Agent 已接手',
  'turn.started': '正在理解并规划',
  'turn.plan_committed': '计划已确认',
  'search.started': '正在检索报价',
  'search.completed': '来源信息已整理',
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
    NO_PENDING_CLARIFICATION: '这个问题已经不再等待回答，请按当前对话继续。',
    STALE_CLARIFICATION_ID: '这个问题已经更新或失效，请回答最新的问题。',
    INVALID_CLARIFICATION_OPTION: '这个选项不属于当前问题，请选择最新提供的选项。',
    CLARIFICATION_SKIP_NOT_ALLOWED: '这个问题是继续处理所必需的，暂时不能跳过。',
  }
  return labels[code] ?? '暂时无法完成这次操作，请重试或换一种说法继续。'
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
    if (message.payload.type === 'ANSWER_CLARIFICATION') {
      const answer = message.payload.answer as { type?: string; optionId?: string; text?: string } | undefined
      if (answer?.type === 'SKIP') return '暂时跳过这个条件'
      if (answer?.type === 'OPTION') return `选择了：${String(answer.optionId ?? '')}`
      return String(answer?.text ?? '')
    }
    return '更新了选购条件'
  }
  return String(message.payload.text ?? '')
}

function AssistantContent({ message, onOffer, activeClarificationId, disabled, onClarificationAnswer }: {
  message: Message
  onOffer: (offerRef: string) => void
  activeClarificationId: string | null
  disabled: boolean
  onClarificationAnswer: (clarificationId: string, answer: { type: 'OPTION'; optionId: string } | { type: 'SKIP' }) => void
}) {
  const envelope = message.payload.envelope as AssistantEnvelope | undefined
  const claims = (message.payload.groundedClaims as { claims?: Claim[] } | undefined)?.claims ?? []
  const claimById = new Map(claims.map((claim) => [claim.claimId, claim]))
  const citedRefs = new Set<string>()
  claims.forEach((claim) => claim.offerRefs.forEach((ref) => citedRefs.add(ref)))

  if (!envelope) return <p>{messageText(message)}</p>
  return (
    <>
      <div className="message-blocks">
        {envelope.blocks.map((block, index) => {
          if (block.type === 'TRANSITION') return <p key={index}>{block.text}</p>
          if (block.type === 'QUESTION') {
            const active = block.clarificationId === activeClarificationId
            return (
              <section className="assistant-question" key={index} aria-label="需要补充的信息">
                <p>{block.wording}</p>
                <small>{block.rationale}</small>
                {active && block.responseSpec.options.length > 0 && (
                  <div className="clarification-options">
                    {block.responseSpec.options.map((option) => <button key={option.id} disabled={disabled} onClick={() => onClarificationAnswer(block.clarificationId, { type: 'OPTION', optionId: option.id })}>{option.label}</button>)}
                  </div>
                )}
                {active && block.responseSpec.allowSkip && <button className="clarification-skip" disabled={disabled} onClick={() => onClarificationAnswer(block.clarificationId, { type: 'SKIP' })}>暂时跳过</button>}
                {active && block.responseSpec.examples.length > 0 && <span className="clarification-examples">也可以直接回答，例如：{block.responseSpec.examples.join('、')}</span>}
              </section>
            )
          }
          if (block.type === 'DISCLOSURE') return <p className="assistant-disclosure" key={index}>{renderDisclosureCode(block.disclosureCode)}</p>
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
      {goal.hardConstraints.map((item) => <span className="condition-chip" key={`constraint:${item.key}`}>{renderGoalAttribute(item)}</span>)}
      {goal.preferences.map((item) => <span className="condition-chip" key={`preference:${item.key}`}>偏好：{renderGoalAttribute(item)}</span>)}
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
        <div className="candidate-kicker"><span>{rank ? `候选 ${rank}` : rejected ? '已排除' : '候选池'}</span><span>{candidate.retrievalMarket}</span><span className={`support-badge ${candidate.ranking?.validationMode === 'SEARCH_ONLY' ? 'search-only' : candidate.ranking?.validationMode === 'RULE_VALIDATED' ? 'rule-validated' : 'unknown'}`}>{candidate.ranking?.validationMode === 'SEARCH_ONLY' ? '仅搜索' : candidate.ranking?.validationMode === 'RULE_VALIDATED' ? '规则校验通过' : '校验级别未知'}</span></div>
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
        {candidate.ranking?.identityResolution === 'LISTING_LEVEL' && <p className="listing-level-note">报价级候选：不会在缺少 GTIN/MPN 等证据时合并为同一商品。</p>}
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
  const pendingClarification = projection?.state.dialogue.pendingClarification ?? null

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
    await sendInput(pendingClarification
      ? { type: 'ANSWER_CLARIFICATION', clarificationId: pendingClarification.clarificationId, answer: { type: 'TEXT', text } }
      : { type: 'MESSAGE', content: text, ...(focusedCandidate ? { focusOfferRef: focusedCandidate.offerRef } : {}) })
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
                  ? <AssistantContent
                      message={message}
                      onOffer={focusOffer}
                      activeClarificationId={pendingClarification?.clarificationId ?? null}
                      disabled={running}
                      onClarificationAnswer={(clarificationId, answer) => void sendInput({ type: 'ANSWER_CLARIFICATION', clarificationId, answer })}
                    />
                  : <p>{messageText(message)}</p>}
              </article>
            ))}
            {running && <div className="agent-working"><span /><span /><span /><b>{events.at(-1) ? EVENT_LABELS[events.at(-1)!.eventType] ?? 'Agent 正在处理' : 'Agent 正在接手这一轮'}</b></div>}
            {failedTurn && !running && (
              <div className="turn-failure" role="alert">
                <b>这一轮没有完成</b><span>系统未能完成本轮执行，当前选购状态没有被更改。可以重试，或换一种说法继续。</span>
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
            }} placeholder={pendingClarification ? '也可以用自然语言回答上面的问题' : focusedCandidate ? '继续问这个候选，例如“它的库存证据可靠吗？”' : '例如：想买降噪耳机，预算 2500 元，对比美国和新加坡'} />
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
            <div className="candidate-empty"><div className="empty-orbit">◎</div><b>候选会出现在这里</b><p>Agent 会先理解你的条件，再搜索商品、核对来源字段并维护可继续讨论的会话候选状态。</p></div>
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
            <dl><div><dt>市场</dt><dd>{focusedCandidate.retrievalMarket}</dd></div><div><dt>商家</dt><dd>{focusedCandidate.merchant}</dd></div><div><dt>库存</dt><dd>{focusedCandidate.stock}</dd></div><div><dt>规则解析型号</dt><dd>{focusedCandidate.canonicalModel ?? '待确认'}</dd></div><div><dt>有来源依据的信息</dt><dd>{focusedCandidate.claimIds.length} 条</dd></div></dl>
            <button className="primary-button" onClick={() => { setComposer('这个候选为什么值得考虑？'); setDrawerOpen(false) }}>问问这个</button>
          </aside>
        </div>
      )}
    </main>
  )
}
