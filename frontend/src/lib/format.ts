import type { PreferenceBelief, ProductCandidate } from '../api/types'

export type Preference = 'balanced' | 'noise' | 'battery' | 'lowest'

const REASON_TEXT: Record<string, string> = {
  within_budget: '预算内',
  lowest_estimated_cny: '当前估算最低',
  in_stock: '有货',
  merchant_marked_in_stock: '店家标注有货',
  matches_noise_cue: '标题含降噪线索',
  matches_battery_cue: '标题含续航线索',
  price_sensitive: '按更便宜态度加权',
  item_type_match: '商品品类符合需求',
  relation_match: '确认是目标商品本体',
  brand_match: '品牌符合需求',
  stock_match: '库存状态符合要求',
  budget_match: '价格在预算范围内',
}

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

export function reasonText(reason: string): string {
  return REASON_TEXT[reason] ?? '符合当前筛选条件'
}

export function reasonsText(reasons: string[] | undefined): string {
  return (reasons ?? []).map(reasonText).filter(Boolean).join(' · ')
}

export function brandLabel(product: Pick<ProductCandidate, 'brand' | 'derived_fields'>): string | null {
  if (!product.brand) return null
  return product.derived_fields.includes('brand') ? `${product.brand}（标题解析）` : product.brand
}

export function priceStanceText(value: string | null | undefined): string | null {
  if (value === 'too_expensive' || value === 'want_cheaper') return '觉得偏贵'
  return null
}

export function composerPlaceholder(
  belief: PreferenceBelief,
  focusTitle?: string | null,
): string {
  if (focusTitle) return `问问「${focusTitle}」为什么推荐，或说不要这款`
  if (priceStanceText(belief.price_sensitivity)) return '例如：收紧预算，或帮我比前两个'
  return '例如：说一个人民币预算，或再便宜一点'
}

export function stageText(stage: string, turnPhase?: string): string {
  if (turnPhase === 'researching') return '正在检索'
  if (turnPhase === 'refiltering') return '正在按你的态度重排'
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

export function availabilityText(
  value: string,
  source?: ProductCandidate['stock_source'],
): string {
  if (value === 'unknown' || !value) return ''
  const merchant = source === 'metadata'
  if (value === 'in_stock') return merchant ? '店家标注有货' : '有货'
  if (value === 'limited') return merchant ? '店家标注库存有限' : '库存有限'
  if (value === 'out_of_stock') return merchant ? '店家标注无货' : '无货'
  return ''
}
