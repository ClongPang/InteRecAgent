import type { ProductCandidate } from '../../api/types'
import { CURRENCY_SYMBOL, displayAmount, fxText, nativePriceText, rmbAmount, type Currency } from '../../lib/currency'

export function PriceEvidence({
  product,
  compact = false,
  lowest = false,
  currency = 'RMB',
  compare = false,
}: {
  product: ProductCandidate
  compact?: boolean
  lowest?: boolean
  currency?: Currency
  compare?: boolean
}) {
  const rmb = rmbAmount(product)
  const amount = displayAmount(rmb, currency)
  const fx = fxText(product)
  const updated = product.source_updated_at ? product.source_updated_at.replace('T', ' ').slice(0, 16) : null
  return (
    <div className={`price-evidence ${compact ? 'compact' : ''}${lowest ? ' is-lowest' : ''}${compare ? ' compare' : ''}`}>
      <div>
        <strong>{amount == null ? '暂无人民币估算' : `${CURRENCY_SYMBOL[currency]}${amount}`}</strong>
        <span>{nativePriceText(product)}</span>
      </div>
      {fx ? <small>{fx}</small> : <small>汇率信息未提供</small>}
      {!compare && (
        <small>
          {compact
            ? '商品价估算 · 运费与税费以商户结算页为准'
            : `${updated ? `${updated} · ` : ''}商品价估算，运费与税费以商户结算页为准`}
        </small>
      )}
    </div>
  )
}
