import type { ProductCandidate } from '../../api/types'
import { Icon } from '../ui/Icon'
import { platformName } from '../../lib/platform'

export function EvidenceStrip({ candidates }: { candidates: ProductCandidate[] }) {
  if (!candidates.length) return null
  const sources = [...new Set(candidates.map((product) => `${platformName(product.merchant)} ${product.market ?? ''}`.trim()))].join('、')
  return (
    <section className="evidence-strip">
      <div>
        <Icon name="search" size={15} />
        <span>
          <b>已检索</b> {sources}
        </span>
      </div>
      <div>
        <Icon name="info" size={15} />
        <span>
          <b>价格口径</b> 商品价估算；运费与税费以商户结算页为准
        </span>
      </div>
    </section>
  )
}
