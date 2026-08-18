import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../../components/ui/Icon'
import { useMissionApi } from '../../app/MissionApiContext'
import { queryKeys } from '../../lib/queryKeys'
import { budgetText, preferenceText } from '../../lib/format'

export function TaskSwitcher({
  activeId,
  onClose,
}: {
  activeId?: string
  onClose: () => void
}) {
  const api = useMissionApi()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const list = useQuery({
    queryKey: queryKeys.missionList(20, 0),
    queryFn: () => api.listMissions(20, 0),
  })
  const items = useMemo(() => {
    const missions = list.data?.missions ?? []
    const needle = query.trim()
    return missions.filter((mission) => {
      const hay = `${mission.title} ${mission.constraints.query ?? ''} ${budgetText(mission.constraints.budget_cny)} ${preferenceText(mission.constraints.preference)}`
      return hay.includes(needle)
    })
  }, [list.data, query])

  return (
    <div className="switcher-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="task-switcher" role="dialog" aria-modal="true" aria-label="切换选购">
        <div className="switcher-heading">
          <div>
            <strong>切换选购</strong>
            <small>将恢复各选购上次的工作现场</small>
          </div>
          <button onClick={onClose} aria-label="关闭选购切换"><Icon name="close" size={16} /></button>
        </div>
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索选购名称、预算或偏好" aria-label="搜索选购" />
        {items.length ? (
          <div className="switcher-list">
            {items.slice(0, 6).map((mission) => (
              <button
                className={mission.id === activeId ? 'is-current' : ''}
                key={mission.id}
                onClick={() => { navigate(`/missions/${mission.id}`); onClose() }}
              >
                <span>
                  <b>{mission.constraints.query || mission.title}</b>
                  <small>
                    {budgetText(mission.constraints.budget_cny)} · {preferenceText(mission.constraints.preference)}
                    {mission.constraints.only_in_stock ? ' · 仅看有货' : ''} · V{mission.constraints_version}
                  </small>
                </span>
                {mission.id === activeId ? <em>当前</em> : null}
              </button>
            ))}
          </div>
        ) : (
          <p className="switcher-empty">未找到匹配的选购</p>
        )}
        <div className="switcher-footer">
          <button onClick={() => { navigate('/missions'); onClose() }}>查看全部选购</button>
          <button onClick={() => { navigate('/'); onClose() }}>新建选购</button>
        </div>
      </section>
    </div>
  )
}
