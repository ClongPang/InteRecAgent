import type { Preference, ProductCandidate } from '../../api/types'
import { PriceEvidence } from '../../components/evidence/PriceEvidence'
import { Button } from '../../components/ui/Button'
import { ProductPhoto } from '../../components/ui/ProductPhoto'
import { PlatformMark } from '../../components/ui/PlatformMark'
import { rmbAmount, type Currency } from '../../lib/currency'
import { availabilityText, reasonText } from '../../lib/format'
import { platformName, platformTone } from '../../lib/platform'

export function CandidateCard({
  product,
  rank,
  selected,
  toggle,
  detail,
  budget,
  lowest = false,
  currency = 'RMB',
  lead = false,
  rejected = false,
}: {
  product: ProductCandidate
  rank: number
  selected: boolean
  toggle: () => void
  detail: () => void
  budget?: number | null
  lowest?: boolean
  currency?: Currency
  lead?: boolean
  rejected?: boolean
}) {
  const rmb = rmbAmount(product)
  const overBudget = budget != null && rmb != null && rmb > budget
  const reason = product.decision_reasons[0]
  const stockLabel = availabilityText(product.availability, product.stock_source)
  return (
    <article className={`product-card evidence-card ${selected ? 'is-selected' : ''} ${lead ? 'is-lead' : ''} ${rejected ? 'is-rejected' : ''}`}>
      <span className="candidate-rank">{String(rank).padStart(2, '0')}</span>
      {lead ? <span className="candidate-focus">首选候选</span> : null}
      <button className="product-image-button" onClick={detail}>
        <div className={`product-image tone-${platformTone(product.merchant)}`}>
          <ProductPhoto product={product} className="product-photo" />
          {stockLabel ? <span className="image-tag">{stockLabel}</span> : null}
        </div>
      </button>
      <div className="product-card-body">
        <div className="product-source">
          <span>
            <PlatformMark merchant={product.merchant} /> {platformName(product.merchant)}
          </span>
          <span>{product.market ?? '市场未提供'}</span>
        </div>
        <button className="product-title" onClick={detail}>{product.title}</button>
        <PriceEvidence product={product} compact lowest={lowest} currency={currency} />
        {product.specs.length ? (
          <div className="spec-line">
            {product.specs.slice(0, 2).map((spec) => <span key={spec}>{spec}</span>)}
          </div>
        ) : (
          <div className="spec-line"><span>结构化规格未提供</span></div>
        )}
        {reason ? <p className="candidate-reason"><b>为什么排在这里</b>{reasonText(reason)}</p> : null}
        {overBudget && rmb != null && budget != null ? (
          <p className="budget-warning">超出预算 ¥{(rmb - budget).toLocaleString()}</p>
        ) : null}
        <div className="card-bottom">
          {stockLabel ? (
            <span className={product.availability === 'out_of_stock' ? 'stock pending' : 'stock confirmed'}>
              {stockLabel}
            </span>
          ) : <span />}
          <Button variant={selected ? 'primary' : 'secondary'} onClick={toggle} icon={selected ? 'check' : 'plus'}>
            {selected ? '已加入备选' : '加入备选'}
          </Button>
        </div>
      </div>
    </article>
  )
}

export function FilterBar({
  count,
  platformCount,
  query,
  preference,
  onPreference,
  onReset,
}: {
  count: number
  platformCount: number
  query?: string | null
  preference: Preference
  onPreference: (preference: Preference) => void
  onReset: () => void
}) {
  const audioLike = /耳机|降噪|头戴|入耳|耳塞|headphone|earbuds/i.test(query || '')
  const dirty = preference !== 'balanced'
  return (
    <div className="filter-bar">
      <div className="result-count">
        <strong>{count}</strong> 件备选 {platformCount > 0 ? <span>· {platformCount} 个平台</span> : null}
      </div>
      <div className="filter-actions">
        <select value={preference} onChange={(event) => onPreference(event.target.value as Preference)} aria-label="备选排序">
          <option value="balanced">综合推荐</option>
          <option value="lowest">按商品价</option>
          {audioLike || preference === 'noise' ? <option value="noise">优先降噪</option> : null}
          {audioLike || preference === 'battery' ? <option value="battery">优先续航</option> : null}
        </select>
        {dirty ? (
          <>
            <span className="filter-divider" aria-hidden="true" />
            <button className="clear-filters-button" onClick={onReset} title="恢复为综合推荐">
              清除筛选
            </button>
          </>
        ) : null}
      </div>
    </div>
  )
}
