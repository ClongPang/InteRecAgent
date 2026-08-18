import { createContext, useContext, type ReactNode } from 'react'
import type { MissionApi } from '../api/missionApi'
import { createMissionApi } from '../api/factory'

const api = createMissionApi()
const MissionApiContext = createContext<MissionApi>(api)

export function MissionApiProvider({ children }: { children: ReactNode }) {
  return <MissionApiContext.Provider value={api}>{children}</MissionApiContext.Provider>
}

export function useMissionApi(): MissionApi {
  return useContext(MissionApiContext)
}
