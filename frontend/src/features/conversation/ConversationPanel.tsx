import { useEffect, useRef, useState } from 'react'
import type { MissionView, ProductCandidate, RecommendationView, ThreadMessage } from '../../api/types'
import { Icon } from '../../components/ui/Icon'
import { MissionBrief } from './MissionBrief'
import { displayAmount, rmbAmount } from '../../lib/currency'
import { timeLabel } from '../../lib/format'
import { groupThread, lastUndoableChange } from '../../lib/thread'
import type { Currency } from '../../lib/currency'

function ChangeRow({ message, undoable, onUndo }: { message: ThreadMessage; undoable: boolean; onUndo: () => void }) {
  const isUndo = message.change_kind === 'undo'
  return (
    <div className={`change-row${isUndo ? ' is-undo' : ''}`}>
      <span className="change-source">系统</span>
      <span className="change-text">{message.text}</span>
      {message.created_at ? <span className="change-time">{timeLabel(message.created_at)}</span> : null}
      {undoable ? <button className="change-undo-button" onClick={onUndo}>撤销</button> : null}
    </div>
  )
}

function ChangeGroup({
  messages,
  undoableId,
  onUndo,
}: {
  messages: ThreadMessage[]
  undoableId: number | null
  onUndo: () => void
}) {
  const collapsible = messages.length > 2
  const [open, setOpen] = useState(!collapsible)
  const latest = messages[messages.length - 1]
  return (
    <div className="change-group">
      {collapsible ? (
        <button type="button" className="change-group-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="chevron" size={12} />
          条件变更 {messages.length} 次{open ? ' · 收起' : ` · 最新：${latest.text}`}
        </button>
      ) : null}
      {(open ? messages : [latest]).map((message) => (
        <ChangeRow key={message.sequence} message={message} undoable={message.sequence === undoableId} onUndo={onUndo} />
      ))}
    </div>
  )
}

function RecommendationCard({
  message,
  recommendation,
  currency,
  onOpen,
}: {
  message: ThreadMessage
  recommendation: RecommendationView | null | undefined
  currency: Currency
  onOpen: (product: ProductCandidate) => void
}) {
  const stale = Boolean(message.run_id && recommendation?.run_id && message.run_id !== recommendation.run_id)
  const primary = stale ? null : recommendation?.primary
  const alternatives = stale ? [] : recommendation?.alternatives ?? []
  const amount = primary ? displayAmount(rmbAmount(primary), currency) : null
  return (
    <div className={`thread-recommendation${stale ? ' is-stale' : ''}`}>
      <div className="thread-recommendation-head">
        <span>{stale ? '推荐 · 历史轮次' : '推荐'}</span>
        <small>
          {message.constraints_version ? `基于 V${message.constraints_version}` : ''}
          {message.created_at ? ` · ${timeLabel(message.created_at)}` : ''}
        </small>
      </div>
      {primary ? (
        <button type="button" className="rec-chip rec-chip-primary" onClick={() => onOpen(primary)}>
          {primary.title}
          <b>{amount ? `约 ¥${amount}` : '暂无人民币估算'}</b>
        </button>
      ) : (
        <p>{message.text}</p>
      )}
      {recommendation?.rationale?.length ? (
        <ul>
          {recommendation.rationale.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {alternatives.length > 0 ? (
        <div className="rec-alternatives">
          <span>备选</span>
          {alternatives.map((product) => (
            <button type="button" key={product.snapshot_id} className="rec-chip" onClick={() => onOpen(product)}>
              {product.title}
              <b>{displayAmount(rmbAmount(product), currency) ? `约 ¥${displayAmount(rmbAmount(product), currency)}` : '暂无估算'}</b>
            </button>
          ))}
        </div>
      ) : null}
      {recommendation?.tradeoffs?.length ? (
        <p className="rec-tradeoffs">
          <b>取舍</b>
          {recommendation.tradeoffs.join('；')}
        </p>
      ) : null}
    </div>
  )
}

function ThreadItem({
  message,
  recommendation,
  currency,
  onOpen,
  onClarify,
}: {
  message: ThreadMessage
  recommendation: RecommendationView | null | undefined
  currency: Currency
  onOpen: (product: ProductCandidate) => void
  onClarify: (text: string) => void
}) {
  if (message.kind === 'warning') {
    return (
      <div className="thread-warning" role="status">
        <Icon name="info" size={14} />
        <span>{message.text}</span>
      </div>
    )
  }
  if (message.kind === 'recommendation') {
    return <RecommendationCard message={message} recommendation={recommendation} currency={currency} onOpen={onOpen} />
  }
  if (message.kind === 'clarification') {
    const options = ['通勤降噪耳机', '27 寸 4K 显示器', '轻便徒步鞋']
    return (
      <div className="conversation-message agent">
        <div className="message-meta">选购助手{message.created_at ? ` · ${timeLabel(message.created_at)}` : ''}</div>
        <p>{message.text}</p>
        <div className="message-actions">
          {options.map((option) => (
            <button key={option} onClick={() => onClarify(option)}>{option}</button>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className={`conversation-message ${message.kind === 'user' ? 'user' : 'agent'}`}>
      <div className="message-meta">
        {message.kind === 'user' ? '你' : '选购助手'}
        {message.created_at ? ` · ${timeLabel(message.created_at)}` : ''}
      </div>
      <p>{message.text}</p>
    </div>
  )
}

export function Thread({
  messages,
  recommendation,
  currency,
  onOpen,
  onClarify,
  onUndo,
}: {
  messages: ThreadMessage[]
  recommendation: RecommendationView | null | undefined
  currency: Currency
  onOpen: (product: ProductCandidate) => void
  onClarify: (text: string) => void
  onUndo: () => void
}) {
  const blocks = groupThread(messages)
  const undoable = lastUndoableChange(messages)
  const containerRef = useRef<HTMLDivElement>(null)
  const [stickToBottom, setStickToBottom] = useState(true)
  useEffect(() => {
    const el = containerRef.current
    if (el && stickToBottom) el.scrollTop = el.scrollHeight
  }, [messages.length, stickToBottom])
  return (
    <div
      className="conversation-thread"
      aria-label="选购对话"
      ref={containerRef}
      onScroll={(event) => {
        const el = event.currentTarget
        setStickToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48)
      }}
    >
      {blocks.map((block) =>
        block.kind === 'single' ? (
          <ThreadItem
            key={block.key}
            message={block.message}
            recommendation={recommendation}
            currency={currency}
            onOpen={onOpen}
            onClarify={onClarify}
          />
        ) : (
          <ChangeGroup
            key={block.key}
            messages={block.messages}
            undoableId={undoable?.sequence ?? null}
            onUndo={onUndo}
          />
        ),
      )}
    </div>
  )
}

export function ConversationPanel({
  mission,
  messages,
  recommendation,
  selectedCount,
  canCompare,
  comparing,
  busy,
  currency,
  onSend,
  onUndo,
  onCompare,
  onOpen,
  onPreference,
}: {
  mission: MissionView
  messages: ThreadMessage[]
  recommendation: RecommendationView | null | undefined
  selectedCount: number
  canCompare: boolean
  comparing?: boolean
  busy: boolean
  currency: Currency
  onSend: (text: string) => void
  onUndo: () => void
  onCompare: () => void
  onOpen: (product: ProductCandidate) => void
  onPreference: (preference: MissionView['constraints']['preference']) => void
}) {
  const [draft, setDraft] = useState('')
  const undoable = lastUndoableChange(messages)
  const suggestions: { label: string; run: () => void; primary?: boolean }[] = []
  if (!comparing && canCompare) suggestions.push({ label: `对比所选（${selectedCount} 件）`, run: onCompare, primary: true })
  const query = mission.constraints.query || ''
  const audioLike = /耳机|降噪|头戴|入耳|耳塞/.test(query)
  if (!comparing && audioLike) {
    suggestions.push({ label: '优先降噪', run: () => onPreference('noise') })
    suggestions.push({ label: '优先续航', run: () => onPreference('battery') })
  }
  const submit = (event?: { preventDefault(): void }) => {
    event?.preventDefault()
    const text = draft.trim()
    if (!text || busy) return
    onSend(text)
    setDraft('')
  }
  return (
    <aside className={`conversation-panel ${messages.length <= 1 ? 'is-brief' : ''}`}>
      <div className="conversation-header">
        <div><span>选购助手</span></div>
        {undoable ? (
          <div className="conversation-header-actions">
            <button type="button" className="undo-entry" onClick={onUndo} disabled={busy}>撤销最近变更</button>
          </div>
        ) : null}
      </div>
      <MissionBrief mission={mission} />
      <Thread
        messages={messages}
        recommendation={recommendation}
        currency={currency}
        onOpen={onOpen}
        onClarify={onSend}
        onUndo={onUndo}
      />
      {suggestions.length > 0 ? (
        <div className="conversation-suggestions">
          {suggestions.map((suggestion) => (
            <button key={suggestion.label} className={suggestion.primary ? 'is-primary' : ''} onClick={suggestion.run} disabled={busy}>
              {suggestion.label}
            </button>
          ))}
        </div>
      ) : null}
      <form className="conversation-composer" onSubmit={submit}>
        <textarea
          rows={2}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder="例如：预算改为 2000 元，或只看有货（Enter 发送）"
          aria-label="选购对话输入"
          disabled={busy}
        />
        <div className="composer-row">
          <button className="send-button" disabled={!draft.trim() || busy} aria-label="发送">
            <Icon name="arrow" size={16} />
          </button>
        </div>
      </form>
    </aside>
  )
}
