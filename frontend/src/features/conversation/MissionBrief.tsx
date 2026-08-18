import type { MissionView } from '../../api/types'
import { budgetText, preferenceText } from '../../lib/format'

export function MissionBrief({ mission }: { mission: MissionView }) {
  const { constraints } = mission
  return (
    <section className="mission-brief" aria-label="当前选购条件">
      <div className="brief-filters">
        <span className="brief-condition brief-condition-version" title="条件版本：仅约束内容变化时递增">
          V{mission.constraints_version}
        </span>
        <span className="brief-condition brief-condition-primary">{constraints.query || mission.title}</span>
        <span className="brief-condition">预算 {budgetText(constraints.budget_cny)}</span>
        <span className="brief-condition">{preferenceText(constraints.preference)}</span>
        {constraints.only_in_stock ? <span className="brief-condition">仅看有货</span> : null}
      </div>
    </section>
  )
}
