import { useEffect, useMemo, useState } from 'react'
import { useMissionCommands, useMissionQueries } from './useMissionCommands'
import { useMissionEvents } from './useMissionEvents'
import type { ProductCandidate } from '../../api/types'

export function useMissionWorkspace(missionId: string | undefined) {
  const queries = useMissionQueries(missionId)
  const commands = useMissionCommands(missionId)
  useMissionEvents(missionId)

  const mission = queries.mission.data
  const ranked = queries.candidates.data?.ranked ?? []
  const serverSelected = mission?.comparison_snapshot_ids ?? []
  const [localSelected, setLocalSelected] = useState<string[] | null>(null)

  useEffect(() => {
    setLocalSelected(null)
  }, [missionId])

  const selectedIds = localSelected ?? serverSelected
  const selected = useMemo(
    () => selectedIds.map((id) => ranked.find((item) => item.snapshot_id === id)).filter((item): item is ProductCandidate => Boolean(item)),
    [ranked, selectedIds],
  )

  const toggleSelected = (snapshotId: string) => {
    setLocalSelected((current) => {
      const base = current ?? serverSelected
      if (base.includes(snapshotId)) return base.filter((id) => id !== snapshotId)
      if (base.length >= 4) return base
      return [...base, snapshotId]
    })
  }

  const persistComparison = async (ids = selectedIds) => {
    if (ids.length < 2 || ids.length > 4) return
    await commands.setComparison.mutateAsync(ids)
  }

  const busy =
    commands.sendMessage.isPending ||
    commands.patchConstraints.isPending ||
    commands.undo.isPending ||
    mission?.stage === 'searching' ||
    mission?.stage === 'ranking'

  return {
    queries,
    commands,
    mission,
    ranked,
    selectedIds,
    selected,
    toggleSelected,
    persistComparison,
    busy,
    sendMessage: commands.sendMessage,
    undo: commands.undo,
    patchConstraints: commands.patchConstraints,
    setPreference: commands.setPreference,
    setOnlyInStock: commands.setOnlyInStock,
  }
}
