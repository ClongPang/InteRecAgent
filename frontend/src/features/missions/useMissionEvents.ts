import { useEffect, useRef } from 'react'
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
  'run.cancelled',
  'message.received',
  'constraints.updated',
  'constraints.undo',
])

export function progressLabel(eventType: string, payload: Record<string, unknown>): string | null {
  if (eventType === 'search.started') {
    const markets = Array.isArray(payload.markets) ? payload.markets.filter(Boolean).join('、') : ''
    return markets ? `正在检索 ${markets}` : '正在检索商品'
  }
  if (eventType === 'products.received') {
    const count = Number(payload.count ?? 0)
    if (count <= 0) return '补充检索没有新结果'
    return `已收到 ${count} 件候选`
  }
  if (eventType === 'fx.received') return '正在换算人民币'
  if (eventType === 'candidates.ranked') return '正在排序比较'
  return null
}

export function useMissionEvents(
  missionId: string | undefined,
  turnPhase?: TurnPhase,
  onEvent?: (eventType: string, payload: Record<string, unknown>) => void,
) {
  const api = useMissionApi()
  const queryClient = useQueryClient()
  const shouldPoll = isBusyPhase(turnPhase)
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    if (!missionId) return
    const controller = new AbortController()
    let timer: number | undefined
    const refresh = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.mission(missionId) })
        void queryClient.invalidateQueries({ queryKey: queryKeys.candidates(missionId) })
        void queryClient.invalidateQueries({ queryKey: queryKeys.recommendation(missionId) })
        void queryClient.invalidateQueries({ queryKey: queryKeys.thread(missionId) })
        void queryClient.invalidateQueries({ queryKey: queryKeys.missions })
      }, 80)
    }
    void api.subscribeEvents(
      missionId,
      (eventType, payload) => {
        onEventRef.current?.(eventType, payload)
        if (INVALIDATE_EVENTS.has(eventType)) refresh()
      },
      controller.signal,
    ).catch(() => {
      /* 连接中断后由 abort 结束；忙时轮询兜底 */
    })
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [api, missionId, queryClient])

  useEffect(() => {
    if (!missionId || !shouldPoll) return
    const poll = window.setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.mission(missionId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.candidates(missionId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.recommendation(missionId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.thread(missionId) })
    }, 4_000)
    return () => window.clearInterval(poll)
  }, [missionId, queryClient, shouldPoll])
}
