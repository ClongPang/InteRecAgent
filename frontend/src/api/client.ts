import { apiBaseUrl, authHeaders, request } from './http'
import type { MissionApi } from './missionApi'
import type {
  CandidateSetView,
  ConstraintsPatch,
  CreateMissionResponse,
  MissionListResponse,
  MissionView,
  ProductCandidate,
  RecommendationView,
  RunAccepted,
  ThreadView,
} from './types'
import { beliefOf } from './types'
import { ApiError } from './errors'

function withBelief(mission: MissionView): MissionView {
  return { ...mission, belief: beliefOf(mission) }
}

function withCandidate(item: ProductCandidate): ProductCandidate {
  return {
    ...item,
    brand: item.brand ?? null,
    decision_reasons: item.decision_reasons ?? [],
    derived_fields: item.derived_fields ?? [],
    unavailable_fields: item.unavailable_fields ?? [],
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

async function readSseLoop(
  urlFor: (after: number) => string,
  onEvent: (eventType: string, payload: Record<string, unknown>) => void,
  signal: AbortSignal,
  options: { once?: boolean } = {},
): Promise<void> {
  const once = options.once === true
  let after = 0
  let delay = 1000
  while (!signal.aborted) {
    try {
      const response = await fetch(urlFor(after), {
        headers: {
          ...authHeaders(),
          Accept: 'text/event-stream',
          ...(after > 0 ? { 'Last-Event-ID': String(after) } : {}),
        },
        signal,
      })
      if (!response.ok || !response.body) {
        throw new Error(`SSE 连接失败（${response.status}）`)
      }
      delay = 1000
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let eventType = 'message'
      let data = ''
      let finished = false
      while (!signal.aborted) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const chunks = buffer.split('\n')
        buffer = chunks.pop() ?? ''
        for (const line of chunks) {
          if (line.startsWith('id:')) {
            const seq = Number(line.slice(3).trim())
            if (Number.isFinite(seq)) after = seq
          } else if (line.startsWith('event:')) {
            eventType = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            data += line.slice(5).trim()
          } else if (line.trim() === '') {
            if (data) {
              try {
                onEvent(eventType, JSON.parse(data) as Record<string, unknown>)
              } catch {
                /* heartbeat or non-json */
              }
            }
            if (
              eventType === 'agent.message.completed' ||
              eventType === 'agent.message.aborted'
            ) {
              finished = true
            }
            eventType = 'message'
            data = ''
          }
        }
      }
      if (once || finished) return
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof DOMException && error.name === 'AbortError') return
      try {
        await sleep(delay, signal)
      } catch {
        return
      }
      delay = Math.min(delay * 2, 8000)
    }
  }
}

function readSse(
  missionId: string,
  onEvent: (eventType: string, payload: Record<string, unknown>) => void,
  signal: AbortSignal,
): Promise<void> {
  return readSseLoop(
    (after) => `${apiBaseUrl()}/missions/${missionId}/events?after=${after}`,
    onEvent,
    signal,
  )
}

export const httpMissionApi: MissionApi = {
  listMissions: async (limit = 20, offset = 0) => {
    const result = await request<MissionListResponse>(`/missions?limit=${limit}&offset=${offset}`)
    return { ...result, missions: result.missions.map(withBelief) }
  },
  createMission: async (text, title) => {
    const result = await request<CreateMissionResponse>('/missions', {
      method: 'POST',
      body: JSON.stringify({ text, title: title || undefined }),
    })
    return { ...result, mission: withBelief(result.mission) }
  },
  getMission: async (missionId) => withBelief(await request<MissionView>(`/missions/${missionId}`)),
  sendMessage: (missionId, text, focusSnapshotId) =>
    request<RunAccepted>(`/missions/${missionId}/turns`, {
      method: 'POST',
      body: JSON.stringify({ command: 'message', text, focus_snapshot_id: focusSnapshotId || undefined }),
    }),
  submitTurn: (missionId, body) =>
    request<RunAccepted>(`/missions/${missionId}/turns`, {
      method: 'POST',
      body: JSON.stringify({
        command: body.command ?? 'message',
        text: body.text || undefined,
        focus_snapshot_id: body.focusSnapshotId || undefined,
        constraints_version: body.constraintsVersion,
        preference: body.preference || undefined,
        budget_cny: body.budgetCny,
      }),
    }),
  updateConstraints: (missionId, patch: ConstraintsPatch) =>
    request<RunAccepted>(`/missions/${missionId}/constraints`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  undo: (missionId, constraintsVersion) =>
    request<RunAccepted>(`/missions/${missionId}/undo`, {
      method: 'POST',
      body: JSON.stringify({ constraints_version: constraintsVersion }),
    }),
  setComparison: async (missionId, constraintsVersion, snapshotIds) =>
    withBelief(
      await request<MissionView>(`/missions/${missionId}/comparison`, {
        method: 'PUT',
        body: JSON.stringify({ constraints_version: constraintsVersion, snapshot_ids: snapshotIds }),
      }),
    ),
  getCandidates: async (missionId) => {
    const result = await request<CandidateSetView>(`/missions/${missionId}/candidates`)
    return { ...result, ranked: result.ranked.map(withCandidate) }
  },
  getRecommendation: async (missionId) => {
    try {
      const rec = await request<RecommendationView>(`/missions/${missionId}/recommendation`)
      return {
        ...rec,
        primary: rec.primary ? withCandidate(rec.primary) : null,
        alternatives: rec.alternatives.map(withCandidate),
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null
      throw error
    }
  },
  getSnapshot: async (snapshotId) => withCandidate(await request<ProductCandidate>(`/product-snapshots/${snapshotId}`)),
  getThread: (missionId) => request<ThreadView>(`/missions/${missionId}/thread`),
  cancelRun: (missionId, runId) =>
    request<RunAccepted>(`/missions/${missionId}/runs/${runId}/cancel`, { method: 'POST' }),
  subscribeEvents: readSse,
  subscribeRunText: (missionId, runId, onEvent, signal) =>
    readSseLoop(
      (after) => `${apiBaseUrl()}/missions/${missionId}/runs/${runId}/text?after=${after}`,
      onEvent,
      signal,
      { once: true },
    ),
}
