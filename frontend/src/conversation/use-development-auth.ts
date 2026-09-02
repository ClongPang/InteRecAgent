import { useEffect, useState } from 'react'

import { createDevelopmentSession } from './client'

export interface DevelopmentAuthState {
  authenticating: boolean
  error: string | null
}

/** Attempts the opt-in local API issuer only in Vite development builds. */
export function useDevelopmentAuth(
  token: string,
  onAuthenticated: (token: string) => void,
): DevelopmentAuthState {
  const [state, setState] = useState<DevelopmentAuthState>(() => ({
    authenticating: !token && import.meta.env.DEV,
    error: null,
  }))

  useEffect(() => {
    if (token || !import.meta.env.DEV) {
      setState({ authenticating: false, error: null })
      return
    }
    let active = true
    setState({ authenticating: true, error: null })
    createDevelopmentSession()
      .then((session) => {
        if (!active) return
        setState({ authenticating: false, error: null })
        onAuthenticated(session.accessToken)
      })
      .catch(() => {
        if (active) setState({
          authenticating: false,
          error: '本地自动连接不可用，请使用访问令牌。',
        })
      })
    return () => {
      active = false
    }
  }, [onAuthenticated, token])

  return state
}
