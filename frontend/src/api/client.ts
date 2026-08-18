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
import { ApiError } from './errors'

async function readSse(
  missionId: string,
  onEvent: (eventType: string, payload: Record<string, unknown>) => void,
  signal: AbortSignal,
): Promise<void> {
  let after = 0
  while (!signal.aborted) {
    const response = await fetch(`${apiBaseUrl()}/missions/${missionId}/events?after=${after}`, {
      headers: { ...authHeaders(), Accept: 'text/event-stream' },
      signal,
    })
    if (!response.ok || !response.body) {
      throw new Error(`SSE 连接失败（${response.status}）`)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let eventType = 'message'
    let data = ''
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
          eventType = 'message'
          data = ''
        }
      }
    }
  }
}

export const httpMissionApi: MissionApi = {
  listMissions: (limit = 20, offset = 0) =>
    request<MissionListResponse>(`/missions?limit=${limit}&offset=${offset}`),
  createMission: (text, title) =>
    request<CreateMissionResponse>('/missions', {
      method: 'POST',
      body: JSON.stringify({ text, title: title || undefined }),
    }),
  getMission: (missionId) => request<MissionView>(`/missions/${missionId}`),
  sendMessage: (missionId, text, focusSnapshotId) =>
    request<RunAccepted>(`/missions/${missionId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text, focus_snapshot_id: focusSnapshotId || undefined }),
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
  setComparison: (missionId, constraintsVersion, snapshotIds) =>
    request<MissionView>(`/missions/${missionId}/comparison`, {
      method: 'PUT',
      body: JSON.stringify({ constraints_version: constraintsVersion, snapshot_ids: snapshotIds }),
    }),
  getCandidates: (missionId) => request<CandidateSetView>(`/missions/${missionId}/candidates`),
  getRecommendation: async (missionId) => {
    try {
      return await request<RecommendationView>(`/missions/${missionId}/recommendation`)
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null
      throw error
    }
  },
  getSnapshot: (snapshotId) => request<ProductCandidate>(`/product-snapshots/${snapshotId}`),
  getThread: (missionId) => request<ThreadView>(`/missions/${missionId}/thread`),
  subscribeEvents: readSse,
}
