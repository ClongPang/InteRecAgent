import type { ProductCandidate } from '../../api/types'
import { Button } from '../../components/ui/Button'
import { ProductPhoto } from '../../components/ui/ProductPhoto'
import { rmbAmount } from '../../lib/currency'
import { availabilityText, brandLabel, reasonsText } from '../../lib/format'
import { platformName } from '../../lib/platform'

export function EvidenceDock({
  candidates,
  focusId,
  compareIds,
  rejectedIds = [],
  onFocus,
  onToggleCompare,
  onTalk,
}: {
  candidates: ProductCandidate[]
  focusId: string | null
  compareIds: string[]
  rejectedIds?: string[]
  onFocus: (product: ProductCandidate) => void
  onToggleCompare: (snapshotId: string) => void
  onTalk?: (product: ProductCandidate, text: string) => void
}) {
  const rejected = new Set(rejectedIds)
  const kept = candidates.filter((item) => !rejected.has(item.snapshot_id)).slice(0, 5)
  const excluded = candidates.filter((item) => rejected.has(item.snapshot_id))
  const items = [...kept, ...excluded]
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
          const struck = rejected.has(product.snapshot_id)
          const lead = !struck && product.rank === 1
          const brand = brandLabel(product)
          const reasons = reasonsText(product.decision_reasons)
          return (
            <li key={product.snapshot_id} className={`${focused ? 'is-focus' : ''}${lead ? ' is-lead' : ''}${struck ? ' is-rejected' : ''}`}>
              <button type="button" className={`dock-item${lead ? ' is-lead' : ''}${struck ? ' is-rejected' : ''}`} onClick={() => onFocus(product)}>
                <span className="dock-thumb"><ProductPhoto product={product} className="dock-photo" iconSize={18} /></span>
                <b>{String(product.rank ?? index + 1).padStart(2, '0')}</b>
                <span>
                  {product.title}
                  <small>
                    {platformName(product.merchant)}
                    {amount != null ? ` · 约 ¥${Math.round(amount).toLocaleString()}` : ''}
                    {brand ? ` · ${brand}` : ''}
                  </small>
                  {reasons ? <small className="dock-reasons">{reasons}</small> : null}
                </span>
              </button>
              <div className="dock-actions">
                <Button variant={compared ? 'primary' : 'quiet'} onClick={() => onToggleCompare(product.snapshot_id)}>
                  {compared ? '比较中' : '比较'}
                </Button>
                {onTalk && !struck ? (
                  <>
                    <button type="button" onClick={() => onTalk(product, '为什么推荐这款')}>为什么选它</button>
                    <button type="button" onClick={() => onTalk(product, '不要这款')}>不要这款</button>
                    {index > 0 ? (
                      <button type="button" onClick={() => onTalk(product, '帮我比这款和上一件')}>和上一件比</button>
                    ) : null}
                  </>
                ) : null}
              </div>
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
      <table className="compare-table">
        <thead>
          <tr>
            <th>商品</th>
            <th>平台 / 市场</th>
            <th>原币价</th>
            <th>人民币估算</th>
            <th>库存</th>
            <th>更新</th>
          </tr>
        </thead>
        <tbody>
          {items.map((product) => {
            const amount = rmbAmount(product)
            const fx = product.estimated_cny
            return (
              <tr key={product.snapshot_id}>
                <td>
                  <button type="button" className="compare-item" onClick={() => onFocus(product)}>
                    <span className="compare-thumb"><ProductPhoto product={product} className="compare-photo" iconSize={16} /></span>
                    <span>
                      <strong>{product.title}</strong>
                      {product.brand ? <span>{product.brand}</span> : null}
                    </span>
                  </button>
                </td>
                <td>{platformName(product.merchant)} · {product.market ?? '—'}</td>
                <td>{product.native_price.currency} {product.native_price.amount.toFixed(2)}</td>
                <td>
                  {amount != null ? `约 ¥${Math.round(amount).toLocaleString()}` : '待确认'}
                  {fx ? <small>汇率 {fx.rate} · {fx.rate_date}</small> : null}
                </td>
                <td>{availabilityText(product.availability)}</td>
                <td>{product.source_updated_at ? product.source_updated_at.replace('T', ' ').slice(0, 16) : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}
