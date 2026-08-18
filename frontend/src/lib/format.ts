export type Preference = 'balanced' | 'noise' | 'battery' | 'lowest'

export function preferenceText(preference: Preference): string {
  return preference === 'battery'
    ? '优先续航'
    : preference === 'noise'
      ? '优先降噪'
      : preference === 'lowest'
        ? '按商品价'
        : '综合推荐'
}

export function budgetText(budget: number | null | undefined): string {
  return budget ? `¥${budget.toLocaleString()} 内` : '未设置预算'
}

export function stageText(stage: string, turnPhase?: string): string {
  if (turnPhase === 'researching') return '正在检索'
  if (turnPhase === 'refiltering') return '正在按条件重排'
  if (turnPhase === 'responding') return '正在回答'
  switch (stage) {
    case 'clarifying':
      return '待补充'
    case 'searching':
    case 'ranking':
      return '检索中'
    case 'ready':
      return '备选已就绪'
    case 'degraded':
      return '部分可用'
    case 'failed':
      return '失败'
    default:
      return '收集中'
  }
}

export function timeLabel(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const sameDay = date.toDateString() === new Date().toDateString()
  return new Intl.DateTimeFormat('zh-CN', sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

export function availabilityText(value: string): string {
  if (value === 'in_stock') return '有货'
  if (value === 'limited') return '库存有限'
  if (value === 'out_of_stock') return '无货'
  return '暂无库存信息'
}
