import { beliefOf, type MissionView } from '../../api/types'
import { budgetText, preferenceText, priceStanceText } from '../../lib/format'

export function BeliefBar({
  mission,
  onPrefill,
}: {
  mission: MissionView
  onPrefill?: (text: string) => void
}) {
  const { constraints } = mission
  const belief = beliefOf(mission)
  const stance = priceStanceText(belief.price_sensitivity)
  const rejected = belief.rejected_snapshot_ids.length
  const unsupported = belief.soft.filter((item) => item.status === 'unsupported')
  const chips: { key: string; label: string; text?: string; tone?: 'primary' | 'soft' | 'warn' }[] = [
    { key: 'query', label: constraints.query || mission.title, tone: 'primary' },
    {
      key: 'budget',
      label: constraints.budget_cny != null ? `硬预算 ${budgetText(constraints.budget_cny)}` : '未设硬预算',
      text: constraints.budget_cny ? `预算 ${constraints.budget_cny} 元` : '预算 2000 元',
    },
  ]
  if (belief.use_case) {
    chips.push({ key: 'use', label: `用途 ${belief.use_case}`, tone: 'soft' })
  }
  for (const gate of belief.spec_gates ?? []) {
    chips.push({
      key: `gate-${gate.attr}`,
      label: gate.required ? `只要 ${gate.attr}` : `偏好 ${gate.attr}`,
      tone: 'soft',
    })
  }
  const rejectReason = [...belief.critiques].reverse().find((item) => item.kind === 'reject_item' && item.reason && item.reason !== 'unknown')
  if (stance) {
    chips.push({ key: 'stance', label: stance, text: '再便宜一点', tone: 'soft' })
  }
  if (rejectReason?.reason === 'price') {
    chips.push({ key: 'reject-reason', label: '排除原因：太贵', tone: 'warn' })
  }
  chips.push({
    key: 'markets',
    label: constraints.markets.length ? `市场 ${constraints.markets.join(' / ')}` : '未指定市场',
    text: '美国和新加坡',
  })
  chips.push({
    key: 'pref',
    label: preferenceText(constraints.preference),
    text: preferenceText(constraints.preference),
  })
  if (rejected > 0) {
    chips.push({ key: 'rejected', label: `已排除 ${rejected} 件`, text: '不要这款', tone: 'warn' })
  }
  for (const term of constraints.excluded_terms) {
    chips.push({ key: `ex-${term}`, label: `排除 ${term}`, text: `不要${term}`, tone: 'warn' })
  }
  for (const item of unsupported) {
    const label = item.attr === 'weight' ? '重量：快照无此字段' : `${item.attr}：当前无法排序`
    chips.push({ key: `soft-${item.attr}`, label, text: item.attr === 'weight' ? '更轻一点' : item.attr })
  }
  return (
    <section className="mission-brief" aria-label="当前选购条件">
      <div className="brief-filters">
        {chips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            className={`brief-condition${chip.tone === 'primary' ? ' brief-condition-primary' : ''}${chip.tone === 'soft' ? ' brief-condition-soft' : ''}${chip.tone === 'warn' ? ' brief-condition-warn' : ''}`}
            onClick={() => chip.text && onPrefill?.(chip.text)}
            title={chip.text ? '点一下会填进输入框，不会直接改条件' : undefined}
          >
            {chip.label}
          </button>
        ))}
      </div>
    </section>
  )
}
