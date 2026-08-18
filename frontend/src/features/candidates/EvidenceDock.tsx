import type { ProductCandidate } from '../../api/types'
import { Button } from '../../components/ui/Button'
import { rmbAmount } from '../../lib/currency'
import { platformName } from '../../lib/platform'

export function EvidenceDock({
  candidates,
  focusId,
  compareIds,
  onFocus,
  onToggleCompare,
}: {
  candidates: ProductCandidate[]
  focusId: string | null
  compareIds: string[]
  onFocus: (product: ProductCandidate) => void
  onToggleCompare: (snapshotId: string) => void
}) {
  const items = candidates.slice(0, 5)
  if (!items.length) {
    return (
      <section className="evidence-dock">
        <span className="section-eyebrow">当前候选</span>
        <p>还没有可引用的商品。先在对话里说明品类和预算。</p>
      </section>
    )
  }
  return (
    <section className="evidence-dock" aria-label="当前候选">
      <span className="section-eyebrow">当前候选</span>
      <ul>
        {items.map((product, index) => {
          const amount = rmbAmount(product)
          const focused = product.snapshot_id === focusId
          const compared = compareIds.includes(product.snapshot_id)
          return (
            <li key={product.snapshot_id} className={focused ? 'is-focus' : ''}>
              <button type="button" className="dock-item" onClick={() => onFocus(product)}>
                <b>{String(index + 1).padStart(2, '0')}</b>
                <span>
                  {product.title}
                  <small>{platformName(product.merchant)}{amount != null ? ` · 约 ¥${Math.round(amount).toLocaleString()}` : ''}</small>
                </span>
              </button>
              <Button variant={compared ? 'primary' : 'quiet'} onClick={() => onToggleCompare(product.snapshot_id)}>
                {compared ? '比较中' : '比较'}
              </Button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function CompareStrip({
  items,
  onFocus,
}: {
  items: ProductCandidate[]
  onFocus: (product: ProductCandidate) => void
}) {
  if (items.length < 2) return null
  return (
    <section className="compare-strip" aria-label="当前比较">
      <span className="section-eyebrow">对照</span>
      <div>
        {items.map((product) => {
          const amount = rmbAmount(product)
          return (
            <button key={product.snapshot_id} type="button" onClick={() => onFocus(product)}>
              <strong>{product.title}</strong>
              <span>{amount != null ? `约 ¥${Math.round(amount).toLocaleString()}` : '价格待确认'}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
