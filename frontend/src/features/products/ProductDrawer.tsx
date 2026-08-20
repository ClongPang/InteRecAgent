import type { ProductCandidate } from '../../api/types'
import { PriceEvidence } from '../../components/evidence/PriceEvidence'
import { Button } from '../../components/ui/Button'
import { Icon } from '../../components/ui/Icon'
import { PlatformMark } from '../../components/ui/PlatformMark'
import { categoryIconFor } from '../../lib/category'
import { type Currency, type SnapshotRates } from '../../lib/currency'
import { brandLabel, reasonsText } from '../../lib/format'
import { merchantHref, merchantHost } from '../../lib/merchant'
import { platformName, platformTone } from '../../lib/platform'

export function ProductDrawer({
  product,
  selected,
  currency,
  rates,
  onClose,
  onToggle,
  onTalk,
}: {
  product: ProductCandidate
  selected: boolean
  currency: Currency
  rates?: SnapshotRates
  onClose: () => void
  onToggle: () => void
  onTalk?: (text: string) => void
}) {
  const url = merchantHref(product.merchant_url)
  const domain = merchantHost(product.merchant_url) || platformName(product.merchant)
  const brand = brandLabel(product)
  const reasons = reasonsText(product.decision_reasons)
  return (
    <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <aside className="product-drawer" aria-label="商品详情">
        <div className="drawer-top">
          <span>商品详情</span>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><Icon name="close" size={18} /></button>
        </div>
        <div className={`drawer-image tone-${platformTone(product.merchant)}`}>
          {product.image_url ? (
            <img src={product.image_url} alt="" className="drawer-photo" />
          ) : (
            <span className="category-icon" aria-hidden="true">
              <Icon name={categoryIconFor(product.title)} size={56} />
            </span>
          )}
        </div>
        <div className="drawer-body">
          <div className="product-source">
            <span><PlatformMark merchant={product.merchant} /> {platformName(product.merchant)}</span>
            <span>{product.market ?? '市场未提供'}</span>
          </div>
          <h2>{product.title}</h2>
          {brand ? <p className="drawer-description">{brand}</p> : null}
          <PriceEvidence product={product} currency={currency} rates={rates} />
          <section className="drawer-section">
            <div className="section-title">商品信息</div>
            {product.specs.length ? (
              <div className="spec-pills">{product.specs.map((spec) => <span key={spec}>{spec}</span>)}</div>
            ) : null}
            {reasons ? (
              <p className="drawer-tradeoff"><b>排序依据</b>{reasons}</p>
            ) : null}
            {onTalk ? (
              <div className="drawer-talk">
                <Button variant="quiet" onClick={() => onTalk('为什么推荐这款')}>为什么选它</Button>
                <Button variant="quiet" onClick={() => onTalk('不要这款')}>不要这款</Button>
                <Button variant="quiet" onClick={() => onTalk('帮我比这款和上一件')}>和上一件比</Button>
              </div>
            ) : null}
          </section>
          <section className="purchase-check">
            <span>查看商户报价</span>
            <p>本服务只负责比较；{domain} 将提供商品详情与交易。</p>
            {url ? (
              <a className="button button-primary merchant-link" href={url} target="_blank" rel="noreferrer">
                前往 {domain} 查看
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
            {selected ? '已加入比较' : '加入比较'}
          </Button>
          <Button variant="quiet" onClick={onClose}>返回选购</Button>
        </div>
      </aside>
    </div>
  )
}
