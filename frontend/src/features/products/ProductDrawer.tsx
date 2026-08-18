import type { ProductCandidate } from '../../api/types'
import { PriceEvidence } from '../../components/evidence/PriceEvidence'
import { Button } from '../../components/ui/Button'
import { Icon } from '../../components/ui/Icon'
import { PlatformMark } from '../../components/ui/PlatformMark'
import { categoryIconFor } from '../../lib/category'
import { type Currency } from '../../lib/currency'
import { availabilityText } from '../../lib/format'
import { platformName, platformTone } from '../../lib/platform'

export function ProductDrawer({
  product,
  selected,
  currency,
  onClose,
  onToggle,
}: {
  product: ProductCandidate
  selected: boolean
  currency: Currency
  onClose: () => void
  onToggle: () => void
}) {
  const url = product.merchant_url
  let domain = platformName(product.merchant)
  try {
    if (url) domain = new URL(url).hostname
  } catch {
    /* keep merchant name */
  }
  return (
    <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <aside className="product-drawer" aria-label="商品详情">
        <div className="drawer-top">
          <span>商品详情</span>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><Icon name="close" size={18} /></button>
        </div>
        <div className={`drawer-image tone-${platformTone(product.merchant)}`}>
          <span className="category-icon" aria-hidden="true">
            <Icon name={categoryIconFor(product.title)} size={56} />
          </span>
        </div>
        <div className="drawer-body">
          <div className="product-source">
            <span><PlatformMark merchant={product.merchant} /> {platformName(product.merchant)}</span>
            <span>{product.market ?? '市场未提供'}</span>
          </div>
          <h2>{product.title}</h2>
          <PriceEvidence product={product} currency={currency} />
          <section className="drawer-section">
            <div className="section-title">商品信息</div>
            {product.specs.length ? (
              <div className="spec-pills">{product.specs.map((spec) => <span key={spec}>{spec}</span>)}</div>
            ) : (
              <p className="drawer-description">结构化规格未提供</p>
            )}
            <p className="drawer-description">
              评分未提供 · 评价数未提供 · 库存：{availabilityText(product.availability)}
              {product.brand == null ? ' · 品牌未提供' : ''}
            </p>
            {product.decision_reasons[0] ? (
              <p className="drawer-tradeoff"><b>排序依据</b>{product.decision_reasons[0]}</p>
            ) : null}
          </section>
          <section className="purchase-check">
            <span>查看商户报价</span>
            <p>本服务只负责比较；{domain} 将提供商品详情与交易。</p>
            {url ? (
              <a className="button button-primary merchant-link" href={url} target="_blank" rel="noreferrer">
                前往 {platformName(product.merchant)} 查看
                <Icon name="external" size={15} />
              </a>
            ) : (
              <p className="drawer-description">商户链接未提供</p>
            )}
            <small>商品价以商户结算页为准。</small>
          </section>
        </div>
        <div className="drawer-footer">
          <Button variant={selected ? 'primary' : 'secondary'} onClick={onToggle}>
            {selected ? '已加入备选' : '加入备选'}
          </Button>
          <Button variant="quiet" onClick={onClose}>返回选购</Button>
        </div>
      </aside>
    </div>
  )
}
