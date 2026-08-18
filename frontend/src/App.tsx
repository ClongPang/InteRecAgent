import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useMatch } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Header } from './features/shell/Header'
import { CurrencyPicker } from './features/shell/CurrencyPicker'
import { TaskSwitcher } from './features/shell/TaskSwitcher'
import { HomeView } from './views/HomeView'
import { MissionListView } from './views/MissionListView'
import { MissionView } from './views/MissionView'
import { CompareView } from './views/CompareView'
import { useMissionApi } from './app/MissionApiContext'
import { queryKeys } from './lib/queryKeys'
import { loadCurrency, saveCurrency } from './lib/storage'
import type { Currency } from './lib/currency'

function Shell() {
  const [currency, setCurrency] = useState<Currency>(loadCurrency)
  const [currencyOpen, setCurrencyOpen] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const match = useMatch({ path: '/missions/:missionId', end: false })
  const missionId = match?.params.missionId
  const api = useMissionApi()
  const mission = useQuery({
    queryKey: missionId ? queryKeys.mission(missionId) : ['missions', 'shell'],
    queryFn: () => api.getMission(missionId!),
    enabled: Boolean(missionId),
  })
  const title = mission.data?.constraints.query || mission.data?.title
  const overlayOpen = currencyOpen || switcherOpen

  useEffect(() => {
    saveCurrency(currency)
  }, [currency])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (switcherOpen) setSwitcherOpen(false)
      else if (currencyOpen) setCurrencyOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [switcherOpen, currencyOpen])

  useEffect(() => {
    document.body.style.overflow = overlayOpen ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [overlayOpen])

  return (
    <div className="app-shell">
      <Header
        title={title}
        currency={currency}
        onCurrency={() => setCurrencyOpen(true)}
        onSwitch={() => setSwitcherOpen(true)}
      />
      <Routes>
        <Route path="/" element={<HomeView />} />
        <Route path="/missions" element={<MissionListView activeId={missionId} />} />
        <Route path="/missions/:missionId" element={<MissionView currency={currency} />} />
        <Route path="/missions/:missionId/compare" element={<CompareView currency={currency} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {switcherOpen ? <TaskSwitcher activeId={missionId} onClose={() => setSwitcherOpen(false)} /> : null}
      {currencyOpen ? (
        <CurrencyPicker currency={currency} onSelect={setCurrency} onClose={() => setCurrencyOpen(false)} />
      ) : null}
    </div>
  )
}

export default function App() {
  return <Shell />
}
