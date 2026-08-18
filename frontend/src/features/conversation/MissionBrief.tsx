import type { MissionView } from '../../api/types'
import { budgetText, preferenceText } from '../../lib/format'

export function BeliefBar({
  mission,
  onPrefill,
}: {
  mission: MissionView
  onPrefill?: (text: string) => void
}) {
  const { constraints } = mission
  const chips: { label: string; text?: string }[] = [
    { label: constraints.query || mission.title },
    { label: `预算 ${budgetText(constraints.budget_cny)}`, text: constraints.budget_cny ? `预算 ${constraints.budget_cny} 元` : '预算 2000 元' },
    { label: preferenceText(constraints.preference), text: preferenceText(constraints.preference) },
  ]
  if (mission.dialogue?.stance === 'too_expensive' || mission.dialogue?.stance === 'want_cheaper') {
    chips.push({ label: '觉得偏贵', text: '再便宜一点' })
  }
  return (
    <section className="mission-brief" aria-label="当前选购条件">
      <div className="brief-filters">
        {chips.map((chip) => (
          <button
            key={chip.label}
            type="button"
            className={`brief-condition${chip.label === (constraints.query || mission.title) ? ' brief-condition-primary' : ''}`}
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
