import type { MissionApi } from './missionApi'
import type {
  CandidateSetView,
  ConstraintsPatch,
  MissionConstraints,
  MissionView,
  ProductCandidate,
  RecommendationView,
  ThreadMessage,
} from './types'

type Store = {
  missions: MissionView[]
  candidates: Record<string, CandidateSetView>
  recommendations: Record<string, RecommendationView>
  threads: Record<string, ThreadMessage[]>
}

const CATALOG: ProductCandidate[] = [
  candidate('snap-sony', 'sony-xm5', 'Sony WH-1000XM5 Wireless', 'amazon', 'US', 'USD', 299, 2149, 7.1882),
  candidate('snap-bose', 'bose-qc', 'Bose QuietComfort Ultra', 'lazada', 'SG', 'SGD', 399, 2118, 5.3083),
  candidate('snap-m4', 'senn-m4', 'Sennheiser Momentum 4 Wireless', 'bestbuy', 'US', 'USD', 329.95, 2378, 7.1882),
  candidate('snap-q45', 'q45', 'Soundcore Space Q45', 'amazon', 'US', 'USD', 149.99, 1078, 7.1882),
]

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
    brand: null,
    rating: null,
    review_count: null,
    availability: 'unknown',
    specs: [],
    derived_fields: [],
    unavailable_fields: ['rating', 'review_count', 'brand', 'availability', 'structured_specs'],
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
    markets: ['US'],
    preference: 'balanced',
    only_in_stock: false,
    excluded_terms: [],
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
    created_at: ts,
    updated_at: ts,
  }
}

function parseText(text: string): Partial<MissionConstraints> {
  const budget = text.match(/(\d{3,6})\s*(?:元|块)/)
  const query = text
    .replace(/(?:预算|不超过).*?(?:元|块)?/g, '')
    .replace(/优先\s*(续航|降噪)|只看有货|仅看有货/g, '')
    .trim()
  const preference = /优先\s*续航/.test(text)
    ? 'battery'
    : /优先\s*降噪/.test(text)
      ? 'noise'
      : /低价|价格优先/.test(text)
        ? 'lowest'
        : undefined
  return {
    query: query || undefined,
    budget_cny: budget ? Number(budget[1]) : undefined,
    preference,
    only_in_stock: /只看有货|仅看有货/.test(text),
  }
}

function applyRun(store: Store, mission: MissionView, text: string): MissionView {
  const patch = parseText(text)
  const query = patch.query || mission.constraints.query
  const constraints: MissionConstraints = {
    ...mission.constraints,
    query: query ?? mission.constraints.query,
    budget_cny: patch.budget_cny ?? mission.constraints.budget_cny,
    preference: patch.preference ?? mission.constraints.preference,
    only_in_stock: patch.only_in_stock || mission.constraints.only_in_stock,
  }
  const version =
    JSON.stringify(constraints) === JSON.stringify(mission.constraints)
      ? mission.constraints_version
      : mission.constraints_version + 1
  if (!constraints.query) {
    const clarifying: MissionView = {
      ...mission,
      stage: 'clarifying',
      turn_phase: 'idle',
      constraints,
      constraints_version: version,
      updated_at: nowIso(),
    }
    push(store, mission.id, 'clarification', '您想买什么？请提供商品型号或品类。', version)
    return clarifying
  }
  let ranked = CATALOG.map((item, index) => ({ ...item, rank: index + 1 }))
  if (constraints.budget_cny != null) {
    ranked = ranked.filter((item) => (item.estimated_cny?.amount ?? Infinity) <= constraints.budget_cny!)
  }
  ranked = ranked.map((item, index) => ({ ...item, rank: index + 1 }))
  store.candidates[mission.id] = { ranked, fx_snapshot_ids: [] }
  const primary = ranked[0] ?? null
  if (primary) {
    store.recommendations[mission.id] = {
      run_id: crypto.randomUUID(),
      status: 'completed',
      primary,
      alternatives: ranked.slice(1, 3),
      rationale: ['当前可检索结果中商品价估算较低'],
      tradeoffs: ['库存/规格信息未提供，需要到商户页确认'],
      cited_evidence_ids: ranked.slice(0, 3).map((item) => item.snapshot_id),
    }
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
    warnings: ranked.length ? [] : ['当前检索没有可用候选'],
    updated_at: nowIso(),
  }
  push(store, mission.id, 'agent', primary ? `根据当前约束，首选是 ${primary.title}。` : '当前检索没有可用候选。', version)
  return ready
}

function push(store: Store, missionId: string, kind: ThreadMessage['kind'], text: string, version: number) {
  const messages = store.threads[missionId] ?? []
  messages.push({
    sequence: messages.length + 1,
    kind,
    text,
    constraints_version: version,
    snapshot_ids: [],
    created_at: nowIso(),
  })
  store.threads[missionId] = messages
}

export function createFixtureApi(): MissionApi {
  const store: Store = { missions: [], candidates: {}, recommendations: {}, threads: {} }

  const find = (id: string) => {
    const mission = store.missions.find((item) => item.id === id)
    if (!mission) throw new Error('任务不存在')
    return mission
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
      if (body.command === 'undo') {
        const current = find(missionId)
        return { run_id: crypto.randomUUID(), constraints_version: current.constraints_version }
      }
      return this.sendMessage(missionId, body.text || '按当前条件继续', body.focusSnapshotId)
    },
    async sendMessage(missionId, text, focusSnapshotId) {
      const current = find(missionId)
      push(store, missionId, 'user', text, current.constraints_version)
      const updated = applyRun(store, current, text)
      const index = store.missions.findIndex((item) => item.id === missionId)
      store.missions[index] = updated
      return { run_id: crypto.randomUUID(), constraints_version: updated.constraints_version }
    },
    async updateConstraints(missionId, patch: ConstraintsPatch) {
      const current = find(missionId)
      const constraints: MissionConstraints = {
        ...current.constraints,
        query: patch.query ?? current.constraints.query,
        budget_cny: patch.budget_cny ?? current.constraints.budget_cny,
        markets: patch.markets ?? current.constraints.markets,
        preference: patch.preference ?? current.constraints.preference,
        only_in_stock: patch.only_in_stock ?? current.constraints.only_in_stock,
      }
      const updated = applyRun(store, { ...current, constraints }, current.constraints.query || '')
      const index = store.missions.findIndex((item) => item.id === missionId)
      store.missions[index] = updated
      return { run_id: crypto.randomUUID(), constraints_version: updated.constraints_version }
    },
    async undo(missionId, constraintsVersion) {
      const current = find(missionId)
      if (current.constraints_version !== constraintsVersion) throw new Error('version conflict')
      return { run_id: crypto.randomUUID(), constraints_version: current.constraints_version }
    },
    async setComparison(missionId, constraintsVersion, snapshotIds) {
      const current = find(missionId)
      const updated = { ...current, comparison_snapshot_ids: snapshotIds, constraints_version: constraintsVersion, updated_at: nowIso() }
      const index = store.missions.findIndex((item) => item.id === missionId)
      store.missions[index] = updated
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
