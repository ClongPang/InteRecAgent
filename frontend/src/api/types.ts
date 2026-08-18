export type Preference = 'balanced' | 'noise' | 'battery' | 'lowest'
export type MissionStage =
  | 'collecting'
  | 'clarifying'
  | 'searching'
  | 'ranking'
  | 'ready'
  | 'degraded'
  | 'failed'

export type TurnPhase = 'idle' | 'responding' | 'refiltering' | 'researching'

export function isBusyPhase(phase: TurnPhase | undefined): boolean {
  return phase === 'researching' || phase === 'refiltering'
}

export type MissionConstraints = {
  query: string | null
  budget_cny: number | null
  markets: string[]
  preference: Preference
  only_in_stock: boolean
  excluded_terms: string[]
}

export type MissionView = {
  id: string
  title: string
  stage: MissionStage
  constraints_version: number
  constraints: MissionConstraints
  active_run_id: string | null
  candidate_set_id: string | null
  comparison_snapshot_ids: string[]
  recommendation_run_id: string | null
  warnings: string[]
  turn_phase: TurnPhase
  dialogue?: { focus_snapshot_id?: string | null; last_act?: string | null; stance?: string | null }
  created_at: string
  updated_at: string
}

export type NativePrice = { amount: number; currency: string }

export type EstimatedCny = {
  amount: number
  rate: number
  source: string
  rate_date: string
  fetched_at: string | null
}

export type ProductCandidate = {
  snapshot_id: string
  source: string
  source_product_id: string
  title: string
  merchant: string | null
  market: string | null
  native_price: NativePrice
  estimated_cny: EstimatedCny | null
  fx_failed: boolean
  brand: null
  rating: null
  review_count: null
  availability: 'in_stock' | 'limited' | 'out_of_stock' | 'unknown'
  specs: string[]
  derived_fields: string[]
  unavailable_fields: string[]
  merchant_url: string | null
  source_updated_at: string | null
  rank: number | null
  decision_reasons: string[]
}

export type CandidateSetView = {
  ranked: ProductCandidate[]
  fx_snapshot_ids: string[]
}

export type RecommendationView = {
  run_id: string
  status: string
  primary: ProductCandidate | null
  alternatives: ProductCandidate[]
  rationale: string[]
  tradeoffs: string[]
  cited_evidence_ids: string[]
}

export type CreateMissionResponse = {
  mission: MissionView
  run_id: string
  constraints_version: number
}

export type MissionListResponse = {
  missions: MissionView[]
  limit: number
  offset: number
}

export type RunAccepted = {
  run_id: string
  constraints_version: number
}

export type ThreadMessage = {
  sequence: number
  kind: 'user' | 'agent' | 'clarification' | 'recommendation' | 'warning' | 'change' | string
  text: string
  constraints_version: number | null
  snapshot_ids: string[]
  run_id?: string | null
  change_kind?: 'constraints' | 'undo' | 'comparison' | string | null
  created_at: string | null
}

export type ThreadView = {
  messages: ThreadMessage[]
}

export type ConstraintsPatch = {
  constraints_version: number
  query?: string | null
  budget_cny?: number | null
  markets?: string[] | null
  preference?: Preference | null
  only_in_stock?: boolean | null
}

export type ApiErrorBody = {
  error: {
    code: string
    category: string
    message: string
    retryable: boolean
    degraded_result_available?: boolean
    trace_id?: string
  }
}
