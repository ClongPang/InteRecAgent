import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Button } from '../components/ui/Button'
import { Icon } from '../components/ui/Icon'
import { useMissionApi } from '../app/MissionApiContext'
import { queryKeys } from '../lib/queryKeys'
import { budgetText, preferenceText, stageText, timeLabel } from '../lib/format'
import type { MissionView } from '../api/types'

function TaskRow({ mission, isCurrent, open }: { mission: MissionView; isCurrent: boolean; open: () => void }) {
  return (
    <div className={`task-list-entry ${isCurrent ? 'is-current' : ''}`}>
      <button className="task-list-item" onClick={open}>
        <div>
          <strong>{mission.constraints.query || mission.title}</strong>
          <p>
            {budgetText(mission.constraints.budget_cny)} · {preferenceText(mission.constraints.preference)}
          </p>
        </div>
        <div className="task-list-meta">
          <span>{isCurrent ? '当前处理' : stageText(mission.stage, mission.turn_phase)}</span>
          <small>{timeLabel(mission.updated_at)} 更新</small>
        </div>
        <Icon name="arrow" size={16} />
      </button>
    </div>
  )
}

export function MissionListView({ activeId }: { activeId?: string }) {
  const api = useMissionApi()
  const navigate = useNavigate()
  const list = useQuery({
    queryKey: queryKeys.missionList(50, 0),
    queryFn: () => api.listMissions(50, 0),
  })
  const missions = list.data?.missions ?? []
  return (
    <main className="task-list-view">
      <div className="task-list-header">
        <div>
          <h1>我的选购</h1>
          <p>每笔选购保留自己的对话、条件、备选与比较进度。</p>
        </div>
        <Button variant="primary" onClick={() => navigate('/')} icon="plus">新建选购</Button>
      </div>
      {list.isError ? (
        <section className="task-list-empty">
          <Icon name="info" size={24} />
          <h2>无法读取选购列表</h2>
          <p>请确认后端已启动，并允许匿名任务头。</p>
        </section>
      ) : missions.length ? (
        <section className="task-list" aria-label="已保存的选购">
          {missions.map((mission) => (
            <TaskRow
              key={mission.id}
              mission={mission}
              isCurrent={mission.id === activeId}
              open={() => navigate(`/missions/${mission.id}`)}
            />
          ))}
        </section>
      ) : (
        <section className="task-list-empty">
          <Icon name="spark" size={24} />
          <h2>还没有选购</h2>
          <p>新建一笔选购后，可以随时在这里继续对话和比较。</p>
          <Button variant="primary" onClick={() => navigate('/')}>新建选购</Button>
        </section>
      )}
    </main>
  )
}
