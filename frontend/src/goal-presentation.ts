interface GoalAttribute {
  key: string
  operator?: string
  value: unknown
}

const ATTRIBUTE_TERMS: Readonly<Record<string, { label: string; unit?: string }>> = {
  brand: { label: '品牌' },
  capacity_kg: { label: '容量', unit: 'kg' },
  color: { label: '颜色' },
  energy_efficiency: { label: '节能' },
  model: { label: '型号' },
  model_line: { label: '产品系列' },
  noise_cancelling: { label: '降噪' },
  noise_level: { label: '噪声水平' },
  use_case: { label: '使用场景' },
}

const VALUE_TERMS: Readonly<Record<string, string>> = {
  commute: '通勤',
  false: '否',
  high: '高',
  low: '低',
  true: '是',
}

function renderValue(value: unknown, unit?: string): string {
  const raw = Array.isArray(value) ? value.join('、') : String(value)
  const translated = VALUE_TERMS[raw.toLocaleLowerCase('en-US')] ?? raw
  return unit ? `${translated} ${unit}` : translated
}

export function renderGoalAttribute(attribute: GoalAttribute): string {
  const term = ATTRIBUTE_TERMS[attribute.key]
  const value = renderValue(attribute.value, term?.unit)
  if (!term) return `自定义条件：${value}`
  const relation = attribute.operator === 'GTE'
    ? '至少'
    : attribute.operator === 'LTE'
      ? '不超过'
      : attribute.operator === 'CONTAINS'
        ? '包含'
        : ''
  return `${term.label}${relation ? ` ${relation}` : ''} ${value}`
}
