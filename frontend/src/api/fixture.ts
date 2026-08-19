import type { MissionApi } from './missionApi'
import type {
  CandidateSetView,
  ConstraintsPatch,
  DialogueState,
  MissionConstraints,
  MissionView,
  NextMove,
  PreferenceBelief,
  ProductCandidate,
  RecommendationView,
  ThreadMessage,
} from './types'
import { emptyBelief } from './types'

type Snapshot = {
  constraints: MissionConstraints
  belief: PreferenceBelief
  dialogue: DialogueState
  candidates: CandidateSetView
  recommendation: RecommendationView | null
}

type Store = {
  missions: MissionView[]
  candidates: Record<string, CandidateSetView>
  recommendations: Record<string, RecommendationView>
  threads: Record<string, ThreadMessage[]>
  history: Record<string, Snapshot[]>
}

const NOISE_CUES = ['降噪', 'noise', 'cancelling', 'anc', 'wh-1000', 'wh1000', 'xm5', 'xm4', 'qc ultra']
const BATTERY_CUES = ['续航', 'battery', '小时', 'hours', 'hrs']
const TITLE_BRANDS = ['Sony', 'Bose', 'Sennheiser', 'Soundcore', 'Apple', 'Samsung', 'Dell']

const CATALOG: ProductCandidate[] = [
  candidate('snap-sony', 'sony-xm5', 'Sony WH-1000XM5 Wireless', 'amazon', 'US', 'USD', 299, 2149, 7.1882),
  candidate('snap-bose', 'bose-qc', 'Bose QuietComfort Ultra', 'lazada', 'SG', 'SGD', 399, 2118, 5.3083),
  candidate('snap-m4', 'senn-m4', 'Sennheiser Momentum 4 Wireless', 'bestbuy', 'US', 'USD', 329.95, 2378, 7.1882),
  candidate('snap-q45', 'q45', 'Soundcore Space Q45', 'amazon', 'US', 'USD', 149.99, 1078, 7.1882),
]

function derivedBrand(title: string): { brand: string | null; derived_fields: string[] } {
  const brand = TITLE_BRANDS.find((token) => title.toLowerCase().includes(token.toLowerCase())) ?? null
  return { brand, derived_fields: brand ? ['brand'] : [] }
}

function candidate(
  snapshotId: string,
  sourceId: string,
  title: string,
  merchant: string,
  market: string,
  currency: string,
  amount: number,
  cny: number,
  rate: number,
): ProductCandidate {
  const derived = derivedBrand(title)
  return {
    snapshot_id: snapshotId,
    source: 'buywhere',
    source_product_id: sourceId,
    title,
    merchant,
    market,
    native_price: { amount, currency },
    estimated_cny: {
      amount: cny,
      rate,
      source: 'fixture',
      rate_date: '2026-08-15',
      fetched_at: '2026-08-15T14:32:00Z',
    },
    fx_failed: false,
    brand: derived.brand,
    rating: null,
    review_count: null,
    availability: 'unknown',
    specs: [],
    derived_fields: derived.derived_fields,
    unavailable_fields: ['rating', 'review_count', 'availability', 'structured_specs'],
    merchant_url: `https://example.com/${sourceId}`,
    source_updated_at: '2026-08-15T14:32:00Z',
    rank: null,
    decision_reasons: [],
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function emptyConstraints(): MissionConstraints {
  return {
    query: null,
    budget_cny: null,
    markets: ['US', 'SG'],
    preference: 'balanced',
    only_in_stock: false,
    excluded_terms: [],
  }
}

function cloneBelief(belief?: PreferenceBelief | null): PreferenceBelief {
  const source = belief ?? emptyBelief()
  return {
    use_case: source.use_case ?? null,
    rejected_snapshot_ids: [...(source.rejected_snapshot_ids ?? [])],
    critiques: [...(source.critiques ?? [])],
    soft: [...(source.soft ?? [])],
    price_sensitivity: source.price_sensitivity ?? null,
  }
}

function newMission(id: string, title: string): MissionView {
  const ts = nowIso()
  return {
    id,
    title,
    stage: 'collecting',
    constraints_version: 1,
    constraints: emptyConstraints(),
    active_run_id: null,
    candidate_set_id: null,
    comparison_snapshot_ids: [],
    recommendation_run_id: null,
    warnings: [],
    turn_phase: 'idle',
    dialogue: { focus_snapshot_id: null, last_act: null, mentioned_snapshot_ids: [] },
    belief: emptyBelief(),
    created_at: ts,
    updated_at: ts,
  }
}

function titleMatches(title: string, cues: string[]): boolean {
  const blob = title.toLowerCase()
  return cues.some((cue) => blob.includes(cue.toLowerCase()))
}

function itemCny(item: ProductCandidate): number | null {
  return item.estimated_cny?.amount ?? null
}

function rankCatalog(constraints: MissionConstraints, belief: PreferenceBelief): ProductCandidate[] {
  const rejected = new Set(belief.rejected_snapshot_ids)
  const excluded = constraints.excluded_terms.map((term) => term.toLowerCase())
  const priceSensitive = belief.price_sensitivity === 'too_expensive' || belief.price_sensitivity === 'want_cheaper'
  const priced = CATALOG.map(itemCny).filter((value): value is number => value != null)
  const lo = priced.length ? Math.min(...priced) : 0
  const hi = priced.length ? Math.max(...priced) : 0
  const wantLowest = constraints.preference === 'lowest' || priceSensitive
  const scored = CATALOG.map((item) => {
    const blocked = excluded.some((term) => `${item.title} ${item.brand ?? ''}`.toLowerCase().includes(term))
    const cny = itemCny(item)
    let total = 0
    let weight = 0
    if (constraints.budget_cny != null && cny != null) {
      total += (cny <= constraints.budget_cny ? 1 : 0.2) * 0.35
      weight += 0.35
    }
    const priceWeight = wantLowest ? 0.55 : constraints.preference === 'noise' || constraints.preference === 'battery' ? 0.18 : 0.4
    if (cny != null && hi > lo) {
      total += (1 - (cny - lo) / (hi - lo)) * priceWeight
      weight += priceWeight
    } else if (cny != null) {
      total += priceWeight
      weight += priceWeight
    }
    if (rejected.has(item.snapshot_id) || blocked) {
      weight += 0.3
    }
    if (constraints.preference === 'noise' || constraints.preference === 'battery') {
      const cues = constraints.preference === 'noise' ? NOISE_CUES : BATTERY_CUES
      total += (titleMatches(item.title, cues) ? 1 : 0.15) * 0.4
      weight += 0.4
    }
    const score = total / (weight || 1)
    return { item, score, blocked, cny }
  })
  scored.sort((a, b) => {
    const aRejected = rejected.has(a.item.snapshot_id) || a.blocked ? 1 : 0
    const bRejected = rejected.has(b.item.snapshot_id) || b.blocked ? 1 : 0
    if (aRejected !== bRejected) return aRejected - bRejected
    if (b.score !== a.score) return b.score - a.score
    return (a.cny ?? Infinity) - (b.cny ?? Infinity)
  })
  return scored.map((entry, index) => {
    const reasons: string[] = []
    if (constraints.budget_cny != null && entry.cny != null && entry.cny <= constraints.budget_cny) {
      reasons.push('within_budget')
    }
    if (index === 0) reasons.push('lowest_estimated_cny')
    if (constraints.preference === 'noise' && titleMatches(entry.item.title, NOISE_CUES)) {
      reasons.push('matches_noise_cue')
    }
    if (constraints.preference === 'battery' && titleMatches(entry.item.title, BATTERY_CUES)) {
      reasons.push('matches_battery_cue')
    }
    if (priceSensitive) reasons.push('price_sensitive')
    return { ...entry.item, rank: index + 1, decision_reasons: reasons }
  })
}

function parseConstraints(text: string): Partial<MissionConstraints> {
  const budget = text.match(/(\d{3,6})\s*(?:元|块)/)
  const query = text
    .replace(/(?:预算|不超过).*?(?:元|块)?/g, '')
    .replace(/优先\s*(续航|降噪)|只看有货|仅看有货|太贵了?|再便宜一点|不要这款|帮我比前两个|为什么推荐这款|为什么推荐/g, '')
    .trim()
  const preference = /优先\s*续航/.test(text)
    ? 'battery'
    : /优先\s*降噪/.test(text)
      ? 'noise'
      : /低价|价格优先/.test(text)
        ? 'lowest'
        : undefined
  const exclude = text.match(/(?:不要|别买|排除)\s*([^\s，,。；;]+)/)
  const term = exclude?.[1]?.replace(/[的了呢啊]/g, '')
  return {
    query: query || undefined,
    budget_cny: budget ? Number(budget[1]) : undefined,
    preference,
    only_in_stock: /只看有货|仅看有货/.test(text),
    excluded_terms: term && !['这款', '这一款', '这个', '它'].includes(term) ? [term] : undefined,
  }
}

function classify(text: string): {
  kind: 'stance' | 'reject' | 'compare' | 'why' | 'undo' | 'refine'
  stance?: string
} {
  if (/撤销|还原刚才|undo/i.test(text)) return { kind: 'undo' }
  if (/比较|对比|横评|比一比|比一下|帮我比/.test(text)) return { kind: 'compare' }
  if (/(?:不要|别买|排除)\s*[^\s，,。；;]+/.test(text)) return { kind: 'reject' }
  if (/为什么推荐|为什么选|推荐理由/.test(text)) return { kind: 'why' }
  if (/太贵|好贵|贵了|超出预算/.test(text)) return { kind: 'stance', stance: 'too_expensive' }
  if (/再便宜|便宜点|更便宜|收一[点下]预算/.test(text)) return { kind: 'stance', stance: 'want_cheaper' }
  if (/更轻|轻一点|轻便一点|太重/.test(text)) return { kind: 'stance', stance: 'want_lighter' }
  return { kind: 'refine' }
}

function markPriceStance(belief: PreferenceBelief, stance: string): PreferenceBelief {
  const next = cloneBelief(belief)
  next.soft = next.soft.filter((item) => item.attr !== 'price')
  next.soft.push({ attr: 'price', direction: 'lower', status: 'active' })
  next.critiques.push({ kind: 'price_stance', attr: 'price' })
  next.price_sensitivity = stance
  return next
}

function rejectItem(belief: PreferenceBelief, snapshotId: string): PreferenceBelief {
  const next = cloneBelief(belief)
  if (snapshotId && !next.rejected_snapshot_ids.includes(snapshotId)) {
    next.rejected_snapshot_ids.push(snapshotId)
  }
  next.critiques.push({ kind: 'reject_item', snapshot_id: snapshotId })
  return next
}

function markUnsupported(belief: PreferenceBelief, attr: string): PreferenceBelief {
  const next = cloneBelief(belief)
  next.soft = next.soft.filter((item) => item.attr !== attr)
  next.soft.push({ attr, direction: 'lower', status: 'unsupported' })
  return next
}

function budgetMove(budgetCny: number | null, delta?: number): NextMove {
  if (budgetCny == null) return { label: '设个预算', text: '预算 2500 元' }
  const raw = delta != null ? budgetCny - delta : budgetCny * 0.8
  const target = Math.max(100, Math.round(raw / 100) * 100)
  return { label: `预算 ${target} 元`, text: `预算 ${target} 元` }
}

function nextMoves(
  ranked: ProductCandidate[],
  kind: string,
  belief: PreferenceBelief,
  budgetCny: number | null,
): NextMove[] {
  if (kind === 'stance') {
    return [
      budgetMove(budgetCny),
      { label: '对比前两件', text: '帮我比前两个' },
    ]
  }
  const unsupportedWeight = belief.soft.some((item) => item.attr === 'weight' && item.status === 'unsupported')
  if (unsupportedWeight) {
    return [
      { label: '为什么推荐', text: '为什么推荐' },
      { label: '再便宜一点', text: '再便宜一点' },
    ]
  }
  if (ranked.length < 2) {
    return [
      { label: '再便宜一点', text: '再便宜一点' },
      { label: '对比前两件', text: '帮我比前两个' },
    ]
  }
  const first = ranked[0]
  const second = ranked[1]
  const moves: NextMove[] = [{ label: '为什么推荐', text: '为什么推荐' }, { label: '对比前两件', text: '帮我比前两个' }]
  const a = itemCny(first)
  const b = itemCny(second)
  if (a != null && b != null && a !== b) {
    const gap = Math.round(Math.abs(a - b))
    moves.push(budgetCny != null
      ? { label: `再收 ¥${gap}`, text: budgetMove(budgetCny, gap).text }
      : { label: '再便宜一点', text: '再便宜一点' })
  } else {
    moves.push(budgetCny != null ? budgetMove(budgetCny) : { label: '再便宜一点', text: '再便宜一点' })
  }
  if (first.brand) moves.push({ label: `不要${first.brand}`, text: `不要${first.brand}` })
  else moves.push({ label: '不要这款', text: '不要这款' })
  if (belief.price_sensitivity === 'too_expensive' || belief.price_sensitivity === 'want_cheaper') {
    if (!moves.some((item) => item.text.startsWith('预算'))) {
      moves.unshift(budgetMove(budgetCny))
    }
  }
  return moves
}

function citationsFor(items: ProductCandidate[]) {
  return items.map((item) => ({
    snapshot_id: item.snapshot_id,
    title: item.title,
    estimated_cny: itemCny(item),
    market: item.market,
  }))
}

function whyText(item: ProductCandidate, constraints: MissionConstraints, belief: PreferenceBelief): string {
  const parts = [`推荐 ${item.title}，依据是已记录的价格与市场，不是评分或商户声明的品牌。`]
  const cny = itemCny(item)
  if (item.decision_reasons.includes('lowest_estimated_cny') && cny != null) {
    parts.push(`在当前已换算候选里，它的人民币估算最低，约 ${Math.round(cny)} 元。`)
  } else if (cny != null) {
    parts.push(`已记录约 ${Math.round(cny)} 元。`)
  }
  if (item.decision_reasons.includes('within_budget') && constraints.budget_cny != null) {
    parts.push(`这个估算落在 ${constraints.budget_cny} 元预算内。`)
  }
  if (item.decision_reasons.includes('matches_noise_cue')) {
    parts.push('标题含降噪相关描述，已按你的降噪偏好加权。')
  }
  if (item.brand && item.derived_fields.includes('brand')) {
    parts.push(`标题解析品牌为 ${item.brand}，不是商户声明。`)
  }
  if (belief.rejected_snapshot_ids.length) parts.push('已排除你否定过的候选。')
  if (belief.price_sensitivity === 'too_expensive' || belief.price_sensitivity === 'want_cheaper') {
    parts.push('已记下「更便宜」的态度，但没有改硬预算。')
  }
  parts.push('保修和库存未提供，因此不是推荐理由。')
  return parts.join('')
}

function stanceReply(stance: string): string {
  if (stance === 'too_expensive') {
    return '已记下「太贵了」，会提高价格权重重排，但没有改硬预算。可以说具体上限，例如「预算 2000 元」。'
  }
  if (stance === 'want_cheaper') {
    return '已记下「再便宜一点」，会按价格敏感重排。需要硬上限时请说「预算 1500 元」。'
  }
  if (stance === 'want_lighter') {
    return '快照没有重量字段，我不能按「更轻」排序或过滤，也不会编造规格。'
  }
  return '我记下了这个态度，但还不能据此改检索。'
}

function summarizeChange(before: MissionConstraints, after: MissionConstraints): string | null {
  const parts: string[] = []
  if (before.query !== after.query) parts.push(`商品：${after.query || '未指定'}`)
  if (before.budget_cny !== after.budget_cny) {
    parts.push(after.budget_cny != null ? `预算 ${after.budget_cny} 元` : '清除预算')
  }
  if (before.preference !== after.preference) parts.push(`排序：${after.preference}`)
  if (before.excluded_terms.join('|') !== after.excluded_terms.join('|')) {
    parts.push(after.excluded_terms.length ? `排除：${after.excluded_terms.join('、')}` : '清除排除')
  }
  return parts.length ? `已更新：${parts.join('、')}` : null
}

function push(
  store: Store,
  missionId: string,
  kind: ThreadMessage['kind'],
  text: string,
  version: number,
  extra: Partial<ThreadMessage> = {},
) {
  const messages = store.threads[missionId] ?? []
  messages.push({
    sequence: messages.length + 1,
    kind,
    text,
    constraints_version: version,
    snapshot_ids: extra.snapshot_ids ?? extra.citations?.map((item) => item.snapshot_id) ?? [],
    citations: extra.citations,
    next_moves: extra.next_moves,
    change: extra.change,
    change_kind: extra.change_kind,
    created_at: nowIso(),
  })
  store.threads[missionId] = messages
}

function snapshotOf(store: Store, mission: MissionView): Snapshot {
  return {
    constraints: { ...mission.constraints, excluded_terms: [...mission.constraints.excluded_terms] },
    belief: cloneBelief(mission.belief),
    dialogue: { ...(mission.dialogue ?? {}) },
    candidates: store.candidates[mission.id] ?? { ranked: [], fx_snapshot_ids: [] },
    recommendation: store.recommendations[mission.id] ?? null,
  }
}

function remember(store: Store, mission: MissionView) {
  const history = store.history[mission.id] ?? []
  history.push(snapshotOf(store, mission))
  store.history[mission.id] = history
}

function applyRanked(store: Store, missionId: string, ranked: ProductCandidate[], rejectedIds: string[]) {
  store.candidates[missionId] = { ranked, fx_snapshot_ids: [] }
  const rejected = new Set(rejectedIds)
  const primary = ranked.find((item) => !rejected.has(item.snapshot_id)) ?? ranked[0] ?? null
  if (primary) {
    store.recommendations[missionId] = {
      run_id: crypto.randomUUID(),
      status: 'completed',
      primary,
      alternatives: ranked.slice(1, 3),
      rationale: ['当前可检索结果按价格、预算与态度重排'],
      tradeoffs: ['库存/规格信息未提供，需要到商户页确认'],
      cited_evidence_ids: ranked.slice(0, 3).map((item) => item.snapshot_id),
    }
  }
  return primary
}

function applyRun(
  store: Store,
  mission: MissionView,
  text: string,
  focusSnapshotId?: string | null,
): MissionView {
  const act = classify(text)
  const patch = parseConstraints(text)
  let belief = cloneBelief(mission.belief)
  let dialogue: DialogueState = {
    ...(mission.dialogue ?? {}),
    focus_snapshot_id: focusSnapshotId ?? mission.dialogue?.focus_snapshot_id ?? null,
    last_act: act.kind,
    mentioned_snapshot_ids: mission.dialogue?.mentioned_snapshot_ids ?? [],
  }
  const previous = mission.constraints
  const excluded = [...previous.excluded_terms]
  for (const term of patch.excluded_terms ?? []) {
    if (term && !excluded.includes(term)) excluded.push(term)
  }
  const hardBudgetChanged = patch.budget_cny != null
  const constraints: MissionConstraints = {
    ...previous,
    query: patch.query || previous.query,
    budget_cny: hardBudgetChanged ? patch.budget_cny! : previous.budget_cny,
    preference: patch.preference ?? previous.preference,
    only_in_stock: patch.only_in_stock || previous.only_in_stock,
    excluded_terms: excluded,
  }

  if (act.kind === 'stance' && (act.stance === 'too_expensive' || act.stance === 'want_cheaper')) {
    belief = markPriceStance(belief, act.stance)
  }
  if (act.kind === 'stance' && act.stance === 'want_lighter') {
    belief = markUnsupported(belief, 'weight')
  }
  if (act.kind === 'reject') {
    const rankedNow = store.candidates[mission.id]?.ranked ?? []
    let target = dialogue.focus_snapshot_id || rankedNow[0]?.snapshot_id || null
    const term = patch.excluded_terms?.[0]
    if (term) {
      const hit = rankedNow.find((item) => `${item.title} ${item.brand ?? ''}`.toLowerCase().includes(term.toLowerCase()))
      if (hit) target = hit.snapshot_id
    }
    if (target) belief = rejectItem(belief, target)
  }

  const changed =
    JSON.stringify(constraints) !== JSON.stringify(previous) ||
    JSON.stringify(belief) !== JSON.stringify(mission.belief)
  if (changed) remember(store, mission)
  const version = JSON.stringify(constraints) === JSON.stringify(previous)
    ? mission.constraints_version
    : mission.constraints_version + 1

  if (!constraints.query && act.kind !== 'stance') {
    const clarifying: MissionView = {
      ...mission,
      stage: 'clarifying',
      turn_phase: 'idle',
      constraints,
      constraints_version: version,
      dialogue,
      belief,
      updated_at: nowIso(),
    }
    push(store, mission.id, 'clarification', '您想买什么？请提供商品型号或品类。', version)
    return clarifying
  }

  const ranked = rankCatalog(constraints, belief)
  const primary = applyRanked(store, mission.id, ranked, belief.rejected_snapshot_ids)
  const visible = ranked.filter((item) => !belief.rejected_snapshot_ids.includes(item.snapshot_id))
  const lead = visible[0] ?? primary
  const changeSummary = summarizeChange(previous, constraints)
  if (changeSummary) {
    push(store, mission.id, 'change', changeSummary, version, {
      change: { kind: 'constraints', summary: changeSummary },
      change_kind: 'constraints',
    })
  }

  let reply = lead ? `根据当前约束，首选是 ${lead.title}。` : '当前检索没有可用候选。'
  let cited = lead ? [lead] : []
  if (act.kind === 'stance' && act.stance) {
    reply = stanceReply(act.stance)
    cited = lead ? [lead] : []
  } else if (act.kind === 'why' && lead) {
    reply = whyText(lead, constraints, belief)
    cited = [lead]
  } else if (act.kind === 'compare') {
    const pair = visible.slice(0, 2)
    cited = pair
    reply = pair.length >= 2
      ? `对照 ${pair[0].title} 与 ${pair[1].title}。价格按人民币估算，保修和库存未提供，不能作为取舍依据。`
      : '当前还没有两件可对照的候选。'
  } else if (act.kind === 'reject' && lead) {
    reply = `已排除你否定过的候选。当前首选是 ${lead.title}。`
  }

  dialogue = {
    ...dialogue,
    mentioned_snapshot_ids: cited.map((item) => item.snapshot_id),
  }
  const ready: MissionView = {
    ...mission,
    title: constraints.query || mission.title,
    stage: ranked.length ? 'ready' : 'degraded',
    turn_phase: 'idle',
    constraints,
    constraints_version: version,
    candidate_set_id: ranked.length ? `cs-${mission.id}` : mission.candidate_set_id,
    recommendation_run_id: primary ? store.recommendations[mission.id].run_id : null,
    comparison_snapshot_ids: act.kind === 'compare' && cited.length >= 2
      ? cited.map((item) => item.snapshot_id)
      : mission.comparison_snapshot_ids,
    warnings: ranked.length ? [] : ['当前检索没有可用候选'],
    dialogue,
    belief,
    updated_at: nowIso(),
  }
  push(store, mission.id, 'agent', reply, version, {
    citations: citationsFor(cited),
    next_moves: nextMoves(visible, act.kind, belief, constraints.budget_cny),
  })
  return ready
}

function restore(store: Store, mission: MissionView): MissionView {
  const history = store.history[mission.id] ?? []
  const previous = history.pop()
  if (!previous) return mission
  store.candidates[mission.id] = previous.candidates
  if (previous.recommendation) store.recommendations[mission.id] = previous.recommendation
  else delete store.recommendations[mission.id]
  const version = mission.constraints_version + 1
  push(store, mission.id, 'change', '已撤销最近一次约束变更。', version, {
    change: { kind: 'undo', summary: '已撤销最近一次约束变更。' },
    change_kind: 'undo',
  })
  return {
    ...mission,
    constraints: previous.constraints,
    constraints_version: version,
    belief: previous.belief,
    dialogue: { ...previous.dialogue, last_act: 'undo' },
    candidate_set_id: previous.candidates.ranked.length ? `cs-${mission.id}` : mission.candidate_set_id,
    recommendation_run_id: previous.recommendation?.run_id ?? null,
    turn_phase: 'idle',
    stage: previous.candidates.ranked.length ? 'ready' : mission.stage,
    updated_at: nowIso(),
  }
}

export function createFixtureApi(): MissionApi {
  const store: Store = { missions: [], candidates: {}, recommendations: {}, threads: {}, history: {} }

  const find = (id: string) => {
    const mission = store.missions.find((item) => item.id === id)
    if (!mission) throw new Error('任务不存在')
    return mission
  }

  const write = (updated: MissionView) => {
    const index = store.missions.findIndex((item) => item.id === updated.id)
    store.missions[index] = updated
  }

  return {
    async listMissions(limit = 20, offset = 0) {
      const missions = store.missions.slice(offset, offset + limit)
      return { missions, limit, offset }
    },
    async createMission(text, title) {
      const mission = newMission(crypto.randomUUID(), title || text.slice(0, 40) || '新选购')
      store.missions.unshift(mission)
      push(store, mission.id, 'user', text, 1)
      const updated = applyRun(store, mission, text)
      store.missions[0] = updated
      return { mission: updated, run_id: crypto.randomUUID(), constraints_version: updated.constraints_version }
    },
    async getMission(missionId) {
      return { ...find(missionId) }
    },
    async submitTurn(missionId, body) {
      if (body.command === 'undo') return this.undo(missionId, body.constraintsVersion ?? find(missionId).constraints_version)
      if (body.command === 'patch') {
        return this.updateConstraints(missionId, {
          constraints_version: body.constraintsVersion ?? find(missionId).constraints_version,
          preference: body.preference ?? undefined,
          budget_cny: body.budgetCny ?? undefined,
        })
      }
      return this.sendMessage(missionId, body.text || '按当前条件继续', body.focusSnapshotId)
    },
    async sendMessage(missionId, text, focusSnapshotId) {
      const current = find(missionId)
      push(store, missionId, 'user', text, current.constraints_version)
      const updated = applyRun(store, current, text, focusSnapshotId)
      write(updated)
      return { run_id: crypto.randomUUID(), constraints_version: updated.constraints_version }
    },
    async updateConstraints(missionId, patch: ConstraintsPatch) {
      const current = find(missionId)
      remember(store, current)
      const constraints: MissionConstraints = {
        ...current.constraints,
        query: patch.query ?? current.constraints.query,
        budget_cny: patch.budget_cny ?? current.constraints.budget_cny,
        markets: patch.markets ?? current.constraints.markets,
        preference: patch.preference ?? current.constraints.preference,
        only_in_stock: patch.only_in_stock ?? current.constraints.only_in_stock,
      }
      const updated = applyRun(store, { ...current, constraints }, current.constraints.query || '')
      write(updated)
      return { run_id: crypto.randomUUID(), constraints_version: updated.constraints_version }
    },
    async undo(missionId, constraintsVersion) {
      const current = find(missionId)
      if (current.constraints_version !== constraintsVersion) throw new Error('version conflict')
      const updated = restore(store, current)
      write(updated)
      return { run_id: crypto.randomUUID(), constraints_version: updated.constraints_version }
    },
    async setComparison(missionId, constraintsVersion, snapshotIds) {
      const current = find(missionId)
      const updated = { ...current, comparison_snapshot_ids: snapshotIds, constraints_version: constraintsVersion, updated_at: nowIso() }
      write(updated)
      return updated
    },
    async getCandidates(missionId) {
      return store.candidates[missionId] ?? { ranked: [], fx_snapshot_ids: [] }
    },
    async getRecommendation(missionId) {
      return store.recommendations[missionId] ?? null
    },
    async getSnapshot(snapshotId) {
      const found = CATALOG.find((item) => item.snapshot_id === snapshotId)
      if (!found) throw new Error('快照不存在')
      return found
    },
    async getThread(missionId) {
      return { messages: store.threads[missionId] ?? [] }
    },
    async subscribeEvents(_missionId, _onEvent, signal) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve()
          return
        }
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    },
  }
}
