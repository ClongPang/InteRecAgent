import { formatObservedAt } from '../conversation/presentation'
import type { QuoteConversationController } from '../conversation/use-quote-conversation'
import { QuoteCard } from './QuoteCard'

export function QuotePane({
  conversation,
}: {
  conversation: QuoteConversationController
}) {
  const {
    quote,
    visibleLeads,
    excludedLeads,
    selectedRefs,
    focusedRef,
    running,
  } = conversation

  return (
    <aside className="candidate-pane quote-pane" aria-label="报价线索区">
      <div className="candidate-header">
        <div>
          <p className="eyebrow">QUOTE LEADS</p>
          <h2>本次观测</h2>
        </div>
        <span>{visibleLeads.length} 条已发布线索</span>
      </div>

      {quote?.leadSet && (
        <div className="observation-summary">
          <span className={`provider-status ${quote.leadSet.providerStatus.toLowerCase()}`}>
            {quote.leadSet.providerStatus === 'OK_RESULTS'
              ? '本次调用已返回记录'
              : quote.leadSet.providerStatus === 'OK_EMPTY'
                ? '本次调用返回空记录'
                : '本次调用未完成'}
          </span>
          <time>观测于 {formatObservedAt(quote.leadSet.observedAt)}</time>
        </div>
      )}

      {!visibleLeads.length ? (
        <div className="candidate-empty">
          <div className="empty-orbit">⌁</div>
          <b>
            {quote?.leadSet?.outcome === 'NO_QUOTE_LEADS'
              ? '本次没有可发布线索'
              : quote?.leadSet?.outcome === 'DEGRADED'
                ? '本次报价服务未完成'
                : '报价线索会显示在这里'}
          </b>
          <p>
            {quote?.leadSet
              ? '这只描述本次观测，不代表新加坡市场不存在该商品。'
              : '提供准确型号后，系统会核验每条记录的型号、商品角色和必要字段。'}
          </p>
        </div>
      ) : (
        <div className="candidate-list quote-list">
          {visibleLeads.map((lead, index) => (
            <QuoteCard
              key={lead.quoteLeadRef}
              lead={lead}
              rank={index + 1}
              selected={selectedRefs.includes(lead.quoteLeadRef)}
              focused={focusedRef === lead.quoteLeadRef}
              disabled={running}
              onFocus={() => conversation.setFocusedRef(lead.quoteLeadRef)}
              onExclude={() => conversation.excludeLead(lead.quoteLeadRef)}
              onToggle={() => conversation.toggleSelected(lead.quoteLeadRef)}
            />
          ))}
          {excludedLeads.length > 0 && (
            <details className="excluded-quote-group">
              <summary>已排除 {excludedLeads.length} 条</summary>
              {excludedLeads.map((lead) => (
                <p key={lead.quoteLeadRef}>{lead.representativeTitle}</p>
              ))}
            </details>
          )}
        </div>
      )}

      {selectedRefs.length > 0 && (
        <div className="compare-tray">
          <span>已选 {selectedRefs.length}/4</span>
          <button
            className="primary-button"
            disabled={running || selectedRefs.length < 2}
            onClick={conversation.compareSelected}
          >
            对比所选线索
          </button>
        </div>
      )}

      <div className="merchant-boundary-note">
        <b>报价是线索，不是成交承诺</b>
        <p>原币金额来自本次观测；人民币金额若出现，仅按所示汇率快照估算。最终价格、型号/版本、成色和可购买性请在商家页面核对。</p>
      </div>
    </aside>
  )
}
