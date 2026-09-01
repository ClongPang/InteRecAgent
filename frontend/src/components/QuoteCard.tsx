import {
  cnyText,
  conditionLabel,
  formatObservedAt,
  rangeText,
} from '../conversation/presentation'
import type { QuoteLead } from '../conversation/types'

export interface QuoteCardProps {
  lead: QuoteLead
  rank: number
  selected: boolean
  focused: boolean
  disabled: boolean
  onToggle: () => void
  onFocus: () => void
  onExclude: () => void
}

export function QuoteCard({
  lead,
  rank,
  selected,
  focused,
  disabled,
  onToggle,
  onFocus,
  onExclude,
}: QuoteCardProps) {
  return (
    <article id={`quote-${lead.quoteLeadRef}`} className={`quote-card${focused ? ' focused' : ''}`}>
      <button className="quote-card-main" onClick={onFocus} aria-label={`查看第 ${rank} 条报价线索`}>
        <div className="quote-kicker">
          <span>线索 {rank}</span>
          <span>{conditionLabel(lead.condition)}</span>
        </div>
        <h3>{lead.representativeTitle}</h3>
        <p className="merchant-line">{lead.merchantLabel} · {lead.merchantDomain}</p>
        <div className="quote-prices">
          {lead.priceRanges.map((range) => (
            <div key={range.originalPrice.currency}>
              <strong>{rangeText(range)}</strong>
              {cnyText(range) && (
                <small>
                  {cnyText(range)}，汇率快照 {formatObservedAt(range.cnyEstimate!.fxObservedAt)}
                </small>
              )}
            </div>
          ))}
        </div>
        <p className="observation-line">
          {lead.observationCount} 条观测 · 最近记录于 {formatObservedAt(lead.latestObservedAt)}
        </p>
      </button>
      <div className="quote-actions">
        <button disabled={disabled} className={selected ? 'selected' : ''} onClick={onToggle}>
          {selected ? '已选作对比' : '加入对比'}
        </button>
        <button disabled={disabled} onClick={onExclude}>排除这条</button>
        <a href={lead.outboundUrl} target="_blank" rel="noopener noreferrer sponsored">
          打开商家页确认
        </a>
      </div>
    </article>
  )
}
