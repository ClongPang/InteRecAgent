import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useMissionApi } from '../../app/MissionApiContext'
import { isBusyPhase, type TurnPhase } from '../../api/types'
import { queryKeys } from '../../lib/queryKeys'

const INVALIDATE_EVENTS = new Set([
  'run.accepted',
  'clarification.required',
  'candidates.ranked',
  'recommendation.ready',
  'agent.message',
  'run.degraded',
  'run.failed',
  'run.superseded',
  'message.received',
  'constraints.updated',
  'constraints.undo',
])

export function useMissionEvents(missionId: string | undefined, turnPhase?: TurnPhase) {
  const api = useMissionApi()
  const queryClient = useQueryClient()
  const shouldPoll = isBusyPhase(turnPhase)

  useEffect(() => {
    if (!missionId) return
    const controller = new AbortController()
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.mission(missionId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.candidates(missionId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.recommendation(missionId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.thread(missionId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.missions })
    }
    void api.subscribeEvents(
      missionId,
      (eventType) => {
        if (INVALIDATE_EVENTS.has(eventType)) refresh()
      },
      controller.signal,
    ).catch(() => {
      /* 连接中断后由 abort 结束；忙时轮询兜底 */
    })
    const poll = shouldPoll ? window.setInterval(refresh, 4_000) : undefined
    return () => {
      controller.abort()
      if (poll) window.clearInterval(poll)
    }
  }, [api, missionId, queryClient, shouldPoll])
}
