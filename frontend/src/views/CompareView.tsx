import { useMemo, useState, type CSSProperties } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { EvidenceStrip } from '../components/evidence/EvidenceStrip'
import { FxStrip } from '../components/evidence/FxStrip'
import { PriceEvidence } from '../components/evidence/PriceEvidence'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { PlatformMark } from '../components/ui/PlatformMark'
import { DecisionOverview, StageRail } from '../features/candidates/DecisionCard'
import { ConversationPanel } from '../features/conversation/ConversationPanel'
import { useMissionWorkspace } from '../features/missions/useMissionWorkspace'
import { ProductDrawer } from '../features/products/ProductDrawer'
import { CURRENCY_SYMBOL, displayAmount, nativePriceText, rmbAmount, type Currency } from '../lib/currency'
import { availabilityText } from '../lib/format'
import { platformName } from '../lib/platform'
import type { ProductCandidate } from '../api/types'

export function CompareView({ currency }: { currency: Currency }) {
  const { missionId = '' } = useParams()
  const navigate = useNavigate()
  const workspace = useMissionWorkspace(missionId)
  const [detail, setDetail] = useState<ProductCandidate | null>(null)
  const mission = workspace.mission
  const thread = workspace.queries.thread.data
  const recommendation = workspace.queries.recommendation.data
  const items = workspace.selected.length ? workspace.selected : workspace.ranked.filter((item) => (mission?.comparison_snapshot_ids ?? []).includes(item.snapshot_id))
  const lowestId = useMemo(() => {
    return items.reduce<string | null>((id, item) => {
      const amount = rmbAmount(item)
      if (amount == null) return id
      const current = items.find((row) => row.snapshot_id === id)
      const currentAmount = current ? rmbAmount(current) : null
      if (currentAmount == null || amount < currentAmount) return item.snapshot_id
      return id
    }, null)
  }, [items])
  const lead = items[0]
  const tableStyle = { '--compare-columns': items.length } as CSSProperties

  if (!mission) {
    return (
      <main className="workspace-view">
        <section className="empty-result is-waiting">
          <Icon name="search" size={24} />
          <h2>正在打开对比</h2>
        </section>
      </main>
    )
  }

  if (items.length < 2) {
    return (
      <main className="workspace-view">
        <section className="empty-result">
          <Icon name="grid" size={24} />
          <h2>还需要至少 2 件备选</h2>
          <p>先在备选页加入商品，再进行横向比较。</p>
          <Button variant="primary" onClick={() => navigate(`/missions/${missionId}`)}>返回备选页</Button>
        </section>
      </main>
    )
  }

  const leadAmount = displayAmount(rmbAmount(lead), currency)

  return (
    <main className="workspace-view compare-view">
      <div className="mission-header">
        <div>
          <div className="breadcrumb">
            <button onClick={() => navigate(`/missions/${missionId}`)}>推荐备选</button>
            <Icon name="chevron" size={13} />
            对比所选
          </div>
          <h1>在 {items.length} 件备选中做决定</h1>
          <div className="mission-meta">
            <span>选购 V{mission.constraints_version}</span>
            <span>继续提问可更新推荐</span>
          </div>
        </div>
        <button className="button button-quiet" onClick={() => navigate(`/missions/${missionId}`)}>
          <Icon name="back" size={15} />
          再挑备选
        </button>
      </div>
      <StageRail current="compare" />
      <FxStrip candidates={items} />
      <div className="workspace-layout">
        <ConversationPanel
          mission={mission}
          messages={thread?.messages ?? []}
          recommendation={recommendation}
          selectedCount={items.length}
          canCompare
          comparing
          busy={workspace.busy}
          currency={currency}
          onSend={(text) => workspace.sendMessage.mutate(text)}
          onUndo={() => workspace.undo.mutate()}
          onCompare={() => undefined}
          onOpen={setDetail}
          onPreference={workspace.setPreference}
          onStock={workspace.setOnlyInStock}
        />
        <section className="results-region">
          <DecisionOverview
            candidates={items}
            eligibleCount={items.length}
            platformCount={new Set(items.map((item) => platformName(item.merchant))).size}
            mission={mission}
          />
          <section className="decision-card compare-decision">
            <div className="decision-icon"><Icon name="spark" size={20} /></div>
            <div className="decision-copy">
              <span>比较首选 · 按当前排序</span>
              <h2>{lead.title}</h2>
              <p>当前比较集合中的第一件候选。运费、税费与配送资格以商户结算页为准。</p>
              <small className="decision-boundary">评分、品牌、库存若未提供，不会用示意数据补写。</small>
            </div>
            <div className="decision-price">
              <span>商品价估算</span>
              <strong>{leadAmount == null ? '未提供' : `${CURRENCY_SYMBOL[currency]}${leadAmount}`}</strong>
              <small>{nativePriceText(lead)}</small>
            </div>
          </section>
          <EvidenceStrip candidates={items} />
          <section className="comparison-table-wrap">
            <div className="table-toolbar">
              <span>关键差异</span>
              <span>先比较商品价与取舍，再打开详情核对完整信息</span>
            </div>
            <div className="comparison-table revised-table" style={tableStyle}>
              <div className="comparison-label-column">
                <div>候选</div>
                <div>商品价</div>
                <div>关键差异</div>
                <div>操作</div>
              </div>
              {items.map((product) => {
                const isLead = product.snapshot_id === lead.snapshot_id
                const isLowest = product.snapshot_id === lowestId
                const missingStock = product.availability === 'unknown'
                return (
                  <div className={`comparison-product ${isLead ? 'is-recommended' : ''}`} key={product.snapshot_id}>
                    <div className="comparison-product-head">
                      <div className="cmp-head-tags">
                        {isLead ? <span className="compare-tag">当前推荐</span> : null}
                        {isLowest ? <span className="cmp-badge cmp-badge--lowest">最低价</span> : null}
                        {missingStock ? <span className="cmp-badge cmp-badge--missing">库存待确认</span> : null}
                      </div>
                      <button
                        className="column-remove"
                        onClick={() => {
                          workspace.toggleSelected(product.snapshot_id)
                          const next = workspace.selectedIds.filter((id) => id !== product.snapshot_id)
                          if (next.length >= 2) void workspace.persistComparison(next)
                        }}
                        aria-label={`移除 ${product.title}`}
                        title="移出对比"
                      >
                        <Icon name="close" size={13} />
                      </button>
                      <PlatformMark merchant={product.merchant} />
                      <button className="cmp-head-title" onClick={() => setDetail(product)}>
                        {product.title}
                        <Icon name="external" size={13} />
                      </button>
                      <div className="cmp-head-meta">
                        <span>{product.market ?? '市场未提供'}</span>
                        <span className={`stock-chip ${product.availability === 'in_stock' ? 'confirmed' : 'pending'}`}>
                          {availabilityText(product.availability)}
                        </span>
                      </div>
                    </div>
                    <div className="compare-cell price-cell">
                      <PriceEvidence product={product} compact lowest={isLowest} currency={currency} compare />
                    </div>
                    <div className="compare-cell insight-cell">
                      <p>{product.decision_reasons[0] || '排序依据未提供'}</p>
                      <div className="insight-specs">
                        {product.specs.length
                          ? product.specs.slice(0, 2).map((spec) => <span key={spec}>{spec}</span>)
                          : <span>结构化规格未提供</span>}
                      </div>
                    </div>
                    <div className="compare-cell action-cell">
                      <Button onClick={() => setDetail(product)}>查看详情</Button>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        </section>
      </div>
      {detail ? (
        <ProductDrawer
          product={detail}
          selected={workspace.selectedIds.includes(detail.snapshot_id)}
          currency={currency}
          onClose={() => setDetail(null)}
          onToggle={() => workspace.toggleSelected(detail.snapshot_id)}
        />
      ) : null}
    </main>
  )
}
