import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMissionCommands, useMissionQueries } from './useMissionCommands'
import { progressLabel, useMissionEvents } from './useMissionEvents'
import { useMissionApi } from '../../app/MissionApiContext'
import { isBusyPhase, type ProductCandidate } from '../../api/types'

export function useMissionWorkspace(missionId: string | undefined) {
  const api = useMissionApi()
  const queries = useMissionQueries(missionId)
  const commands = useMissionCommands(missionId)
  const [progress, setProgress] = useState<string | null>(null)
  const [draftAgent, setDraftAgent] = useState<string | null>(null)
  const [activeRunId, setActiveRunId] = useState<string | null>(null)

  const onEvent = useCallback((eventType: string, payload: Record<string, unknown>) => {
    const label = progressLabel(eventType, payload)
    if (label) {
      if (eventType === 'products.received' && Number(payload.count ?? 0) <= 0) {
        setProgress((current) => (current?.startsWith('已收到') ? current : label))
      } else {
        setProgress(label)
      }
    }
    if (
      eventType === 'recommendation.ready' ||
      eventType === 'agent.message' ||
      eventType === 'clarification.required' ||
      eventType === 'run.degraded'
    ) {
      setProgress(null)
    }
    if (eventType === 'run.cancelled' || eventType === 'run.failed') {
      setProgress(null)
      setDraftAgent(null)
    }
  }, [])

  useMissionEvents(missionId, queries.mission.data?.turn_phase, onEvent)

  const mission = queries.mission.data
  const ranked = queries.candidates.data?.ranked ?? []
  const compareIds = mission?.comparison_snapshot_ids ?? []
  const [focusSnapshotId, setFocusSnapshotId] = useState<string | null>(null)
  const [draftCompare, setDraftCompare] = useState<string[]>([])
  const [pendingText, setPendingText] = useState<string | null>(null)

  useEffect(() => {
    setDraftCompare(compareIds)
    setPendingText(null)
    setProgress(null)
    setDraftAgent(null)
    setActiveRunId(null)
  }, [missionId])

  useEffect(() => {
    setDraftCompare(compareIds)
  }, [compareIds.join('|')])

  useEffect(() => {
    const fromServer = mission?.dialogue?.focus_snapshot_id
    if (fromServer) setFocusSnapshotId(fromServer)
  }, [mission?.dialogue?.focus_snapshot_id])

  const threadMessages = queries.thread.data?.messages ?? []
  useEffect(() => {
    if (pendingText && threadMessages.some((item) => item.kind === 'user' && item.text === pendingText)) {
      setPendingText(null)
    }
    if (
      draftAgent &&
      threadMessages.some((item) => (item.kind === 'agent' || item.kind === 'clarification') && item.text === draftAgent)
    ) {
      setDraftAgent(null)
    }
  }, [pendingText, draftAgent, threadMessages])

  useEffect(() => {
    const runId = activeRunId || (isBusyPhase(mission?.turn_phase) ? mission?.active_run_id : null)
    if (!missionId || !runId) return
    const controller = new AbortController()
    void api.subscribeRunText(
      missionId,
      runId,
      (eventType, payload) => {
        if (eventType === 'agent.message.delta' && typeof payload.delta === 'string') {
          setDraftAgent((current) => (current ?? '') + payload.delta)
        }
        if (eventType === 'agent.message.completed' && typeof payload.text === 'string') {
          setDraftAgent(payload.text)
        }
        if (eventType === 'agent.message.aborted') {
          setDraftAgent(null)
        }
      },
      controller.signal,
    )
    return () => controller.abort()
  }, [api, missionId, activeRunId, mission?.active_run_id, mission?.turn_phase])

  const selected = useMemo(
    () => compareIds.map((id) => ranked.find((item) => item.snapshot_id === id)).filter((item): item is ProductCandidate => Boolean(item)),
    [ranked, compareIds],
  )
  const focusProduct = ranked.find((item) => item.snapshot_id === focusSnapshotId) ?? null

  const persistComparison = async (ids: string[]) => {
    if (ids.length < 2 || ids.length > 4) return
    await commands.setComparison.mutateAsync(ids)
  }

  const toggleCompare = (snapshotId: string) => {
    setDraftCompare((current) => {
      const next = current.includes(snapshotId) ? current.filter((id) => id !== snapshotId) : [...current, snapshotId].slice(0, 4)
      if (next.length >= 2) void persistComparison(next)
      return next
    })
  }

  const send = (text: string, options?: { focusSnapshotId?: string | null }) => {
    const focus = options?.focusSnapshotId !== undefined ? options.focusSnapshotId : focusSnapshotId
    if (options?.focusSnapshotId !== undefined) setFocusSnapshotId(options.focusSnapshotId)
    setPendingText(text)
    setDraftAgent(null)
    commands.sendMessage.mutate(
      { text, focusSnapshotId: focus },
      {
        onSuccess: (accepted) => setActiveRunId(accepted.run_id),
        onError: () => setPendingText(null),
      },
    )
  }

  const cancel = () => {
    const runId = activeRunId || mission?.active_run_id
    if (!runId) return
    commands.cancelRun.mutate(runId, {
      onSuccess: () => {
        setProgress(null)
        setDraftAgent(null)
        setActiveRunId(null)
      },
    })
  }

  const busy =
    commands.sendMessage.isPending ||
    commands.undo.isPending ||
    commands.setComparison.isPending ||
    commands.cancelRun.isPending ||
    isBusyPhase(mission?.turn_phase)

  return {
    queries,
    commands,
    mission,
    ranked,
    compareIds,
    draftCompare,
    selected,
    focusSnapshotId,
    setFocusSnapshotId,
    focusProduct,
    pendingText,
    progress,
    draftAgent,
    busy,
    send,
    cancel,
    toggleCompare,
    persistComparison,
    undo: commands.undo,
  }
}
