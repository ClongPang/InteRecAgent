import type { FormEvent } from 'react'

import {
  DISCLOSURE_LABELS,
  EVENT_LABELS,
  messageText,
} from '../conversation/presentation'
import type { QuoteConversationController } from '../conversation/use-quote-conversation'

export function ConversationPane({
  conversation,
}: {
  conversation: QuoteConversationController
}) {
  const {
    projection,
    quote,
    loading,
    running,
    events,
    failedTurn,
    error,
    composer,
    focusedLead,
    messageEnd,
  } = conversation

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void conversation.submitComposer()
  }

  return (
    <section className="conversation-pane" aria-label="与报价助手的对话">
      <div className="thread-header">
        <div>
          <p className="eyebrow">CONVERSATION</p>
          <h1>{projection ? '继续核对这次报价' : '输入准确商品型号'}</h1>
        </div>
        {projection && <span>观测状态 v{projection.conversation.currentRevision}</span>}
      </div>

      <div className="message-list" aria-live="polite">
        {!projection?.messages.length && !loading && (
          <div className="welcome-message">
            <span className="agent-avatar">A</span>
            <div>
              <b>我查找报价线索，并把最终确认留给商家页面。</b>
              <p>请直接输入品牌和准确型号，例如 Sony WH-1000XM5 headphones。普通追问会复用当前观测；只有你明确说“刷新”或“再查”，我才会再次调用报价服务。</p>
            </div>
          </div>
        )}
        {projection?.messages.map((message) => (
          <article className={`message ${message.role.toLowerCase()}`} key={message.id}>
            <div className="message-meta">
              <span>{message.role === 'USER' ? '你' : '助手'}</span>
              <time>
                {new Date(message.createdAt).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
            </div>
            <p>{messageText(message)}</p>
            {message.role === 'ASSISTANT' && message.payload.envelope?.disclosureCodes.length ? (
              <div className="quote-disclosures">
                {message.payload.envelope.disclosureCodes.map((code) => (
                  <span key={code}>{DISCLOSURE_LABELS[code]}</span>
                ))}
              </div>
            ) : null}
          </article>
        ))}
        {running && (
          <div className="agent-working">
            <span /><span /><span />
            <b>
              {events.at(-1)
                ? EVENT_LABELS[events.at(-1)!.eventType] ?? '正在处理本轮请求'
                : '正在接手本轮请求'}
            </b>
          </div>
        )}
        {failedTurn && !running && (
          <div className="turn-failure" role="alert">
            <b>本轮未完成</b>
            <span>已发布的报价观测没有被改写。</span>
            <button onClick={() => void conversation.retryFailed()}>重试本轮</button>
          </div>
        )}
        <div ref={messageEnd} />
      </div>

      {events.length > 0 && (
        <div className="progress-line" aria-label="本轮进度">
          {events.map((event) => (
            <span key={event.id}>{EVENT_LABELS[event.eventType] ?? event.eventType}</span>
          ))}
        </div>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}<button onClick={conversation.clearError}>关闭</button>
        </div>
      )}

      <form className="composer" onSubmit={submit}>
        {focusedLead && (
          <div className="focus-context">
            正在查看：<b>{focusedLead.representativeTitle}</b>
            <button type="button" onClick={() => conversation.setFocusedRef(null)}>取消</button>
          </div>
        )}
        <label className="sr-only" htmlFor="message-composer">给报价助手发消息</label>
        <textarea
          id="message-composer"
          rows={3}
          value={composer}
          disabled={running}
          onChange={(event) => conversation.setComposer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
          placeholder={quote?.pendingTargetConfirmation
            ? `确认是否为 ${quote.pendingTargetConfirmation.proposal.proposedModel}`
            : quote?.leadSet
              ? '例如：聚焦第 1 条；排除第 2 条；或明确说“刷新报价”'
              : '例如：Sony WH-1000XM5 headphones'}
        />
        <div className="composer-actions">
          <span>Enter 发送 · Shift+Enter 换行</span>
          {running && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => void conversation.cancelActive()}
            >
              取消本轮
            </button>
          )}
          <button className="primary-button" disabled={running || !composer.trim()}>
            {projection ? '发送' : '开始查询'}
          </button>
        </div>
      </form>
    </section>
  )
}
