import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { EvidenceStrip } from '../components/evidence/EvidenceStrip'
import { FxStrip } from '../components/evidence/FxStrip'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { CandidateCard, FilterBar } from '../features/candidates/CandidateCard'
import { CompareTray, DecisionCard, DecisionOverview, StageRail } from '../features/candidates/DecisionCard'
import { ConversationPanel } from '../features/conversation/ConversationPanel'
import { useMissionWorkspace } from '../features/missions/useMissionWorkspace'
import { ProductDrawer } from '../features/products/ProductDrawer'
import { rmbAmount, type Currency } from '../lib/currency'
import { platformName } from '../lib/platform'
import { stageText } from '../lib/format'
import type { ProductCandidate } from '../api/types'

export function MissionView({ currency }: { currency: Currency }) {
  const { missionId = '' } = useParams()
  const navigate = useNavigate()
  const workspace = useMissionWorkspace(missionId)
  const [detail, setDetail] = useState<ProductCandidate | null>(null)
  const mission = workspace.mission
  const ranked = workspace.ranked
  const thread = workspace.queries.thread.data
  const recommendation = workspace.queries.recommendation.data
  const budget = mission?.constraints.budget_cny ?? null
  const eligible = ranked.filter((item) => budget == null || (rmbAmount(item) != null && rmbAmount(item)! <= budget))
  const lowestId = ranked.reduce<string | null>((id, item) => {
    const amount = rmbAmount(item)
    if (amount == null) return id
    const current = ranked.find((row) => row.snapshot_id === id)
    const currentAmount = current ? rmbAmount(current) : null
    if (currentAmount == null || amount < currentAmount) return item.snapshot_id
    return id
  }, null)
  const platformCount = new Set(ranked.map((item) => platformName(item.merchant))).size
  const waiting = mission?.stage === 'clarifying' || (!ranked.length && mission?.stage === 'collecting' && mission.turn_phase !== 'researching')
  const running = mission?.turn_phase === 'researching' || mission?.turn_phase === 'refiltering'

  const compare = async () => {
    if (workspace.selectedIds.length < 2) return
    await workspace.persistComparison()
    navigate(`/missions/${missionId}/compare`)
  }

  if (workspace.queries.mission.isError) {
    return (
      <main className="workspace-view">
        <section className="empty-result">
          <Icon name="info" size={24} />
          <h2>打不开这笔选购</h2>
          <p>任务可能不属于当前匿名身份，或后端尚未就绪。</p>
          <Button variant="primary" onClick={() => navigate('/missions')}>返回列表</Button>
        </section>
      </main>
    )
  }

  if (!mission) {
    return (
      <main className="workspace-view">
        <section className="empty-result is-waiting">
          <Icon name="search" size={24} />
          <h2>正在打开选购</h2>
          <p>正在读取任务投影、候选与对话线程。</p>
        </section>
      </main>
    )
  }

  return (
    <main className="workspace-view">
      <div className="mission-header">
        <div>
          <div className="breadcrumb">我的选购 <Icon name="chevron" size={13} />推荐备选</div>
          <h1>{mission.constraints.query || mission.title}</h1>
          <div className="mission-subline">
            <span>{stageText(mission.stage, mission.turn_phase)}</span>
            {ranked.length > 0 ? <span>{ranked.length} 件备选{ranked.length === 1 ? '' : ` · ${platformCount} 个平台`}</span> : null}
          </div>
        </div>
      </div>
      <StageRail current="discover" />
      <FxStrip candidates={ranked} />
      <div className="workspace-layout">
        <ConversationPanel
          mission={mission}
          messages={thread?.messages ?? []}
          recommendation={recommendation}
          selectedCount={workspace.selected.length}
          canCompare={workspace.selected.length >= 2}
          busy={workspace.busy}
          currency={currency}
          onSend={(text) =>
            workspace.sendMessage.mutate({
              text,
              focusSnapshotId: workspace.focusSnapshotId ?? detail?.snapshot_id,
            })
          }
          onUndo={() => workspace.undo.mutate()}
          onCompare={() => void compare()}
          onOpen={(product) => {
            workspace.setFocusSnapshotId(product.snapshot_id)
            setDetail(product)
          }}
          onPreference={workspace.setPreference}
        />
        <section className="results-region">
          <EvidenceStrip candidates={ranked} />
          {waiting ? (
            <section className="empty-result is-waiting">
              <Icon name="info" size={24} />
              <h2>正在等你补充信息</h2>
              <p>我还需要确认商品类别才能检索备选。请在左侧对话里描述你想找的东西。</p>
            </section>
          ) : running && !ranked.length ? (
            <section className="empty-result is-waiting">
              <Icon name="search" size={24} />
              <h2>正在检索备选</h2>
              <p>任务已提交，候选就绪后会自动刷新。</p>
            </section>
          ) : (
            <>
              <DecisionOverview candidates={ranked} eligibleCount={eligible.length} platformCount={platformCount} mission={mission} />
              {recommendation?.primary ? (
                <DecisionCard recommendation={recommendation} mission={mission} currency={currency} />
              ) : (
                <section className="empty-result">
                  <Icon name="search" size={24} />
                  <h2>{mission.warnings[0] || '当前还没有可推荐备选'}</h2>
                  <p>可以提高预算、调整偏好，或在对话里换一类商品。</p>
                </section>
              )}
              <div className="candidate-section-heading">
                <div>
                  <span className="section-eyebrow">候选证据</span>
                  <h2>核对后加入比较</h2>
                </div>
                <p>每张卡片代表一个可比较候选。评分、品牌、库存若未由数据源提供，会明确标为未提供。</p>
              </div>
              <FilterBar
                count={ranked.length}
                platformCount={platformCount}
                query={mission.constraints.query}
                preference={mission.constraints.preference}
                onPreference={workspace.setPreference}
                onReset={() => workspace.patchConstraints.mutate({ preference: 'balanced' })}
              />
              <section className="product-results">
                <div className="products-grid">
                  {ranked.map((product, index) => (
                    <CandidateCard
                      key={product.snapshot_id}
                      product={product}
                      rank={product.rank ?? index + 1}
                      selected={workspace.selectedIds.includes(product.snapshot_id)}
                      toggle={() => workspace.toggleSelected(product.snapshot_id)}
                      detail={() => {
                        workspace.setFocusSnapshotId(product.snapshot_id)
                        setDetail(product)
                      }}
                      budget={budget}
                      lowest={product.snapshot_id === lowestId}
                      currency={currency}
                      lead={recommendation?.primary?.snapshot_id === product.snapshot_id}
                    />
                  ))}
                </div>
              </section>
            </>
          )}
          <CompareTray
            selected={workspace.selected}
            onRemove={workspace.toggleSelected}
            onCompare={() => void compare()}
          />
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
