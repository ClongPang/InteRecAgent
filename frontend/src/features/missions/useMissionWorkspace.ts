import { useEffect, useMemo, useState } from 'react'
import { useMissionCommands, useMissionQueries } from './useMissionCommands'
import { useMissionEvents } from './useMissionEvents'
import { isBusyPhase, type ProductCandidate } from '../../api/types'

export function useMissionWorkspace(missionId: string | undefined) {
  const queries = useMissionQueries(missionId)
  const commands = useMissionCommands(missionId)
  useMissionEvents(missionId, queries.mission.data?.turn_phase)

  const mission = queries.mission.data
  const ranked = queries.candidates.data?.ranked ?? []
  const compareIds = mission?.comparison_snapshot_ids ?? []
  const [focusSnapshotId, setFocusSnapshotId] = useState<string | null>(null)
  const [draftCompare, setDraftCompare] = useState<string[]>([])
  const [pendingText, setPendingText] = useState<string | null>(null)

  useEffect(() => {
    setDraftCompare(compareIds)
    setPendingText(null)
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
  }, [pendingText, threadMessages])

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
    commands.sendMessage.mutate(
      { text, focusSnapshotId: focus },
      { onError: () => setPendingText(null) },
    )
  }

  const busy =
    commands.sendMessage.isPending ||
    commands.undo.isPending ||
    commands.setComparison.isPending ||
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
    busy,
    send,
    toggleCompare,
    persistComparison,
    undo: commands.undo,
  }
}
