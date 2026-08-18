export const queryKeys = {
  missions: ['missions'] as const,
  missionList: (limit: number, offset: number) => ['missions', 'list', limit, offset] as const,
  mission: (id: string) => ['missions', id] as const,
  candidates: (id: string) => ['missions', id, 'candidates'] as const,
  recommendation: (id: string) => ['missions', id, 'recommendation'] as const,
  thread: (id: string) => ['missions', id, 'thread'] as const,
  snapshot: (id: string) => ['snapshots', id] as const,
}
