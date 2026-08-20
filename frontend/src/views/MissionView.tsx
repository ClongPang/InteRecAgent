import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { FxStrip } from '../components/evidence/FxStrip'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { CandidateCard } from '../features/candidates/CandidateCard'
import { DecisionCard } from '../features/candidates/DecisionCard'
import { CompareStrip } from '../features/candidates/EvidenceDock'
import { ConversationPanel } from '../features/conversation/ConversationPanel'
import { useMissionWorkspace } from '../features/missions/useMissionWorkspace'
import { ProductDrawer } from '../features/products/ProductDrawer'
import { ratesFromCandidates, rmbAmount, type Currency } from '../lib/currency'
import { stageText } from '../lib/format'
import { beliefOf, type ProductCandidate } from '../api/types'

export function MissionView({ currency }: { currency: Currency }) {
  const { missionId = '' } = useParams()
  const navigate = useNavigate()
  const workspace = useMissionWorkspace(missionId)
  const [detail, setDetail] = useState<ProductCandidate | null>(null)
  const mission = workspace.mission
  const ranked = workspace.ranked
  const thread = workspace.queries.thread.data
  const recommendation = workspace.queries.recommendation.data
  const rates = ratesFromCandidates(ranked)
  const rejected = new Set(beliefOf(mission ?? { belief: null }).rejected_snapshot_ids)
  const lowestId = ranked.reduce<string | null>((best, item) => {
    const amount = rmbAmount(item)
    if (amount == null) return best
    const current = ranked.find((row) => row.snapshot_id === best)
    const bestAmount = current ? rmbAmount(current) : null
    if (bestAmount == null || amount < bestAmount) return item.snapshot_id
    return best
  }, null)
  const running = mission?.turn_phase === 'researching' || mission?.turn_phase === 'refiltering'

  const openSnapshot = (snapshotId: string) => {
    workspace.setFocusSnapshotId(snapshotId)
    const product = ranked.find((item) => item.snapshot_id === snapshotId)
    if (product) setDetail(product)
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
          <div className="breadcrumb">我的选购 <Icon name="chevron" size={13} />对话推荐</div>
          <h1>{mission.constraints.query || mission.title}</h1>
          <div className="mission-subline">
            <span>{stageText(mission.stage, mission.turn_phase)}</span>
            {ranked.length > 0 ? <span>{ranked.length} 件可引用候选</span> : null}
            {running ? <span>{mission.turn_phase === 'refiltering' ? '正在按你的态度重排' : '正在检索'}</span> : null}
          </div>
        </div>
      </div>
      {ranked.length > 0 ? <FxStrip candidates={ranked} /> : null}
      <div className="workspace-layout is-dialogue">
        <ConversationPanel
          mission={mission}
          messages={thread?.messages ?? []}
          pendingText={workspace.pendingText}
          draftAgent={workspace.draftAgent}
          progress={workspace.progress}
          focusTitle={workspace.focusProduct?.title ?? null}
          busy={workspace.busy}
          onSend={workspace.send}
          onUndo={() => workspace.undo.mutate()}
          onCancel={workspace.cancel}
          onOpen={openSnapshot}
          onClearFocus={() => workspace.setFocusSnapshotId(null)}
        />
        <section className="results-region">
          <DecisionCard
            recommendation={recommendation}
            mission={mission}
            currency={currency}
            rates={rates}
            onOpen={openSnapshot}
          />
          {ranked.length ? (
            <div className="products-grid" aria-label="当前候选">
              {ranked.map((product) => (
                <CandidateCard
                  key={product.snapshot_id}
                  product={product}
                  rank={product.rank ?? 0}
                  selected={workspace.draftCompare.includes(product.snapshot_id)}
                  toggle={() => workspace.toggleCompare(product.snapshot_id)}
                  detail={() => {
                    workspace.setFocusSnapshotId(product.snapshot_id)
                    setDetail(product)
                  }}
                  budget={mission.constraints.budget_cny}
                  lowest={lowestId === product.snapshot_id}
                  currency={currency}
                  lead={product.rank === 1 && !rejected.has(product.snapshot_id)}
                  rejected={rejected.has(product.snapshot_id)}
                />
              ))}
            </div>
          ) : (
            <section className="empty-result is-waiting">
              <Icon name="search" size={24} />
              <h2>还没有可引用的商品</h2>
              <p>先在对话里说明品类和预算，检索完成后会在这里摊开候选。</p>
            </section>
          )}
          <CompareStrip items={workspace.selected} onFocus={(product) => openSnapshot(product.snapshot_id)} />
        </section>
      </div>
      {detail ? (
        <ProductDrawer
          product={detail}
          selected={workspace.draftCompare.includes(detail.snapshot_id)}
          currency={currency}
          rates={rates}
          onClose={() => setDetail(null)}
          onToggle={() => workspace.toggleCompare(detail.snapshot_id)}
          onTalk={(text) => {
            workspace.send(text, { focusSnapshotId: detail.snapshot_id })
            setDetail(null)
          }}
        />
      ) : null}
    </main>
  )
}
