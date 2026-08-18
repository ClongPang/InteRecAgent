import type { Preference, ProductCandidate } from '../../api/types'
import { PriceEvidence } from '../../components/evidence/PriceEvidence'
import { Button } from '../../components/ui/Button'
import { Icon } from '../../components/ui/Icon'
import { PlatformMark } from '../../components/ui/PlatformMark'
import { categoryIconFor } from '../../lib/category'
import { rmbAmount, type Currency } from '../../lib/currency'
import { availabilityText } from '../../lib/format'
import { platformName } from '../../lib/platform'

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
}) {
  const rmb = rmbAmount(product)
  const overBudget = budget != null && rmb != null && rmb > budget
  const reason = product.decision_reasons[0]
  const unknownStock = product.availability === 'unknown' || product.unavailable_fields.includes('availability')
  return (
    <article className={`product-card evidence-card ${selected ? 'is-selected' : ''} ${lead ? 'is-lead' : ''}`}>
      <span className="candidate-rank">{String(rank).padStart(2, '0')}</span>
      {lead ? <span className="candidate-focus">首选候选</span> : null}
      <button className="product-image-button" onClick={detail}>
        <div className={`product-image tone-${product.merchant ? product.merchant.toLowerCase().includes('lazada') ? 'lazada' : product.merchant.toLowerCase().includes('best') ? 'bestbuy' : 'amazon' : 'amazon'}`}>
          <span className="category-icon" aria-hidden="true">
            <Icon name={categoryIconFor(product.title)} size={42} />
          </span>
          <span className="image-tag">{availabilityText(product.availability)}</span>
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
        <div className="rating-line">
          <span>评分未提供</span>
          <span>评价数未提供</span>
        </div>
        <PriceEvidence product={product} compact lowest={lowest} currency={currency} />
        {product.specs.length ? (
          <div className="spec-line">
            {product.specs.slice(0, 2).map((spec) => <span key={spec}>{spec}</span>)}
          </div>
        ) : (
          <div className="spec-line"><span>结构化规格未提供</span></div>
        )}
        {reason ? <p className="candidate-reason"><b>为什么排在这里</b>{reason}</p> : null}
        {overBudget && rmb != null && budget != null ? (
          <p className="budget-warning">超出预算 ¥{(rmb - budget).toLocaleString()}</p>
        ) : null}
        <div className="card-bottom">
          <span className={unknownStock ? 'stock pending' : product.availability === 'in_stock' ? 'stock confirmed' : 'stock pending'}>
            {availabilityText(product.availability)}
          </span>
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
  preference,
  onlyInStock,
  onPreference,
  onStock,
  onReset,
}: {
  count: number
  platformCount: number
  preference: Preference
  onlyInStock: boolean
  onPreference: (preference: Preference) => void
  onStock: (onlyInStock: boolean) => void
  onReset: () => void
}) {
  const dirty = preference !== 'balanced' || onlyInStock
  return (
    <div className="filter-bar">
      <div className="result-count">
        <strong>{count}</strong> 件备选 {platformCount > 0 ? <span>· {platformCount} 个平台</span> : null}
      </div>
      <div className="filter-actions">
        <button onClick={() => onStock(!onlyInStock)}>
          <Icon name="filter" size={15} />
          {onlyInStock ? '显示全部库存' : '只看有货'}
        </button>
        <select value={preference} onChange={(event) => onPreference(event.target.value as Preference)} aria-label="备选排序">
          <option value="balanced">综合推荐</option>
          <option value="lowest">按商品价</option>
          <option value="noise">优先降噪</option>
          <option value="battery">优先续航</option>
        </select>
        {dirty ? (
          <>
            <span className="filter-divider" aria-hidden="true" />
            <button className="clear-filters-button" onClick={onReset} title="恢复为综合推荐，并显示全部库存">
              清除筛选
            </button>
          </>
        ) : null}
      </div>
    </div>
  )
}
