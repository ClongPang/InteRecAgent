import { useEffect, useRef, useState } from 'react'
import { beliefOf, type Citation, type MissionView, type NextMove, type ThreadMessage } from '../../api/types'
import { Icon } from '../../components/ui/Icon'
import { BeliefBar } from './MissionBrief'
import { composerPlaceholder, timeLabel } from '../../lib/format'
import { groupThread, lastUndoableChange } from '../../lib/thread'

function CitationChip({
  citation,
  onOpen,
}: {
  citation: Citation
  onOpen: (snapshotId: string) => void
}) {
  const price = citation.estimated_cny != null ? `约 ¥${Math.round(citation.estimated_cny).toLocaleString()}` : null
  return (
    <button type="button" className="rec-chip" onClick={() => onOpen(citation.snapshot_id)}>
      <span>{citation.title || '已引用商品'}</span>
      <b>{price || citation.market || '查看'}</b>
    </button>
  )
}

function ThreadItem({
  message,
  onOpen,
  onMove,
  onUndo,
}: {
  message: ThreadMessage
  onOpen: (snapshotId: string) => void
  onMove: (text: string) => void
  onUndo: () => void
}) {
  if (message.kind === 'warning') {
    return (
      <div className="thread-warning" role="status">
        <Icon name="info" size={14} />
        <span>{message.text}</span>
      </div>
    )
  }
  if (message.kind === 'change') {
    return (
      <div className={`change-row${message.change_kind === 'undo' ? ' is-undo' : ''}`}>
        <span className="change-source">条件</span>
        <span className="change-text">{message.change?.summary || message.text}</span>
        {message.change_kind === 'constraints' ? (
          <button className="change-undo-button" onClick={onUndo}>撤销</button>
        ) : null}
      </div>
    )
  }
  const citations = message.citations?.length ? message.citations : message.snapshot_ids.map((snapshot_id) => ({ snapshot_id }))
  const isUser = message.kind === 'user' || message.role === 'user'
  return (
    <div className={`conversation-message ${isUser ? 'user' : 'agent'}`}>
      <div className="message-meta">
        {isUser ? '你' : '选购助手'}
        {message.created_at ? ` · ${timeLabel(message.created_at)}` : ''}
      </div>
      <p>{message.text}</p>
      {message.change ? <small className="turn-change">{message.change.summary}</small> : null}
      {!isUser && citations.length > 0 ? (
        <div className="rec-alternatives">
          {citations.map((citation) => (
            <CitationChip key={citation.snapshot_id} citation={citation} onOpen={onOpen} />
          ))}
        </div>
      ) : null}
      {!isUser && message.next_moves?.length ? (
        <div className="message-actions">
          {message.next_moves.map((move: NextMove) => (
            <button key={move.label} type="button" onClick={() => onMove(move.text)}>{move.label}</button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function Thread({
  messages,
  onOpen,
  onMove,
  onUndo,
}: {
  messages: ThreadMessage[]
  onOpen: (snapshotId: string) => void
  onMove: (text: string) => void
  onUndo: () => void
}) {
  const blocks = groupThread(messages)
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
          <ThreadItem key={block.key} message={block.message} onOpen={onOpen} onMove={onMove} onUndo={onUndo} />
        ) : (
          <div key={block.key} className="change-group">
            {block.messages.map((message) => (
              <ThreadItem key={message.sequence} message={message} onOpen={onOpen} onMove={onMove} onUndo={onUndo} />
            ))}
          </div>
        ),
      )}
    </div>
  )
}

export function ConversationPanel({
  mission,
  messages,
  pendingText,
  focusTitle,
  busy,
  onSend,
  onUndo,
  onOpen,
  onClearFocus,
}: {
  mission: MissionView
  messages: ThreadMessage[]
  pendingText?: string | null
  focusTitle?: string | null
  busy: boolean
  onSend: (text: string) => void
  onUndo: () => void
  onOpen: (snapshotId: string) => void
  onClearFocus?: () => void
}) {
  const [draft, setDraft] = useState('')
  const undoable = lastUndoableChange(messages)
  const visible = pendingText
    ? [...messages, { sequence: 0, kind: 'user' as const, role: 'user', text: pendingText, constraints_version: null, snapshot_ids: [], created_at: null }]
    : messages
  const submit = (event?: { preventDefault(): void }, text = draft) => {
    event?.preventDefault()
    const value = text.trim()
    if (!value || busy) return
    onSend(value)
    setDraft('')
  }
  return (
    <aside className="conversation-panel is-primary">
      <div className="conversation-header">
        <div><span>选购助手</span></div>
        {undoable ? (
          <div className="conversation-header-actions">
            <button type="button" className="undo-entry" onClick={onUndo} disabled={busy}>撤销最近变更</button>
          </div>
        ) : null}
      </div>
      <BeliefBar mission={mission} onPrefill={setDraft} />
      {focusTitle ? (
        <div className="focus-bar">
          <span>正在聊</span>
          <strong>{focusTitle}</strong>
          {onClearFocus ? <button type="button" onClick={onClearFocus}>取消</button> : null}
        </div>
      ) : null}
      <Thread messages={visible} onOpen={onOpen} onMove={(text) => submit(undefined, text)} onUndo={onUndo} />
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
          placeholder={composerPlaceholder(beliefOf(mission), focusTitle)}
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
