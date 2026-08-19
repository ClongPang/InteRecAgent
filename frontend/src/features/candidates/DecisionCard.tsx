import type { ProductCandidate, RecommendationView, MissionView } from '../../api/types'
import { Button } from '../../components/ui/Button'
import { Icon } from '../../components/ui/Icon'
import { CURRENCY_SYMBOL, displayAmount, nativePriceText, rmbAmount, type Currency, type SnapshotRates } from '../../lib/currency'
import { preferenceText } from '../../lib/format'

export function DecisionCard({
  recommendation,
  mission,
  currency,
  rates,
  onOpen,
}: {
  recommendation: RecommendationView | null | undefined
  mission: MissionView
  currency: Currency
  rates?: SnapshotRates
  onOpen?: (snapshotId: string) => void
}) {
  const product = recommendation?.primary
  if (!product) return null
  const amount = displayAmount(rmbAmount(product), currency, rates)
  return (
    <section className="decision-card">
      <div className="decision-icon"><Icon name="spark" size={20} /></div>
      <div className="decision-copy">
        <span>当前推荐 · V{mission.constraints_version}</span>
        <h2>{onOpen ? <button type="button" className="decision-title-button" onClick={() => onOpen(product.snapshot_id)}>{product.title}</button> : product.title}</h2>
        <p>{recommendation?.rationale[0] ?? '已按当前约束给出首选。'} {recommendation?.tradeoffs[0] ?? ''}</p>
        {recommendation?.alternatives.length ? (
          <p className="decision-alts">备选：{recommendation.alternatives.map((item) => item.title).join('；')}</p>
        ) : null}
        <div className="decision-tags">
          {[mission.constraints.budget_cny ? '商品价在预算内' : '未设置预算', preferenceText(mission.constraints.preference)].map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </div>
      </div>
      <div className="decision-price">
        <span>商品价估算</span>
        <strong>{amount == null ? '未提供' : `${CURRENCY_SYMBOL[currency]}${amount}`}</strong>
        <small>{nativePriceText(product)}</small>
      </div>
    </section>
  )
}

export function DecisionOverview({
  candidates,
  eligibleCount,
  platformCount,
  mission,
}: {
  candidates: ProductCandidate[]
  eligibleCount: number
  platformCount: number
  mission: MissionView
}) {
  const lowest = candidates.reduce<ProductCandidate | null>((best, item) => {
    const amount = rmbAmount(item)
    const bestAmount = best ? rmbAmount(best) : null
    if (amount == null) return best
    if (bestAmount == null || amount < bestAmount) return item
    return best
  }, null)
  const lowestText = lowest ? displayAmount(rmbAmount(lowest), 'RMB') : null
  return (
    <section className="decision-overview" aria-label="决策概览">
      <div className="decision-overview-copy">
        <span className="section-eyebrow">决策工作台</span>
        <h2>先看结论，再核对候选</h2>
        <p>
          {mission.constraints.budget_cny
            ? `已按商品价预算 ¥${mission.constraints.budget_cny.toLocaleString()} 过滤。`
            : '已按当前需求整理候选，选择排序依据后再加入比较。'}
        </p>
      </div>
      <div className="decision-metrics">
        <div>
          <strong>{eligibleCount}</strong>
          <span>{mission.constraints.budget_cny ? '预算内候选' : '可推荐候选'}</span>
        </div>
        <div>
          <strong>{platformCount}</strong>
          <span>可比平台</span>
        </div>
        <div>
          <strong>{lowestText ? `¥${lowestText}` : '—'}</strong>
          <span>最低商品价</span>
        </div>
      </div>
    </section>
  )
}

export function CompareTray({
  selected,
  onRemove,
  onCompare,
}: {
  selected: ProductCandidate[]
  onRemove: (id: string) => void
  onCompare: () => void
}) {
  if (!selected.length) return null
  return (
    <div className="compare-tray">
      <div>
        <span className="tray-count">{selected.length}</span>
        <strong>已选商品</strong>
        <small>最多 4 件</small>
      </div>
      <div className="tray-items">
        {selected.map((product) => (
          <button key={product.snapshot_id} onClick={() => onRemove(product.snapshot_id)}>
            {product.title.slice(0, 18)} · {displayAmount(rmbAmount(product), 'RMB') ? `约 ¥${displayAmount(rmbAmount(product), 'RMB')}` : '暂无估算'}{' '}
            <Icon name="close" size={13} />
          </button>
        ))}
      </div>
      <Button variant="primary" onClick={onCompare} disabled={selected.length < 2} icon="arrow">开始对比</Button>
    </div>
  )
}

export function StageRail({ current }: { current: 'discover' | 'compare' }) {
  const steps = [
    { key: 'request', label: '需求', hint: '已识别' },
    { key: 'discover', label: '备选', hint: '核对候选' },
    { key: 'compare', label: '对比', hint: '做出决定' },
  ] as const
  const currentIndex = current === 'discover' ? 1 : 2
  return (
    <nav className="stage-rail" aria-label="选购进度">
      {steps.map((step, index) => (
        <span className={`stage-step ${index < currentIndex ? 'is-done' : ''} ${index === currentIndex ? 'is-current' : ''}`} key={step.key}>
          <b>{String(index + 1).padStart(2, '0')}</b>
          <span>
            <strong>{step.label}</strong>
            <small>{index === currentIndex ? step.hint : index < currentIndex ? '已完成' : '待进行'}</small>
          </span>
        </span>
      ))}
    </nav>
  )
}
