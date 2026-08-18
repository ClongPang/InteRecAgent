import { Navigate, useParams } from 'react-router-dom'

export function CompareView() {
  const { missionId = '' } = useParams()
  return <Navigate to={`/missions/${missionId}`} replace />
}
