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

export type MissionApi = {
  listMissions(limit?: number, offset?: number): Promise<MissionListResponse>
  createMission(text: string, title?: string): Promise<CreateMissionResponse>
  getMission(missionId: string): Promise<MissionView>
  sendMessage(missionId: string, text: string, focusSnapshotId?: string | null): Promise<RunAccepted>
  submitTurn(
    missionId: string,
    body: {
      command?: 'message' | 'undo'
      text?: string | null
      focusSnapshotId?: string | null
      constraintsVersion?: number
    },
  ): Promise<RunAccepted>
  updateConstraints(missionId: string, patch: ConstraintsPatch): Promise<RunAccepted>
  undo(missionId: string, constraintsVersion: number): Promise<RunAccepted>
  setComparison(missionId: string, constraintsVersion: number, snapshotIds: string[]): Promise<MissionView>
  getCandidates(missionId: string): Promise<CandidateSetView>
  getRecommendation(missionId: string): Promise<RecommendationView | null>
  getSnapshot(snapshotId: string): Promise<ProductCandidate>
  getThread(missionId: string): Promise<ThreadView>
  cancelRun(missionId: string, runId: string): Promise<RunAccepted>
  subscribeEvents(
    missionId: string,
    onEvent: (eventType: string, payload: Record<string, unknown>) => void,
    signal: AbortSignal,
  ): Promise<void>
  subscribeRunText(
    missionId: string,
    runId: string,
    onEvent: (eventType: string, payload: Record<string, unknown>) => void,
    signal: AbortSignal,
  ): Promise<void>
}
