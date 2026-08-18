import { QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { useState, type ReactNode } from 'react'
import { MissionApiProvider } from './MissionApiContext'
import { createQueryClient } from './queryClient'
import { ErrorBoundary } from './ErrorBoundary'

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(createQueryClient)
  return (
    <ErrorBoundary>
      <MissionApiProvider>
        <QueryClientProvider client={client}>
          <BrowserRouter>{children}</BrowserRouter>
        </QueryClientProvider>
      </MissionApiProvider>
    </ErrorBoundary>
  )
}
