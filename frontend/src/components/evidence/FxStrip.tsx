import type { ProductCandidate } from '../../api/types'

export function FxStrip({ candidates }: { candidates: ProductCandidate[] }) {
  if (!candidates.length) return null
  const rates = new Map<string, string>()
  for (const product of candidates) {
    const fx = product.estimated_cny
    if (!fx) continue
    const code = product.native_price.currency
    if (!rates.has(code)) rates.set(code, String(fx.rate))
  }
  const asOf = candidates.find((item) => item.estimated_cny)?.estimated_cny?.rate_date
  if (!rates.size) return null
  return (
    <div className="fx-strip">
      <span className="fx-strip-label">汇率基准</span>
      {[...rates.entries()].map(([code, rate]) => (
        <span className="fx-rate" key={code}>
          <b>{code}</b>
          {rate}
        </span>
      ))}
      {asOf ? <span className="fx-strip-asof">汇率日期 {asOf}</span> : null}
    </div>
  )
}
