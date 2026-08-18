import { httpMissionApi } from './client'
import { createFixtureApi } from './fixture'
import type { MissionApi } from './missionApi'

let fixtureApi: MissionApi | null = null

export function createMissionApi(): MissionApi {
  const source = (import.meta.env.VITE_DATA_SOURCE || 'api').toLowerCase()
  if (source === 'fixture') {
    fixtureApi ??= createFixtureApi()
    return fixtureApi
  }
  return httpMissionApi
}
