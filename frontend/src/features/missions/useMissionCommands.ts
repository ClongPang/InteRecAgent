import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMissionApi } from '../../app/MissionApiContext'
import { queryKeys } from '../../lib/queryKeys'
import type { ConstraintsPatch, Preference } from '../../api/types'
import { ApiError } from '../../api/errors'

export function useMissionQueries(missionId: string | undefined) {
  const api = useMissionApi()
  const enabled = Boolean(missionId)
  const mission = useQuery({
    queryKey: missionId ? queryKeys.mission(missionId) : ['missions', 'none'],
    queryFn: () => api.getMission(missionId!),
    enabled,
  })
  const candidates = useQuery({
    queryKey: missionId ? queryKeys.candidates(missionId) : ['candidates', 'none'],
    queryFn: () => api.getCandidates(missionId!),
    enabled,
  })
  const recommendation = useQuery({
    queryKey: missionId ? queryKeys.recommendation(missionId) : ['recommendation', 'none'],
    queryFn: () => api.getRecommendation(missionId!),
    enabled,
  })
  const thread = useQuery({
    queryKey: missionId ? queryKeys.thread(missionId) : ['thread', 'none'],
    queryFn: () => api.getThread(missionId!),
    enabled,
  })
  return { mission, candidates, recommendation, thread }
}

export function useMissionCommands(missionId: string | undefined) {
  const api = useMissionApi()
  const queryClient = useQueryClient()

  const invalidate = async () => {
    if (!missionId) return
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.mission(missionId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.candidates(missionId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.recommendation(missionId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.thread(missionId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.missions }),
    ])
  }

  const create = useMutation({
    mutationFn: (text: string) => api.createMission(text),
  })

  const sendMessage = useMutation({
    mutationFn: ({ text, focusSnapshotId }: { text: string; focusSnapshotId?: string | null }) => {
      if (!missionId) throw new Error('没有进行中的选购')
      return api.submitTurn(missionId, { command: 'message', text, focusSnapshotId })
    },
    onSuccess: invalidate,
  })

  const patchConstraints = useMutation({
    mutationFn: async (patch: Omit<ConstraintsPatch, 'constraints_version'>) => {
      if (!missionId) throw new Error('没有进行中的选购')
      const current = await api.getMission(missionId)
      try {
        return await api.updateConstraints(missionId, {
          ...patch,
          constraints_version: current.constraints_version,
        })
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          const latest = await api.getMission(missionId)
          return api.updateConstraints(missionId, {
            ...patch,
            constraints_version: latest.constraints_version,
          })
        }
        throw error
      }
    },
    onSuccess: invalidate,
  })

  const undo = useMutation({
    mutationFn: async () => {
      if (!missionId) throw new Error('没有进行中的选购')
      const current = await api.getMission(missionId)
      return api.submitTurn(missionId, { command: 'undo', constraintsVersion: current.constraints_version })
    },
    onSuccess: invalidate,
  })

  const setComparison = useMutation({
    mutationFn: async (snapshotIds: string[]) => {
      if (!missionId) throw new Error('没有进行中的选购')
      const current = await api.getMission(missionId)
      return api.setComparison(missionId, current.constraints_version, snapshotIds)
    },
    onSuccess: invalidate,
  })

  const setPreference = (preference: Preference) => patchConstraints.mutate({ preference })
  const setOnlyInStock = (only_in_stock: boolean) => patchConstraints.mutate({ only_in_stock })

  return { create, sendMessage, patchConstraints, undo, setComparison, setPreference, setOnlyInStock, invalidate }
}
